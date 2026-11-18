import { classifyError, GmailError } from './gmail.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const JSON_SEND_LIMIT = 4.5 * 1024 * 1024; // bunun üstü multipart upload ile gönderilir

/**
 * Uyarlanabilir kota kovası. Gmail'in "kullanıcı başına dakikalık" kota sınırı projeye göre
 * değişebilir; bu yüzden ihtiyatlı bir hızla (varsayılan 80 birim/sn ≈ 4.800/dk) başlanır.
 * Kota hatası gelince tüm istekler bir süre durdurulur ve hız yarıya iner; başarılı istekler
 * geldikçe hız yavaşça başlangıç değerine geri döner.
 * Birim maliyetleri: https://developers.google.com/gmail/api/reference/quota
 */
export class QuotaBucket {
  constructor({ rate = 80, minRate = 10, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onThrottle = () => {} } = {}) {
    this.baseRate = rate;
    this.rate = rate;
    this.minRate = minRate;
    this.burst = Math.min(rate, 40); // başlangıçta ani yük oluşmasın
    this.tokens = this.burst;
    this.last = now();
    this.now = now;
    this.sleep = sleep;
    this.onThrottle = onThrottle;
    this.blockedUntil = 0;
    this.successes = 0;
    this.queue = Promise.resolve();
  }

