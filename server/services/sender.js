import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { transaction, nowIso } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { sendRawMessage, GmailError } from './gmail.js';
import { buildMessage } from './mime.js';
import { render, valuesForRecipient } from './template.js';
import { canonicalEmail } from './validator.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [5000, 15000, 45000];
const MAX_CONSECUTIVE_FAILURES = 5;
// Bu ağ hatalarında istek Google'a hiç ulaşmamıştır → tekrar denemek güvenlidir.
const SAFE_NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

export function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve(false);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Tek kanallı gönderim kuyruğu. Aynı anda yalnızca bir kampanya çalışır; her alıcıya
 * ayrı bir mesaj gönderilir ve her mesajdan sonra kampanyanın sabit bekleme süresi uygulanır.
 */
export class Sender extends EventEmitter {
  constructor({ db, settings, oauth, send = sendRawMessage, sleep = abortableSleep, now = () => Date.now() }) {
    super();
    this.db = db;
    this.settings = settings;
    this.oauth = oauth;
    this.send = send;
    this.sleep = sleep;
    this.now = now;
    this.active = null; // { campaignId, controller, promise }
  }

  // ---------------------------------------------------------------- yardımcılar
  log(level, campaignId, code, message) {
    const ts = new Date(this.now()).toISOString();
    const info = this.db
      .prepare('INSERT INTO events_log (ts, level, campaign_id, code, message) VALUES (?, ?, ?, ?, ?)')
      .run(ts, level, campaignId ?? null, code ?? null, String(message ?? ''));
    this.emit('event', { type: 'log', entry: { id: Number(info.lastInsertRowid), ts, level, campaign_id: campaignId, code, message } });
  }

  campaign(id) {
    const c = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
    if (!c) throw new AppError('campaign.not_found', 404);
    return c;
  }

