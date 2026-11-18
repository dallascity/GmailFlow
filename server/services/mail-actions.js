import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../lib/errors.js';
import { buildMailMessage } from './mime.js';
import { normalizeEmail, validateEmail } from './validator.js';
import { prepareDisplayHtml, textToHtml } from './mail-parse.js';

const nowIso = () => new Date().toISOString();
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

/** Posta ekranının işlemleri: okuma görünümü, etiketler, çöp, gönderme, taslaklar. */
export class MailService {
  constructor({ db, store, api, sync, sender, settings, oauth, dataDir, emit = () => {} }) {
    this.db = db;
    this.store = store;
    this.api = api;
    this.sync = sync;
    this.sender = sender;
    this.settings = settings;
    this.oauth = oauth;
    this.tmpDir = path.join(dataDir, 'compose-tmp');
    this.emit = emit;
    this.inlineCache = new Map();
    this.labelTimer = null;
    this.#cleanupTmp();
  }

  requireReady() {
    if (!this.oauth.status().mailReady) throw new AppError('mail.reconnect_required', 403);
  }

  me() {
    return this.db.prepare('SELECT email FROM account WHERE id = 1').get()?.email ?? null;
  }

  // ------------------------------------------------------------ okuma
  async thread(threadId, { images = false } = {}) {
    let msgs = this.store.threadMessages(threadId);
    if (!msgs.length || msgs.some((m) => !m.body_fetched)) {
      await this.sync.fetchThread(threadId);
      msgs = this.store.threadMessages(threadId);
    } else {
      this.store.markOpened(msgs.map((m) => m.id));
    }
    if (!msgs.length) throw new AppError('mail.not_found', 404);

    const alwaysImages = this.settings.get('mail_images') === 'always';
    const out = [];
    for (const m of msgs) {
      const attachments = JSON.parse(m.attachments_json);
      const allowRemote = images || alwaysImages || this.#senderAllowsImages(m.from_email);
      let display;
      if (m.body_html) {
        const cidMap = await this.#inlineImages(m.id, attachments);
        display = prepareDisplayHtml(m.body_html, { cidMap, allowRemote });
      } else {
        display = prepareDisplayHtml(textToHtml(m.body_text ?? m.snippet), { allowRemote: true });
      }
      out.push({
        id: m.id,
        threadId: m.thread_id,
        date: m.internal_date,
        from: { name: m.from_name, email: m.from_email },
        to: JSON.parse(m.to_json),
        cc: JSON.parse(m.cc_json),
        bcc: JSON.parse(m.bcc_json),
        replyTo: m.reply_to,
        subject: m.subject,
        snippet: m.snippet,
        labels: m.labels,
        messageIdHeader: m.message_id_header,
        references: m.references_header,
        listUnsubscribe: m.list_unsubscribe,
        attachments: attachments.filter((a) => !a.inline).map(({ data, ...a }) => a),
        html: display.html,
        text: m.body_text,
        blockedImages: display.blockedImages,
        draftId: m.labels.includes('DRAFT') ? this.store.draftIdFor(m.id) : null,
      });
    }
    const campaign = this.db
      .prepare(
        `SELECT s.campaign_id, c.name campaign_name, s.email, s.replied_at, s.bounced_at, s.bounce_reason
         FROM sends s JOIN campaigns c ON c.id = s.campaign_id WHERE s.gmail_thread_id = ? LIMIT 1`,
      )
      .get(threadId);
    const contact = this.db
      .prepare('SELECT id, email, name, suppressed FROM contacts WHERE email_norm IN (SELECT value FROM json_each(?)) LIMIT 1')
      .get(JSON.stringify(msgs.map((m) => m.from_email).filter((e) => e && e !== this.me())));
    return { id: threadId, subject: msgs[0].subject, labels: [...new Set(msgs.flatMap((m) => m.labels))], messages: out, campaign: campaign ?? null, contact: contact ?? null };
  }