  take(units) {
    const run = async () => {
      for (;;) {
        const t = this.now();
        if (t < this.blockedUntil) {
          await this.sleep(this.blockedUntil - t);
          continue;
        }
        this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
        this.last = t;
        // Kapasiteden büyük istekler (ör. gönderim = 100 birim) kova dolunca geçer ve
        // kovayı eksiye düşürür; sonraki istekler bu borç ödenene kadar bekler.
        const need = Math.min(units, this.burst);
        if (this.tokens >= need) {
          this.tokens -= units;
          return;
        }
        await this.sleep(Math.ceil(((need - this.tokens) / this.rate) * 1000));
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Kota hatası: herkes `ms` kadar bekler, hız yarıya iner. */
  penalize(ms) {
    const until = this.now() + ms;
    if (until > this.blockedUntil) this.blockedUntil = until;
    this.rate = Math.max(this.minRate, Math.floor(this.rate / 2));
    this.tokens = 0;
    this.successes = 0;
    this.onThrottle({ until: this.blockedUntil, rate: this.rate });
  }

  /** Başarılı istek: 50 başarıda bir hız %25 artar (başlangıç değerini aşmaz). */
  reward() {
    if (this.rate >= this.baseRate) return;
    if (++this.successes >= 50) {
      this.successes = 0;
      this.rate = Math.min(this.baseRate, Math.ceil(this.rate * 1.25));
    }
  }
}

/** "…per minute…" kota hataları dakikalık penceredir → en az 60 sn beklenir. */
const isPerMinuteQuota = (err) => /per minute|Units per minute/i.test(err?.message ?? '');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Yetkili Gmail REST istemcisi: kota sınırlama, 401'de token yenileme, 429/5xx'te üstel bekleme.
 */
export class GmailApi {
  constructor({ oauth, fetchImpl = (...a) => fetch(...a), bucket = new QuotaBucket(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.oauth = oauth;
    this.fetch = fetchImpl;
    this.bucket = bucket;
    this.sleep = sleep;
  }

  async request(method, path, { query, json, body, contentType, units = 5, base = BASE, binary = false, idempotent = true } = {}) {
    let url = `${base}${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v == null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
        else qs.append(k, String(v));
      }
      const str = qs.toString();
      if (str) url += `?${str}`;
    }
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take(units);
      const token = await this.oauth.getAccessToken();
      const headers = { Authorization: `Bearer ${token}` };
      let payload = body;
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(json);
      } else if (contentType) headers['Content-Type'] = contentType;

      let res;
      try {
        res = await this.fetch(url, { method, headers, body: payload });
      } catch (err) {
        // Gönderim gibi tekrarlanamaz isteklerde bağlantı kopması belirsizdir → otomatik tekrar YOK
        if (idempotent && attempt < 3) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new GmailError({ kind: 'transient', status: 0, reason: 'network', message: err?.cause?.code ?? err.message });
      }
      if (res.ok) {
        this.bucket.reward();
        if (res.status === 204) return null;
        if (binary) return Buffer.from(await res.arrayBuffer());
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      const errBody = await res.json().catch(() => ({}));
      const err = classifyError(res.status, errBody);
      if (res.status === 404) {
        const nf = new GmailError({ kind: 'fatal', status: 404, reason: 'notFound', message: errBody?.error?.message ?? 'Not found' });
        nf.notFound = true;
        throw nf;
      }
      if (err.kind === 'auth' && !authRetried) {
        authRetried = true;
        this.oauth.invalidateAccessToken();
        continue;
      }
      if (err.kind === 'rate' && attempt < 5) {
        // Hız/kota sınırı: tüm istekler (yalnızca bu değil) birlikte bekler; dakikalık kotada ≥ 60 sn.
        const retryIn = err.retryAt && !Number.isNaN(+err.retryAt) ? Math.max(0, err.retryAt - Date.now()) : 0;
        this.bucket.penalize(Math.max(retryIn, isPerMinuteQuota(err) ? 61000 : 2000 * 2 ** attempt));
        continue;
      }
      if (err.kind === 'transient' && idempotent && attempt < 4) {
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }

  // ---- okuma
  getProfile() {
    return this.request('GET', '/profile', { units: 1 });
  }
  listLabels() {
    return this.request('GET', '/labels', { units: 1 });
  }
  getLabel(id) {
    return this.request('GET', `/labels/${encodeURIComponent(id)}`, { units: 1 });
  }
  listMessages({ q, labelIds, pageToken, maxResults = 100, includeSpamTrash = false } = {}) {
    return this.request('GET', '/messages', { query: { q, labelIds, pageToken, maxResults, includeSpamTrash }, units: 5 });
  }
  getMessage(id, format = 'full') {
    return this.request('GET', `/messages/${id}`, { query: { format }, units: 5 });
  }
  getThread(id, format = 'full') {
    return this.request('GET', `/threads/${id}`, { query: { format }, units: 10 });
  }
  listHistory({ startHistoryId, pageToken }) {
    return this.request('GET', '/history', { query: { startHistoryId, pageToken, maxResults: 500 }, units: 2 });
  }
  async getAttachment(messageId, attachmentId) {
    const r = await this.request('GET', `/messages/${messageId}/attachments/${attachmentId}`, { units: 5 });
    return Buffer.from(String(r.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  listDrafts(pageToken) {
    return this.request('GET', '/drafts', { query: { pageToken, maxResults: 500 }, units: 5 });
  }

  // ---- değiştirme
  modifyThread(id, add = [], remove = []) {
    return this.request('POST', `/threads/${id}/modify`, { json: { addLabelIds: add, removeLabelIds: remove }, units: 10 });
  }
  batchModify(ids, add = [], remove = []) {
    return this.request('POST', '/messages/batchModify', { json: { ids, addLabelIds: add, removeLabelIds: remove }, units: 50 });
  }
  trashThread(id) {
    return this.request('POST', `/threads/${id}/trash`, { units: 10 });
  }
  untrashThread(id) {
    return this.request('POST', `/threads/${id}/untrash`, { units: 10 });
  }

  // ---- gönderme / taslak
  /** Ham MIME'yi (isteğe bağlı threadId ile) gönderir; büyük mesajlarda multipart upload kullanılır. */
  sendMessage(raw, threadId) {
    return this.#rawCall('POST', '/messages/send', raw, threadId ? { threadId } : {}, 100, undefined, false);
  }
  createDraft(raw, threadId) {
    return this.#rawCall('POST', '/drafts', raw, {}, 10, threadId);
  }
  updateDraft(draftId, raw, threadId) {
    return this.#rawCall('PUT', `/drafts/${draftId}`, raw, { id: draftId }, 15, threadId);
  }
  sendDraft(draftId) {
    return this.request('POST', '/drafts/send', { json: { id: draftId }, units: 100, idempotent: false });
  }
  deleteDraft(draftId) {
    return this.request('DELETE', `/drafts/${draftId}`, { units: 10 });
  }

  /** messages.send için gövde {raw, threadId}; drafts için {message: {raw, threadId}} biçimindedir. */
  #rawCall(method, path, raw, extra, units, draftThreadId, idempotent = true) {
    const isDraft = path.startsWith('/drafts');
    if (raw.length <= JSON_SEND_LIMIT) {
      const message = { raw: b64url(raw), ...(isDraft ? (draftThreadId ? { threadId: draftThreadId } : {}) : extra) };
      return this.request(method, path, { json: isDraft ? { ...extra, message } : message, units, idempotent });
    }
    const boundary = `gf_${Date.now().toString(36)}`;
    const meta = isDraft ? { ...extra, message: draftThreadId ? { threadId: draftThreadId } : {} } : extra;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
      raw,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.request(method, path, { base: UPLOAD, query: { uploadType: 'multipart' }, body, contentType: `multipart/related; boundary=${boundary}`, units, idempotent });
  }
}