  counts(campaignId) {
    const out = { total: 0, pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, unknown: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) n FROM sends WHERE campaign_id = ? GROUP BY status').all(campaignId)) {
      out[r.status] = r.n;
      out.total += r.n;
    }
    return out;
  }

  /** Son 24 saatteki (kayan pencere) gönderim kotası: kampanya gönderimleri + posta ekranından gönderilen alıcılar. */
  quota() {
    const limit = this.settings.effectiveDailyLimit();
    const since = new Date(this.now() - DAY_MS).toISOString();
    const camp = this.db
      .prepare("SELECT COUNT(*) used, MIN(sent_at) oldest FROM sends WHERE status = 'sent' AND sent_at >= ?")
      .get(since);
    const manual = this.db.prepare('SELECT COALESCE(SUM(recipients), 0) used, MIN(ts) oldest FROM manual_sends WHERE ts >= ?').get(since);
    const used = camp.used + manual.used;
    const oldest = [camp.oldest, manual.oldest].filter(Boolean).sort()[0] ?? null;
    const remaining = Math.max(0, limit - used);
    const resetAt = remaining <= 0 && oldest ? new Date(Date.parse(oldest) + DAY_MS).toISOString() : null;
    return { limit, used, remaining, resetAt, googleLimit: this.settings.getPublic().google_limit };
  }

  #setStatus(id, status, extra = {}) {
    const fields = { status, updated_at: nowIso(), ...extra };
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    this.#emitCampaign(id);
  }

  #emitCampaign(id) {
    const c = this.campaign(id);
    this.emit('event', {
      type: 'campaign',
      campaign: { id: c.id, status: c.status, pause_reason: c.pause_reason, resume_after: c.resume_after, counts: this.counts(id) },
      quota: this.quota(),
    });
  }

  #updateSend(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE sends SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
    const row = this.db.prepare('SELECT id, campaign_id, email, status, error_code, error_message, sent_at, attempted_at FROM sends WHERE id = ?').get(id);
    this.emit('event', { type: 'send', send: row });
  }

  // ---------------------------------------------------------------- yaşam döngüsü
  /** Uygulama açılışında: yarım kalan kampanyaları duraklatır, belirsiz gönderimleri işaretler. */
  recover() {
    const stuck = this.db.prepare("SELECT id, campaign_id FROM sends WHERE status = 'sending'").all();
    for (const s of stuck) {
      this.db
        .prepare("UPDATE sends SET status = 'unknown', error_code = 'interrupted' WHERE id = ?")
        .run(s.id);
      this.log('warn', s.campaign_id, 'send.interrupted', s.id);
    }
    for (const c of this.db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all()) {
      this.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = 'app_restart', updated_at = ? WHERE id = ?").run(nowIso(), c.id);
      this.log('warn', c.id, 'campaign.app_restart', '');
    }
  }

  /** Alıcı listesinden gönderim satırlarını (sends) oluşturur. Yalnızca taslaktan ilk başlatmada çalışır. */
  /**
   * Gönderim planı: her alıcının gönderilip gönderilmeyeceğine karar verir (veritabanına yazmaz).
   * Hem gönderim öncesi özet hem de prepare() aynı kuralları kullanır.
   * Mükerrer gönderim korumaları ("aynı kişi" = canonicalEmail):
   *  - engelli adres (bounce / abonelikten çıkma / elle)          → suppressed_*
   *  - aynı listede aynı posta kutusunun ikinci yazımı              → duplicate
   *  - başka bir gönderimde GÖNDERİLMİŞ ya da DURUMU BELİRSİZ adres → previously_sent
   */
  plan(campaign) {
    const recips = this.db
      .prepare('SELECT id, email, email_norm, data_json FROM recipients WHERE list_id = ? AND valid = 1 ORDER BY row_no')
      .all(campaign.list_id);
    if (campaign.order_mode === 'alpha') recips.sort((a, b) => a.email_norm.localeCompare(b.email_norm));
    if (campaign.order_mode === 'random') {
      for (let i = recips.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [recips[i], recips[j]] = [recips[j], recips[i]];
      }
    }

    // "Belirsiz" (unknown) ve yarıda kalmış (sending) gönderimler de gitmiş olabilir → gönderilmiş sayılır.
    const prevSent = campaign.skip_previously_sent
      ? new Set(
          this.db
            .prepare("SELECT DISTINCT email_norm FROM sends WHERE status IN ('sent','unknown','sending') AND campaign_id != ?")
            .all(campaign.id)
            .map((r) => canonicalEmail(r.email_norm)),
        )
      : new Set();
    const suppressed = new Map(
      this.db
        .prepare('SELECT email_norm, suppressed FROM contacts WHERE suppressed IS NOT NULL')
        .all()
        .map((r) => [canonicalEmail(r.email_norm), r.suppressed]),
    );

    const seen = new Set();
    const counts = { recipients: recips.length, toSend: 0, previouslySent: 0, suppressed: 0, duplicates: 0 };
    const rows = recips.map((r) => {
      const key = canonicalEmail(r.email_norm);
      let code = null;
      if (suppressed.has(key)) {
        code = `suppressed_${suppressed.get(key)}`;
        counts.suppressed++;
      } else if (seen.has(key)) {
        code = 'duplicate';
        counts.duplicates++;
      } else if (prevSent.has(key)) {
        code = 'previously_sent';
        counts.previouslySent++;
      } else {
        counts.toSend++;
      }
      seen.add(key);
      return { r, code };
    });
    return { rows, counts };
  }

  /** Alıcı listesinden gönderim satırlarını (sends) oluşturur. Yalnızca taslaktan ilk başlatmada çalışır. */
  prepare(campaign) {
    const { rows, counts } = this.plan(campaign);
    if (rows.length === 0) throw new AppError('campaign.no_recipients');
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO sends (campaign_id, recipient_id, email, email_norm, data_json, seq, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transaction(this.db, () => {
      rows.forEach(({ r, code }, i) => {
        insert.run(campaign.id, r.id, r.email, r.email_norm, r.data_json, i + 1, code ? 'skipped' : 'pending', code);
      });
    });
    if (counts.previouslySent) this.log('info', campaign.id, 'campaign.skipped_previous', String(counts.previouslySent));
    if (counts.suppressed) this.log('info', campaign.id, 'campaign.skipped_suppressed', String(counts.suppressed));
    if (counts.duplicates) this.log('info', campaign.id, 'campaign.skipped_duplicate', String(counts.duplicates));
  }

  async start(id) {
    const c = this.campaign(id);
    if (!['draft', 'paused'].includes(c.status)) throw new AppError('campaign.invalid_state');
    if (this.active && this.active.campaignId !== id) throw new AppError('campaign.another_running');
    // Duraklatma isteği verilmiş ama son gönderim hâlâ sürüyorsa onun bitmesi beklenir.
    if (this.active) await this.active.promise;
    if (this.active) throw new AppError('campaign.another_running');
    if (!c.subject.trim()) throw new AppError('campaign.subject_required');
    if (!(c.format === 'html' ? c.body_html : c.body_text).trim()) throw new AppError('campaign.body_required');
    if (!this.oauth.status().connected) throw new AppError('auth.not_connected');

    if (c.status === 'draft') {
      if (!c.list_id) throw new AppError('campaign.list_required');
      this.prepare(c);
      this.db.prepare('UPDATE campaigns SET started_at = ? WHERE id = ?').run(nowIso(), id);
    }
    this.#setStatus(id, 'running', { pause_reason: null, resume_after: null });
    this.log('info', id, c.status === 'draft' ? 'campaign.started' : 'campaign.resumed', '');

    const controller = new AbortController();
    this.active = { campaignId: id, controller };
    this.active.promise = this.#run(id, controller.signal).catch((err) => {
      this.log('error', id, 'campaign.crashed', err?.stack ?? String(err));
      try {
        this.#setStatus(id, 'paused', { pause_reason: 'error' });
      } catch { /* yoksay */ }
    });
  }

  pause(id) {
    const c = this.campaign(id);
    if (c.status !== 'running') throw new AppError('campaign.invalid_state');
    this.#setStatus(id, 'paused', { pause_reason: 'user' });
    this.log('info', id, 'campaign.paused', '');
    if (this.active?.campaignId === id) this.active.controller.abort();
  }

  cancel(id) {
    const c = this.campaign(id);
    if (!['running', 'paused'].includes(c.status)) throw new AppError('campaign.invalid_state');
    transaction(this.db, () => {
      this.db.prepare("UPDATE sends SET status = 'skipped', error_code = 'cancelled' WHERE campaign_id = ? AND status = 'pending'").run(id);
    });
    this.#setStatus(id, 'cancelled', { finished_at: nowIso(), pause_reason: null });
    this.log('info', id, 'campaign.cancelled', '');
    if (this.active?.campaignId === id) this.active.controller.abort();
  }

  /** Belirsiz (unknown) bir gönderimi kullanıcı kararına göre çözer. */
  resolveSend(campaignId, sendId, action) {
    const s = this.db.prepare('SELECT * FROM sends WHERE id = ? AND campaign_id = ?').get(sendId, campaignId);
    if (!s) throw new AppError('send.not_found', 404);
    if (action === 'mark_sent' && s.status === 'unknown') {
      this.#updateSend(s.id, { status: 'sent', sent_at: s.attempted_at ?? nowIso(), error_code: 'marked_sent' });
    } else if (action === 'retry' && ['unknown', 'failed'].includes(s.status)) {
      this.#updateSend(s.id, { status: 'pending', error_code: null, error_message: null });
      this.#reopen(campaignId);
    } else {
      throw new AppError('send.invalid_action');
    }
    this.#emitCampaign(campaignId);
  }

  retryFailed(campaignId) {
    const n = this.db
      .prepare("UPDATE sends SET status = 'pending', error_code = NULL, error_message = NULL WHERE campaign_id = ? AND status = 'failed'")
      .run(campaignId).changes;
    if (n) this.#reopen(campaignId);
    this.#emitCampaign(campaignId);
    return n;
  }

  /** Tamamlanmış bir kampanyada tekrar denenecek satır varsa, kampanyayı devam ettirilebilir hale getirir. */
  #reopen(campaignId) {
    const c = this.campaign(campaignId);
    if (c.status === 'completed') this.#setStatus(campaignId, 'paused', { pause_reason: 'retry', finished_at: null });
  }

  async stop() {
    if (this.active) {
      const { controller, promise } = this.active;
      controller.abort();
      await promise;
    }
  }

  // ---------------------------------------------------------------- mesaj üretimi
  attachmentsFor(campaignId) {
    return this.db.prepare('SELECT * FROM campaign_attachments WHERE campaign_id = ? ORDER BY id').all(campaignId);
  }

  /** Bir alıcı için kişiselleştirilmiş konu ve gövdeyi üretir. */
  renderFor(campaign, data, email) {
    const values = valuesForRecipient(Object.keys(data ?? {}), data ?? {}, email);
    const subject = render(campaign.subject, values).output.replace(/[\r\n]+/g, ' ').trim();
    const body = campaign.format === 'html'
      ? render(campaign.body_html, values, { html: true })
      : render(campaign.body_text, values);
    const subjMissing = render(campaign.subject, values).missing;
    return { subject, body: body.output, missing: [...new Set([...subjMissing, ...body.missing])] };
  }

  async compose(campaign, data, to) {
    const from = this.db.prepare('SELECT email FROM account WHERE id = 1').get()?.email;
    if (!from) throw new AppError('auth.not_connected', 401);
    const { subject, body } = this.renderFor(campaign, data, to);
    const attachments = this.attachmentsFor(campaign.id).map((a) => {
      if (!fs.existsSync(a.stored_path)) throw new AppError('attachments.missing', 400, { name: a.filename });
      return { filename: a.filename, path: a.stored_path, contentType: a.mime, size: a.size };
    });
    return buildMessage({
      from,
      to,
      subject,
      html: campaign.format === 'html' ? body : null,
      text: campaign.format === 'text' ? body : undefined,
      attachments,
      // Alıcı tek tıkla abonelikten çıkabilir; gelen "unsubscribe" maili takip modülü tarafından yakalanır.
      headers: campaign.list_unsubscribe ? { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` } : {},
    });
  }

  /** Kampanyanın ilk alıcısının verileriyle hesabın kendisine test e-postası gönderir. */
  async sendTest(campaignId, to) {
    const c = this.campaign(campaignId);
    if (!c.subject.trim()) throw new AppError('campaign.subject_required');
    const first = c.list_id
      ? this.db.prepare('SELECT data_json, email FROM recipients WHERE list_id = ? AND valid = 1 ORDER BY row_no LIMIT 1').get(c.list_id)
      : null;
    const data = first ? JSON.parse(first.data_json) : {};
    const target = to || this.db.prepare('SELECT email FROM account WHERE id = 1').get()?.email;
    if (!target) throw new AppError('auth.not_connected', 401);
    if (this.quota().remaining <= 0) throw new AppError('quota.exceeded');
    const raw = await this.compose({ ...c, subject: `[TEST] ${c.subject}` }, data, target);
    const res = await this.#sendWithRetry(raw, undefined);
    this.log('info', campaignId, 'campaign.test_sent', target);
    return { to: target, id: res.id };
  }

  async #sendWithRetry(raw, signal) {
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.oauth.getAccessToken();
      try {
        return await this.send(token, raw, { signal: undefined });
      } catch (err) {
        if (!(err instanceof GmailError)) throw err;
        if (err.kind === 'auth' && !authRetried) {
          authRetried = true;
          this.oauth.invalidateAccessToken();
          continue;
        }
        // Yalnızca isteğin Gmail tarafından KESİNLİKLE işlenmediği durumlarda tekrar denenir:
        // 429 (hız sınırı → reddedildi) ve bağlantı hiç kurulamadıysa (DNS, bağlantı reddi).
        // 5xx sunucu hatasında mesaj gitmiş olabilir → tekrar YOK, satır 'belirsiz' olur.
        const retryable = err.kind === 'rate' || (err.kind === 'transient' && err.status === 0 && SAFE_NETWORK_CODES.has(err.message));
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
        let wait = RETRY_DELAYS_MS[attempt];
        if (err.retryAt && !Number.isNaN(+err.retryAt)) wait = Math.max(wait, err.retryAt - this.now());
        const completed = await this.sleep(wait, signal);
        if (!completed) {
          const abort = new Error('aborted');
          abort.name = 'AbortError';
          throw abort;
        }
      }
    }
  }

  // ---------------------------------------------------------------- ana döngü
  async #run(id, signal) {
    let consecutiveFailures = 0;
    try {
      while (!signal.aborted) {
        const c = this.campaign(id);
        if (c.status !== 'running') break;

        const q = this.quota();
        if (q.remaining <= 0) {
          this.#setStatus(id, 'paused', { pause_reason: 'daily_limit', resume_after: q.resetAt });
          this.log('warn', id, 'campaign.daily_limit', q.resetAt ?? '');
          break;
        }

        const row = this.db
          .prepare("SELECT * FROM sends WHERE campaign_id = ? AND status = 'pending' ORDER BY seq LIMIT 1")
          .get(id);
        if (!row) {
          this.#setStatus(id, 'completed', { finished_at: nowIso(), pause_reason: null });
          this.log('info', id, 'campaign.completed', '');
          break;
        }

        this.#updateSend(row.id, { status: 'sending', attempts: row.attempts + 1, attempted_at: nowIso() });
        const outcome = await this.#sendOne(c, row, signal);
        this.#emitCampaign(id);

        if (outcome.stop) {
          this.#setStatus(id, 'paused', { pause_reason: outcome.reason, resume_after: outcome.resumeAfter ?? null });
          break;
        }
        if (outcome.failed) {
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.#setStatus(id, 'paused', { pause_reason: 'too_many_failures' });
            this.log('error', id, 'campaign.too_many_failures', String(consecutiveFailures));
            break;
          }
        } else {
          consecutiveFailures = 0;
        }

        // Kalan alıcı varsa kampanyanın sabit bekleme süresi kadar beklenir.
        const more = this.db.prepare("SELECT 1 FROM sends WHERE campaign_id = ? AND status = 'pending' LIMIT 1").get(id);
        if (more) await this.sleep(Math.max(1, c.delay_sec) * 1000, signal);
      }
    } finally {
      if (this.active?.campaignId === id) this.active = null;
      this.#emitCampaign(id);
    }
  }

  /** Tek bir alıcıya gönderir; döngünün devam edip etmeyeceğini belirten bir sonuç döner. */
  async #sendOne(c, row, signal) {
    const backToPending = () => this.#updateSend(row.id, { status: 'pending' });
    try {
      const raw = await this.compose(c, JSON.parse(row.data_json), row.email);
      const res = await this.#sendWithRetry(raw, signal);
      this.#updateSend(row.id, { status: 'sent', gmail_message_id: res.id ?? null, gmail_thread_id: res.threadId ?? null, sent_at: new Date(this.now()).toISOString(), error_code: null, error_message: null });
      return {};
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (this.campaign(c.id).status === 'cancelled') this.#updateSend(row.id, { status: 'skipped', error_code: 'cancelled' });
        else backToPending();
        return { stop: false };
      }
      if (err instanceof AppError) {
        backToPending();
        const reason = err.code.startsWith('auth.') ? 'auth' : err.code.startsWith('attachments.') ? 'attachment_error' : 'error';
        this.log('error', c.id, err.code, err.params?.name ?? '');
        return { stop: true, reason };
      }
      if (err instanceof GmailError) {
        const detail = `${err.status} ${err.reason}: ${err.message}`.trim();
        switch (err.kind) {
          case 'recipient':
            this.#updateSend(row.id, { status: 'failed', error_code: err.reason || String(err.status), error_message: err.message });
            this.log('warn', c.id, 'send.failed', `${row.email} — ${detail}`);
            return { failed: true };
          case 'quota':
            backToPending();
            this.log('warn', c.id, 'campaign.gmail_quota', detail);
            return { stop: true, reason: 'quota', resumeAfter: err.retryAt && !Number.isNaN(+err.retryAt) ? err.retryAt.toISOString() : null };
          case 'auth':
            backToPending();
            this.log('error', c.id, 'campaign.auth_error', detail);
            return { stop: true, reason: 'auth' };
          case 'transient':
            if (err.status >= 500) {
              // Gmail sunucu hatası: mesaj gönderilmiş olabilir → belirsiz; kullanıcı Gönderilmiş klasörüne bakıp karar verir.
              this.#updateSend(row.id, { status: 'unknown', error_code: 'server_error', error_message: err.message });
            } else if (err.status === 0 && !SAFE_NETWORK_CODES.has(err.message)) {
              // İstek Google'a ulaşmış olabilir: tekrar göndermek yerine belirsiz olarak işaretle.
              this.#updateSend(row.id, { status: 'unknown', error_code: 'network', error_message: err.message });
            } else {
              backToPending();
            }
            this.log('error', c.id, 'campaign.network_error', detail);
            return { stop: true, reason: 'network' };
          default:
            backToPending();
            this.log('error', c.id, 'campaign.gmail_error', detail);
            return { stop: true, reason: err.reason === 'api_disabled' ? 'api_disabled' : 'gmail_error' };
        }
      }
      // Beklenmeyen hata: güvenli tarafta kal.
      this.#updateSend(row.id, { status: 'unknown', error_code: 'internal', error_message: String(err?.message ?? err) });
      this.log('error', c.id, 'campaign.internal_error', err?.stack ?? String(err));
      return { stop: true, reason: 'error' };
    }
  }
}