  #senderAllowsImages(email) {
    return Boolean(email && this.db.prepare('SELECT show_images FROM mail_sender_prefs WHERE email = ?').get(email)?.show_images);
  }

  allowImages(email) {
    this.db
      .prepare('INSERT INTO mail_sender_prefs (email, show_images) VALUES (?, 1) ON CONFLICT(email) DO UPDATE SET show_images = 1')
      .run(String(email).toLowerCase());
  }

  /** cid: görselleri data URI'ye çevirir (satır içi; iframe dışına istek gitmez). */
  async #inlineImages(messageId, attachments) {
    const map = {};
    let total = 0;
    for (const a of attachments.filter((x) => x.contentId)) {
      const key = `${messageId}:${a.partId}`;
      let uri = this.inlineCache.get(key);
      if (!uri) {
        if (total + (a.size ?? 0) > MAX_INLINE_BYTES) continue;
        const buf = a.data
          ? Buffer.from(a.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
          : a.attachmentId
            ? await this.api.getAttachment(messageId, a.attachmentId).catch(() => null)
            : null;
        if (!buf) continue;
        uri = `data:${a.mimeType};base64,${buf.toString('base64')}`;
        this.inlineCache.set(key, uri);
        if (this.inlineCache.size > 60) this.inlineCache.delete(this.inlineCache.keys().next().value);
      }
      total += a.size ?? 0;
      map[a.contentId] = uri;
    }
    return map;
  }

  async attachment(messageId, attachmentId) {
    const m = this.store.message(messageId);
    const meta = m ? JSON.parse(m.attachments_json).find((a) => a.attachmentId === attachmentId) : null;
    const data = await this.api.getAttachment(messageId, attachmentId);
    return { data, filename: meta?.filename ?? 'ek', mimeType: meta?.mimeType ?? 'application/octet-stream' };
  }

  // ------------------------------------------------------------ etiketler
  /** Konuşmalara etiket ekler/çıkarır. Arayüze hemen yansır; Gmail hata verirse geri alınır. */
  async modify(threadIds, add = [], remove = []) {
    this.requireReady();
    const snapshot = new Map();
    for (const t of threadIds) {
      for (const id of this.store.threadMessageIds(t)) {
        snapshot.set(id, this.store.labelsOf(id));
        this.store.changeLabels(id, add, remove);
      }
    }
    this.emit({ type: 'mail:changed', threads: threadIds });
    try {
      for (const t of threadIds) await this.api.modifyThread(t, add, remove);
    } catch (err) {
      for (const [id, labels] of snapshot) {
        const now = this.store.labelsOf(id);
        this.store.changeLabels(id, labels.filter((l) => !now.includes(l)), now.filter((l) => !labels.includes(l)));
      }
      this.emit({ type: 'mail:changed', threads: threadIds });
      throw err;
    }
    this.#refreshLabelCountsSoon();
    return { ok: true };
  }

  async trash(threadIds, restore = false) {
    this.requireReady();
    for (const t of threadIds) {
      await (restore ? this.api.untrashThread(t) : this.api.trashThread(t));
      for (const id of this.store.threadMessageIds(t)) {
        if (restore) this.store.changeLabels(id, [], ['TRASH']);
        else this.store.changeLabels(id, ['TRASH'], ['INBOX']);
      }
    }
    this.emit({ type: 'mail:changed', threads: threadIds });
    this.#refreshLabelCountsSoon();
    return { ok: true };
  }

  #refreshLabelCountsSoon() {
    clearTimeout(this.labelTimer);
    this.labelTimer = setTimeout(() => {
      this.sync
        .refreshLabels()
        .then(() => this.emit({ type: 'mail:labels' }))
        .catch(() => {});
    }, 1500);
  }

  // ------------------------------------------------------------ yazma
  async saveUpload(file) {
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const id = crypto.randomUUID();
    const dest = path.join(this.tmpDir, id);
    const buf = await file.toBuffer();
    fs.writeFileSync(dest, buf);
    const meta = { id, filename: path.basename(file.filename).replace(/[\r\n"]/g, '_'), mimeType: file.mimetype || 'application/octet-stream', size: buf.length };
    fs.writeFileSync(`${dest}.json`, JSON.stringify(meta));
    return meta;
  }

  #cleanupTmp() {
    try {
      for (const f of fs.readdirSync(this.tmpDir)) {
        const p = path.join(this.tmpDir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true });
      }
    } catch {
      /* klasör yok */
    }
  }

  #recipients(list) {
    const out = [];
    for (const r of list ?? []) {
      const email = normalizeEmail(typeof r === 'string' ? r : r.email);
      if (!email) continue;
      if (validateEmail(email)) throw new AppError('mail.invalid_recipient', 400, { email });
      out.push({ name: typeof r === 'string' ? null : r.name ?? null, email });
    }
    return out;
  }

  async #build(body) {
    const from = this.me();
    if (!from) throw new AppError('auth.not_connected', 401);
    const to = this.#recipients(body.to);
    const cc = this.#recipients(body.cc);
    const bcc = this.#recipients(body.bcc);
    const attachments = [];
    for (const id of body.attachments ?? []) {
      const p = path.join(this.tmpDir, path.basename(String(id)));
      if (!fs.existsSync(p)) throw new AppError('attachments.missing', 400, { name: id });
      const meta = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8'));
      attachments.push({ filename: meta.filename, contentType: meta.mimeType, path: p, size: meta.size });
    }
    // İletme / taslaktan gelen, Gmail'de duran ekler
    for (const f of body.forward ?? []) {
      const content = await this.api.getAttachment(f.messageId, f.attachmentId);
      attachments.push({ filename: f.filename, contentType: f.mimeType, content, size: content.length });
    }
    const raw = await buildMailMessage({
      from,
      to,
      cc,
      bcc,
      subject: String(body.subject ?? '').replace(/[\r\n]+/g, ' '),
      html: body.html || null,
      text: body.html ? undefined : body.text ?? '',
      attachments,
      inReplyTo: body.inReplyTo,
      references: body.references,
    });
    return { raw, count: to.length + cc.length + bcc.length };
  }

  async send(body) {
    this.requireReady();
    const { raw, count } = await this.#build(body);
    if (!count) throw new AppError('mail.no_recipients');
    if (this.sender.quota().remaining < count) throw new AppError('quota.exceeded');
    let res;
    if (body.draftId) {
      await this.api.updateDraft(body.draftId, raw, body.threadId);
      res = (await this.api.sendDraft(body.draftId)) ?? {};
    } else {
      res = (await this.api.sendMessage(raw, body.threadId)) ?? {};
    }
    this.db.prepare('INSERT INTO manual_sends (ts, recipients) VALUES (?, ?)').run(nowIso(), count);
    for (const id of body.attachments ?? []) {
      const p = path.join(this.tmpDir, path.basename(String(id)));
      fs.rmSync(p, { force: true });
      fs.rmSync(`${p}.json`, { force: true });
    }
    this.emit({ type: 'campaign-quota', quota: this.sender.quota() });
    setTimeout(() => this.sync.syncNow().catch(() => {}), 1500);
    return { id: res.id ?? res.message?.id, threadId: res.threadId ?? res.message?.threadId };
  }

  async saveDraft(body) {
    this.requireReady();
    const { raw } = await this.#build({ ...body, to: body.to ?? [] });
    const r = body.draftId ? await this.api.updateDraft(body.draftId, raw, body.threadId) : await this.api.createDraft(raw, body.threadId);
    if (r?.id && r?.message?.id) {
      this.db.prepare('DELETE FROM mail_drafts WHERE draft_id = ?').run(r.id);
      this.db.prepare('INSERT OR REPLACE INTO mail_drafts (draft_id, message_id) VALUES (?, ?)').run(r.id, r.message.id);
    }
    setTimeout(() => this.sync.syncNow().catch(() => {}), 1500);
    return { draftId: r?.id, messageId: r?.message?.id, threadId: r?.message?.threadId };
  }

  async deleteDraft(draftId) {
    this.requireReady();
    const mid = this.db.prepare('SELECT message_id FROM mail_drafts WHERE draft_id = ?').get(draftId)?.message_id;
    await this.api.deleteDraft(draftId);
    this.db.prepare('DELETE FROM mail_drafts WHERE draft_id = ?').run(draftId);
    if (mid) this.store.deleteMessage(mid);
    this.emit({ type: 'mail:changed' });
    return { ok: true };
  }

  /** Taslaklar klasöründen açılan bir taslağı oluşturucuya yüklemek için. */
  async draftForMessage(messageId) {
    let m = this.store.message(messageId);
    if (!m?.body_fetched) {
      await this.sync.fetchMessage(messageId, 'full', { opened: true });
      m = this.store.message(messageId);
    }
    if (!m) throw new AppError('mail.not_found', 404);
    let draftId = this.store.draftIdFor(messageId);
    if (!draftId) {
      await this.sync.refreshDrafts();
      draftId = this.store.draftIdFor(messageId);
    }
    return {
      draftId,
      threadId: m.thread_id,
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      bcc: JSON.parse(m.bcc_json),
      subject: m.subject,
      html: m.body_html ?? textToHtml(m.body_text ?? ''),
      inReplyTo: m.in_reply_to,
      references: m.references_header,
      forward: JSON.parse(m.attachments_json)
        .filter((a) => a.attachmentId && !a.inline)
        .map((a) => ({ messageId, attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size })),
    };
  }

  /** Alıcı alanı için otomatik tamamlama: kayıtlı mailler + yazışılan kişiler. */
  suggest(q) {
    const like = `%${String(q ?? '').toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT email, name FROM (
           SELECT email_norm email, name, 1 pri FROM contacts WHERE email_norm LIKE ? OR LOWER(COALESCE(name,'')) LIKE ?
           UNION ALL
           SELECT from_email email, from_name name, 2 pri FROM mail_messages
             WHERE from_email IS NOT NULL AND (from_email LIKE ? OR LOWER(COALESCE(from_name,'')) LIKE ?)
         ) GROUP BY email ORDER BY MIN(pri), email LIMIT 8`,
      )
      .all(like, like, like, like);
    return rows.filter((r) => r.email !== this.me());
  }
}
