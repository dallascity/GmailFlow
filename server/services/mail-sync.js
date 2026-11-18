import { EventEmitter } from 'node:events';
import { parseGmailMessage } from './mail-parse.js';

const INTERVAL_MS = 30000;
const CONCURRENCY = 8;

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Gmail ↔ yerel önbellek senkronizasyonu.
 *  - ilk/tam: son N gün (spam ve çöp dahil) + etiketler + taslak eşlemesi
 *  - artımlı: history.list (30 sn'de bir); historyId geçersizse tam senkronizasyon
 *  - istek üzerine: eski sayfalar (metadata) ve açılan konuşmalar (full)
 */
export class MailSync extends EventEmitter {
  constructor({ api, store, settings, oauth, tracking, log = () => {} }) {
    super();
    this.api = api;
    this.store = store;
    this.settings = settings;
    this.oauth = oauth;
    this.tracking = tracking;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.state = { phase: 'idle', done: 0, total: 0, lastSyncAt: null, error: null, throttledUntil: null, pending: 0 };
    this.reconciled = false; // uygulama her açıldığında bir kez Gmail ↔ önbellek karşılaştırması
    // Gmail kota sınırına takılınca arayüzde "bekleniyor" gösterilir
    if (this.api.bucket) {
      this.api.bucket.onThrottle = ({ until }) => this.#setState({ throttledUntil: new Date(until).toISOString() });
    }
  }

  status() {
    return { ...this.state, ready: this.oauth.status().mailReady, initialized: Boolean(this.store.getState('history_id')) };
  }

  #setState(patch) {
    Object.assign(this.state, patch);
    this.emit('event', { type: 'mail:sync', status: this.status() });
  }

  start() {
    if (this.timer || !this.oauth.status().mailReady) return;
    this.timer = setInterval(() => this.syncNow().catch(() => {}), INTERVAL_MS);
    this.syncNow().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Aynı anda tek senkronizasyon çalışır; çağrı sürmekte olanı bekler. */
  syncNow({ full = false } = {}) {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        if (!this.oauth.status().mailReady) return;
        if (full || !this.store.getState('history_id')) await this.fullSync();
        else await this.incrementalSync();
        this.#setState({ phase: 'idle', error: null, throttledUntil: null, lastSyncAt: new Date().toISOString(), pending: this.#retryIds().length });
      } catch (err) {
        this.#setState({ phase: 'error', error: err?.code ?? err?.reason ?? err?.message ?? String(err) });
        this.log('error', null, 'mail.sync_failed', err?.message ?? String(err));
        throw err;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async fullSync() {
    this.#setState({ phase: 'initial', done: 0, total: 0 });
    const profile = await this.api.getProfile(); // historyId'yi listelemeden ÖNCE al → arada olan değişiklik kaçmaz
    if (profile.emailAddress) this.store.setState('email', profile.emailAddress.toLowerCase());
    await this.refreshLabels();

    const days = Number(this.settings.get('mail_cache_days')) || 30;
    const ids = [];
    let pageToken;
    do {
      const r = await this.api.listMessages({ q: `newer_than:${days}d`, includeSpamTrash: true, pageToken, maxResults: 500 });
      (r.messages ?? []).forEach((m) => ids.push(m.id));
      pageToken = r.nextPageToken;
    } while (pageToken);

    this.#setState({ total: ids.length, done: 0 });
    const failed = [];
    let done = 0;
    await pool(ids, CONCURRENCY, async (id) => {
      // Önbellekte gövdesi olanlar için yalnızca etiketleri tazelemek yeterli (daha ucuz)
      const cached = this.store.message(id);
      if (cached?.body_fetched) {
        const m = await this.api.getMessage(id, 'minimal').catch(() => null);
        if (m) this.#applyLabels(id, m.labelIds ?? []);
      } else {
        await this.fetchMessage(id, 'full').catch((e) => failed.push({ id, error: e }));
      }
      done++;
      if (done % 25 === 0 || done === ids.length) this.#setState({ done });
    });

    await this.refreshDrafts();
    // İndirilemeyenler kaybolmaz: sonraki senkronizasyonlarda yeniden denenir
    this.#deferFailed(failed);
    this.reconciled = true;
    this.store.prune(days);
    this.store.setState('history_id', profile.historyId);
    this.store.setState('last_full_sync', new Date().toISOString());
    this.emit('event', { type: 'mail:changed', full: true });
  }

  async incrementalSync() {
    this.#setState({ phase: 'incremental' });
    if (!this.reconciled) await this.#reconcile();
    await this.#drainRetry();
    const start = this.store.getState('history_id');
    let pageToken;
    let latest = start;
    const added = new Set();
    const touched = new Set();
    try {
      do {
        const r = await this.api.listHistory({ startHistoryId: start, pageToken });
        latest = r.historyId ?? latest;
        for (const h of r.history ?? []) {
          for (const x of h.messagesAdded ?? []) added.add(x.message.id);
          for (const x of h.messagesDeleted ?? []) {
            this.store.deleteMessage(x.message.id);
            added.delete(x.message.id);
            touched.add(x.message.id);
          }
          for (const x of h.labelsAdded ?? []) {
            if (this.store.changeLabels(x.message.id, x.labelIds, [])) touched.add(x.message.id);
          }
          for (const x of h.labelsRemoved ?? []) {
            if (this.store.changeLabels(x.message.id, [], x.labelIds)) touched.add(x.message.id);
          }
        }
        pageToken = r.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err.notFound) {
        // historyId çok eski (≈1 haftadan fazla çevrimdışı) → baştan senkronize et
        this.log('info', null, 'mail.history_expired', '');
        return this.fullSync();
      }
      throw err;
    }

    const newInbox = [];
    await pool([...added], CONCURRENCY, async (id) => {
      const p = await this.fetchMessage(id, 'full').catch((e) => {
        if (!e.notFound) this.#deferFailed([{ id, error: e }]);
        return null;
      });
      if (p?.isNew && p.parsed.labelIds.includes('INBOX') && p.parsed.labelIds.includes('UNREAD')) newInbox.push(p.parsed);
    });

    if (added.size || touched.size) {
      await this.refreshLabels();
      if ([...added, ...touched].some((id) => this.store.labelsOf(id).includes('DRAFT')) || touched.size) await this.refreshDrafts();
      this.emit('event', { type: 'mail:changed', added: [...added], touched: [...touched] });
    }
    for (const p of newInbox.sort((a, b) => a.internalDate - b.internalDate)) {
      this.emit('event', {
        type: 'mail:new',
        message: { id: p.id, threadId: p.threadId, from: p.from, subject: p.subject, snippet: p.snippet },
      });
    }
    if (latest) this.store.setState('history_id', latest);
  }

  // ------------------------------------------------------------ yeniden deneme kuyruğu
  #retryIds() {
    try {
      return JSON.parse(this.store.getState('retry_ids') ?? '[]');
    } catch {
      return [];
    }
  }

  #deferFailed(failed) {
    if (!failed.length) return;
    const ids = [...new Set([...this.#retryIds(), ...failed.map((f) => f.id)])];
    this.store.setState('retry_ids', JSON.stringify(ids));
    const quota = failed.filter((f) => f.error?.kind === 'rate' || f.error?.kind === 'quota').length;
    this.log('warn', null, 'mail.fetch_deferred', `${failed.length}${quota ? ` (${quota} kota)` : ''}: ${failed[0].error?.message ?? ''}`.slice(0, 400));
  }

  /** Daha önce indirilemeyen postaları yeniden dener; başaranlar kuyruktan çıkar. */
  async #drainRetry() {
    const ids = this.#retryIds();
    if (!ids.length) return;
    const left = [];
    await pool(ids, CONCURRENCY, async (id) => {
      try {
        await this.fetchMessage(id, 'full');
      } catch (e) {
        if (!e.notFound) left.push(id); // Gmail'de silinmişse kuyruktan düşer
      }
    });
    this.store.setState('retry_ids', JSON.stringify(left));
    if (ids.length !== left.length) this.emit('event', { type: 'mail:changed' });
  }

  /** Önbellek penceresindeki Gmail postalarıyla yereli karşılaştırır; eksikleri kuyruğa ekler (ucuz: yalnızca kimlik listesi). */
  async #reconcile() {
    this.reconciled = true;
    const days = Number(this.settings.get('mail_cache_days')) || 30;
    const missing = [];
    let pageToken;
    do {
      const r = await this.api.listMessages({ q: `newer_than:${days}d`, includeSpamTrash: true, pageToken, maxResults: 500 });
      for (const m of r.messages ?? []) {
        const row = this.store.message(m.id);
        if (!row?.body_fetched) missing.push(m.id);
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    if (missing.length) {
      this.store.setState('retry_ids', JSON.stringify([...new Set([...this.#retryIds(), ...missing])]));
      this.log('info', null, 'mail.reconciled', String(missing.length));
    }
  }

  /** Mesajı Gmail'den çekip önbelleğe yazar ve takip modülüne verir. */
  async fetchMessage(id, format = 'full', { opened = false } = {}) {
    const msg = await this.api.getMessage(id, format);
    const parsed = parseGmailMessage(msg, { full: format === 'full' });
    const { isNew } = this.store.upsertMessage(parsed, { opened });
    if (format === 'full') this.tracking?.process(id);
    return { parsed, isNew };
  }

  /** Konuşmanın tamamını (full) çeker; okuma ekranı açılırken kullanılır. */
  async fetchThread(threadId) {
    const t = await this.api.getThread(threadId, 'full');
    for (const msg of t.messages ?? []) {
      const parsed = parseGmailMessage(msg, { full: true });
      this.store.upsertMessage(parsed, { opened: true });
      this.tracking?.process(msg.id);
    }
    return t.messages?.length ?? 0;
  }

  /** Önbellekteki en eski mesajdan daha eski bir sayfayı (metadata) Gmail'den getirir. */
  async fetchOlder(label, { pageSize = 50 } = {}) {
    const oldest = this.store.oldestDate(label);
    const q = oldest ? `before:${Math.floor(oldest / 1000)}` : undefined;
    const labelIds = label && !['ALL'].includes(label) ? [label] : undefined;
    const r = await this.api.listMessages({ q, labelIds, maxResults: pageSize, includeSpamTrash: ['SPAM', 'TRASH'].includes(label) });
    const ids = (r.messages ?? []).map((m) => m.id).filter((id) => !this.store.hasMessage(id));
    await pool(ids, CONCURRENCY, (id) => this.fetchMessage(id, 'metadata').catch(() => null));
    return { fetched: ids.length, hasMore: Boolean(r.nextPageToken) || ids.length > 0 };
  }

  /** Tüm Gmail'de arama (önbellekte olmayan sonuçları metadata olarak indirir). */
  async searchRemote(q, { max = 50 } = {}) {
    const r = await this.api.listMessages({ q, maxResults: max });
    const msgs = r.messages ?? [];
    const missing = msgs.map((m) => m.id).filter((id) => !this.store.hasMessage(id));
    await pool(missing, CONCURRENCY, (id) => this.fetchMessage(id, 'metadata').catch(() => null));
    return [...new Set(msgs.map((m) => m.threadId))];
  }

  async refreshLabels() {
    const { labels = [] } = await this.api.listLabels();
    // labels.list sayaç döndürmez; sayaçlar için her etiket tek tek alınır (1 birim)
    const detailed = [];
    await pool(labels, CONCURRENCY, async (l) => {
      const d = await this.api.getLabel(l.id).catch(() => l);
      detailed.push({ ...l, ...d });
    });
    this.store.upsertLabels(detailed);
  }

  async refreshDrafts() {
    const pairs = [];
    let pageToken;
    do {
      const r = await this.api.listDrafts(pageToken);
      (r.drafts ?? []).forEach((d) => pairs.push(d));
      pageToken = r.nextPageToken;
    } while (pageToken);
    this.store.setDrafts(pairs);
  }

  #applyLabels(id, labelIds) {
    const current = this.store.labelsOf(id);
    this.store.changeLabels(
      id,
      labelIds.filter((l) => !current.includes(l)),
      current.filter((l) => !labelIds.includes(l)),
    );
  }
}
