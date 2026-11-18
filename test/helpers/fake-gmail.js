// Bellek içi sahte Gmail API (testler ve görsel uçtan uca denemeler için).
// fetch(url, init) imzasını taklit eder; GmailApi'ye fetchImpl olarak verilir.
import { decodeWords } from '../../server/services/mail-parse.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const SYSTEM_LABELS = ['INBOX', 'SENT', 'DRAFT', 'STARRED', 'IMPORTANT', 'UNREAD', 'SPAM', 'TRASH', 'CATEGORY_PERSONAL', 'CATEGORY_UPDATES', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];

export class FakeGmail {
  constructor({ email = 'ben@gmail.com' } = {}) {
    this.email = email;
    this.messages = new Map();
    this.drafts = new Map();
    this.historyId = 1000;
    this.minHistoryId = 1000;
    this.history = [];
    this.userLabels = [{ id: 'Label_1', name: 'Müşteriler', type: 'user', color: { backgroundColor: '#16a765', textColor: '#ffffff' } }];
    this.seq = 0;
    this.calls = [];
    this.fetch = this.fetch.bind(this);
  }

  #id() {
    return `m${(++this.seq).toString(16).padStart(8, '0')}`;
  }

  #record(entry) {
    this.historyId++;
    this.history.push({ id: String(this.historyId), ...entry });
  }

  /**
   * Gmail biçiminde bir mesaj ekler.
   * opts: { from, to, cc, subject, text, html, labels, date, threadId, attachments: [{filename, mimeType, data(string)}],
   *         headers: {}, deliveryStatus, multipartReport }
   */
  addMessage(opts) {
    const id = opts.id ?? this.#id();
    const threadId = opts.threadId ?? id;
    const date = opts.date ?? Date.now();
    const headers = [
      { name: 'From', value: opts.from ?? 'Ali Veli <ali@ornek.com>' },
      { name: 'To', value: opts.to ?? this.email },
      ...(opts.cc ? [{ name: 'Cc', value: opts.cc }] : []),
      { name: 'Subject', value: opts.subject ?? '(konu yok)' },
      { name: 'Date', value: new Date(date).toUTCString() },
      { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
      ...Object.entries(opts.headers ?? {}).map(([name, value]) => ({ name, value })),
    ];
    const parts = [];
    let pn = 0;
    const alt = [];
    if (opts.text != null) alt.push({ partId: `0.${alt.length}`, mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { size: opts.text.length, data: b64(opts.text) } });
    if (opts.html != null) alt.push({ partId: `0.${alt.length}`, mimeType: 'text/html', filename: '', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { size: opts.html.length, data: b64(opts.html) } });
    parts.push({ partId: String(pn++), mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: alt });
    if (opts.deliveryStatus) {
      parts.push({ partId: String(pn++), mimeType: 'message/delivery-status', filename: '', headers: [], body: { size: opts.deliveryStatus.length, data: b64(opts.deliveryStatus) } });
    }
    const attachmentData = {};
    for (const a of opts.attachments ?? []) {
      const attId = `att_${id}_${pn}`;
      attachmentData[attId] = a.data;
      const ph = [{ name: 'Content-Type', value: a.mimeType }];
      if (a.contentId) ph.push({ name: 'Content-ID', value: `<${a.contentId}>` }, { name: 'Content-Disposition', value: 'inline' });
      parts.push({ partId: String(pn++), mimeType: a.mimeType, filename: a.contentId ? '' : a.filename, headers: ph, body: { size: a.data.length, attachmentId: attId } });
    }
    const labels = opts.labels ?? ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'];
    const msg = {
      id,
      threadId,
      labelIds: [...labels],
      snippet: (opts.text ?? opts.html ?? '').replace(/<[^>]+>/g, ' ').slice(0, 120),
      historyId: String(this.historyId + 1),
      internalDate: String(date),
      sizeEstimate: (opts.text ?? opts.html ?? '').length + 500,
      payload: { partId: '', mimeType: opts.deliveryStatus ? 'multipart/report' : 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts },
      _attachments: attachmentData,
    };
    this.messages.set(id, msg);
    this.#record({ messagesAdded: [{ message: { id, threadId, labelIds: msg.labelIds } }] });
    return msg;
  }

  setLabels(id, add = [], remove = []) {
    const m = this.messages.get(id);
    if (!m) return;
    const a = add.filter((l) => !m.labelIds.includes(l));
    const r = remove.filter((l) => m.labelIds.includes(l));
    m.labelIds = [...m.labelIds.filter((l) => !r.includes(l)), ...a];
    if (a.length) this.#record({ labelsAdded: [{ message: { id, threadId: m.threadId }, labelIds: a }] });
    if (r.length) this.#record({ labelsRemoved: [{ message: { id, threadId: m.threadId }, labelIds: r }] });
  }

  deleteMessage(id) {
    const m = this.messages.get(id);
    this.messages.delete(id);
    if (m) this.#record({ messagesDeleted: [{ message: { id, threadId: m.threadId } }] });
  }

  /** Gerçek Gmail'in 404 ile reddettiği eski historyId'leri taklit eder. */
  expireHistory() {
    this.minHistoryId = this.historyId;
  }

  #view(m, format) {
    const { _attachments, ...rest } = m;
    if (format === 'minimal') return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, historyId: m.historyId, internalDate: m.internalDate, sizeEstimate: m.sizeEstimate };
    if (format === 'metadata') return { ...rest, payload: { mimeType: m.payload.mimeType, headers: m.payload.headers, body: { size: 1 } } };
    return rest;
  }

  #matches(m, q) {
    if (!q) return true;
    const date = Number(m.internalDate);
    for (const tok of q.split(/\s+/)) {
      let r;
      if ((r = /^newer_than:(\d+)d$/.exec(tok))) {
        if (date < Date.now() - Number(r[1]) * 86400000) return false;
      } else if ((r = /^before:(\d+)$/.exec(tok))) {
        if (date >= Number(r[1]) * 1000) return false;
      } else {
        const hay = JSON.stringify(m.payload).toLowerCase() + m.snippet.toLowerCase();
        if (!hay.includes(tok.toLowerCase())) return false;
      }
    }
    return true;
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = u.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, '');
    this.calls.push(`${method} ${path}`);
    const json = (status, body) => ({
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => (body == null ? '' : JSON.stringify(body)),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const bodyJson = () => (typeof init.body === 'string' ? JSON.parse(init.body) : null);
    let r;

    if (method === 'GET' && path === '/profile') return json(200, { emailAddress: this.email, historyId: String(this.historyId), messagesTotal: this.messages.size });
    if (method === 'GET' && path === '/labels') {
      return json(200, { labels: [...SYSTEM_LABELS.map((id) => ({ id, name: id, type: 'system' })), ...this.userLabels] });
    }
    if (method === 'GET' && (r = /^\/labels\/([\w-]+)$/.exec(path))) {
      const id = r[1];
      const base = SYSTEM_LABELS.includes(id) ? { id, name: id, type: 'system' } : this.userLabels.find((l) => l.id === id);
      const ms = [...this.messages.values()].filter((m) => m.labelIds.includes(id));
      const unread = ms.filter((m) => m.labelIds.includes('UNREAD'));
      return json(200, { ...base, messagesTotal: ms.length, messagesUnread: unread.length, threadsUnread: new Set(unread.map((m) => m.threadId)).size });
    }
    if (method === 'GET' && path === '/messages') {
      const q = u.searchParams.get('q');
      const labelIds = u.searchParams.getAll('labelIds');
      const includeSpamTrash = u.searchParams.get('includeSpamTrash') === 'true';
      const max = Number(u.searchParams.get('maxResults') ?? 100);
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const all = [...this.messages.values()]
        .filter((m) => includeSpamTrash || labelIds.some((l) => ['SPAM', 'TRASH'].includes(l)) || !m.labelIds.some((l) => l === 'SPAM' || l === 'TRASH'))
        .filter((m) => labelIds.every((l) => m.labelIds.includes(l)))
        .filter((m) => this.#matches(m, q))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const page = all.slice(start, start + max);
      return json(200, { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: start + max < all.length ? String(start + max) : undefined, resultSizeEstimate: all.length });
    }
    if (method === 'GET' && (r = /^\/messages\/([\w-]+)\/attachments\/([\w-]+)$/.exec(path))) {
      const m = this.messages.get(r[1]);
      const data = m?._attachments[r[2]];
      return data == null ? json(404, { error: { code: 404, message: 'Not found' } }) : json(200, { size: data.length, data: b64(data) });
    }
    if (method === 'GET' && (r = /^\/messages\/([\w-]+)$/.exec(path))) {
      // Gmail'in dakikalık kota hatasını taklit et: failures.set(id, kaç kez)
      const left = this.failures?.get(r[1]) ?? 0;
      if (left > 0) {
        this.failures.set(r[1], left - 1);
        return json(429, {
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:1'.",
            errors: [{ reason: 'rateLimitExceeded' }],
            status: 'RESOURCE_EXHAUSTED',
          },
        });
      }
      const m = this.messages.get(r[1]);
      return m ? json(200, this.#view(m, u.searchParams.get('format') ?? 'full')) : json(404, { error: { code: 404, message: 'Not found' } });
    }
    if (method === 'GET' && (r = /^\/threads\/([\w-]+)$/.exec(path))) {
      const ms = [...this.messages.values()].filter((m) => m.threadId === r[1]).sort((a, b) => a.internalDate - b.internalDate);
      return ms.length ? json(200, { id: r[1], messages: ms.map((m) => this.#view(m, 'full')) }) : json(404, { error: { code: 404 } });
    }
    if (method === 'GET' && path === '/history') {
      const start = Number(u.searchParams.get('startHistoryId'));
      if (start < this.minHistoryId) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } });
      return json(200, { history: this.history.filter((h) => Number(h.id) > start), historyId: String(this.historyId) });
    }
    if (method === 'GET' && path === '/drafts') {
      return json(200, { drafts: [...this.drafts.entries()].map(([id, mid]) => ({ id, message: { id: mid, threadId: this.messages.get(mid)?.threadId } })) });
    }
    if (method === 'POST' && (r = /^\/threads\/([\w-]+)\/modify$/.exec(path))) {
      const b = bodyJson();
      for (const m of [...this.messages.values()].filter((x) => x.threadId === r[1])) this.setLabels(m.id, b.addLabelIds ?? [], b.removeLabelIds ?? []);
      return json(200, { id: r[1] });
    }
    if (method === 'POST' && path === '/messages/batchModify') {
      const b = bodyJson();
      b.ids.forEach((id) => this.setLabels(id, b.addLabelIds ?? [], b.removeLabelIds ?? []));
      return json(204, null);
    }
    if (method === 'POST' && (r = /^\/threads\/([\w-]+)\/(trash|untrash)$/.exec(path))) {
      for (const m of [...this.messages.values()].filter((x) => x.threadId === r[1])) {
        if (r[2] === 'trash') this.setLabels(m.id, ['TRASH'], ['INBOX']);
        else this.setLabels(m.id, ['INBOX'], ['TRASH']);
      }
      return json(200, { id: r[1] });
    }
    if (method === 'POST' && path === '/messages/send') {
      const { raw, threadId } = this.#rawFrom(init);
      const m = this.#fromRaw(raw, { threadId, labels: ['SENT'] });
      return json(200, { id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if ((method === 'POST' && path === '/drafts') || (method === 'PUT' && (r = /^\/drafts\/([\w-]+)$/.exec(path)))) {
      const { raw, threadId } = this.#rawFrom(init, true);
      const draftId = r?.[1] ?? `r${++this.seq}`;
      const old = this.drafts.get(draftId);
      if (old) this.deleteMessage(old);
      const m = this.#fromRaw(raw, { threadId, labels: ['DRAFT'] });
      this.drafts.set(draftId, m.id);
      return json(200, { id: draftId, message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } });
    }
    if (method === 'POST' && path === '/drafts/send') {
      const { id } = bodyJson();
      const mid = this.drafts.get(id);
      this.drafts.delete(id);
      this.setLabels(mid, ['SENT'], ['DRAFT']);
      return json(200, { id: mid, threadId: this.messages.get(mid).threadId, labelIds: this.messages.get(mid).labelIds });
    }
    if (method === 'DELETE' && (r = /^\/drafts\/([\w-]+)$/.exec(path))) {
      const mid = this.drafts.get(r[1]);
      this.drafts.delete(r[1]);
      if (mid) this.deleteMessage(mid);
      return json(204, null);
    }
    return json(404, { error: { code: 404, message: `fake: ${method} ${path}` } });
  }

  #rawFrom(init, draft = false) {
    if (typeof init.body === 'string') {
      const b = JSON.parse(init.body);
      const msg = draft ? b.message : b;
      return { raw: unb64(msg.raw).toString('utf8'), threadId: msg.threadId };
    }
    // multipart upload
    const text = Buffer.from(init.body).toString('utf8');
    const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(text)?.[1] ?? '{}');
    const raw = text.split('Content-Type: message/rfc822\r\n\r\n')[1] ?? '';
    return { raw, threadId: draft ? meta.message?.threadId : meta.threadId };
  }

  #fromRaw(raw, { threadId, labels }) {
    const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
    const h = (n) => decodeWords(new RegExp(`^${n}:\\s*(.*)$`, 'mi').exec(head)?.[1] ?? '');
    const inReplyTo = h('In-Reply-To');
    const parent = [...this.messages.values()].find((m) => m.payload.headers.some((x) => x.name === 'Message-ID' && x.value === inReplyTo));
    const qp = (s) => s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
    const textPart = /Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n--/i.exec(raw)?.[1] ?? '';
    return this.addMessage({
      from: h('From') || this.email,
      to: h('To'),
      cc: h('Cc') || undefined,
      subject: h('Subject'),
      text: Buffer.from(qp(textPart), 'latin1').toString('utf8'),
      threadId: threadId ?? parent?.threadId,
      labels,
      headers: inReplyTo ? { 'In-Reply-To': inReplyTo } : {},
    });
  }
}
