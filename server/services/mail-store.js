import { transaction } from '../db/index.js';

const nowIso = () => new Date().toISOString();

/**
 * FTS için metin katlama: SQLite'ın remove_diacritics'i ş→s, ğ→g, ö→o yapar ama Türkçe noktasız ı'yı
 * ayrı bir harf sayar. Kullanıcılar sık sık "toplanti" diye arar → ı/İ her iki tarafta da i'ye çevrilir.
 */
export const foldTr = (s) => String(s ?? '').replace(/[ıİI]/g, (c) => (c === 'I' ? 'I' : 'i'));

/** Kullanıcı arama metnini güvenli bir FTS5 sorgusuna çevirir: her kelime önek eşleşmesiyle VE'lenir. */
export function ftsQuery(text) {
  const tokens = foldTr(text)
    .split(/\s+/)
    .map((t) => t.replace(/["*^:(){}[\]]/g, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
}

/** Posta önbelleği (SQLite). Gmail ile iletişim kurmaz; yalnızca yerel veriyi yönetir. */
export class MailStore {
  constructor(db) {
    this.db = db;
  }

  // ---- durum
  getState(key) {
    return this.db.prepare('SELECT value FROM mail_sync_state WHERE key = ?').get(key)?.value ?? null;
  }
  setState(key, value) {
    this.db
      .prepare('INSERT INTO mail_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  // ---- etiketler
  upsertLabels(labels) {
    const stmt = this.db.prepare(
      `INSERT INTO mail_labels (id, name, type, messages_total, messages_unread, threads_unread, color_bg, color_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type,
         messages_total = COALESCE(excluded.messages_total, mail_labels.messages_total),
         messages_unread = COALESCE(excluded.messages_unread, mail_labels.messages_unread),
         threads_unread = COALESCE(excluded.threads_unread, mail_labels.threads_unread),
         color_bg = excluded.color_bg, color_text = excluded.color_text, updated_at = excluded.updated_at`,
    );
    const now = nowIso();
    transaction(this.db, () => {
      for (const l of labels) {
        stmt.run(l.id, l.name, l.type ?? 'user', l.messagesTotal ?? 0, l.messagesUnread ?? 0, l.threadsUnread ?? 0, l.color?.backgroundColor ?? null, l.color?.textColor ?? null, now);
      }
      if (labels.length && labels.every((l) => 'type' in l)) {
        const ids = labels.map((l) => l.id);
        this.db.prepare('DELETE FROM mail_labels WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
      }
    });
  }

  labels() {
    return this.db.prepare('SELECT * FROM mail_labels ORDER BY type DESC, name COLLATE NOCASE').all();
  }

  // ---- mesajlar
  hasMessage(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM mail_messages WHERE id = ?').get(id));
  }

  message(id) {
    return this.db.prepare('SELECT rowid, * FROM mail_messages WHERE id = ?').get(id) ?? null;
  }

  /** Ayrıştırılmış mesajı kaydeder. Metadata ile gelen güncelleme önceden indirilmiş gövdeyi silmez. */
  upsertMessage(p, { opened } = {}) {
    const existing = this.message(p.id);
    const keepBody = existing?.body_fetched && !p.bodyFetched;
    const row = {
      thread_id: p.threadId,
      history_id: p.historyId,
      internal_date: p.internalDate,
      from_name: p.from?.name ?? null,
      from_email: p.from?.email ?? null,
      to_json: JSON.stringify(p.to ?? []),
      cc_json: JSON.stringify(p.cc ?? []),
      bcc_json: JSON.stringify(p.bcc ?? []),
      reply_to: p.replyTo,
      subject: p.subject ?? '',
      snippet: p.snippet ?? '',
      message_id_header: p.messageIdHeader,
      in_reply_to: p.inReplyTo,
      references_header: p.references,
      list_unsubscribe: p.listUnsubscribe,
      size: p.size ?? 0,
      has_attachments: keepBody ? existing.has_attachments : (p.attachments ?? []).some((a) => !a.inline) ? 1 : 0,
      attachments_json: keepBody ? existing.attachments_json : JSON.stringify((p.attachments ?? []).map(({ data, ...a }) => a)),
      body_text: keepBody ? existing.body_text : p.text,
      body_html: keepBody ? existing.body_html : p.html,
      delivery_status: keepBody ? existing.delivery_status : p.deliveryStatus,
      failed_recipients: JSON.stringify(p.failedRecipients ?? []),
      body_fetched: keepBody || p.bodyFetched ? 1 : 0,
      opened: opened ? 1 : (existing?.opened ?? 0),
      synced_at: nowIso(),
    };
    transaction(this.db, () => {
      if (existing) {
        const keys = Object.keys(row);
        this.db.prepare(`UPDATE mail_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => row[k]), p.id);
      } else {
        const keys = ['id', ...Object.keys(row)];
        const vals = [p.id, ...Object.values(row)];
        this.db.prepare(`INSERT INTO mail_messages (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...vals);
      }
      this.#setLabels(p.id, p.labelIds ?? []);
      const rowid = this.db.prepare('SELECT rowid FROM mail_messages WHERE id = ?').get(p.id).rowid;
      const people = [p.from?.name, p.from?.email, ...(p.to ?? []).flatMap((a) => [a.name, a.email]), ...(p.cc ?? []).map((a) => a.email)]
        .filter(Boolean)
        .join(' ');
      const body = row.body_text || (row.body_html ? row.body_html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : p.snippet);
      this.db.prepare('DELETE FROM mail_fts WHERE rowid = ?').run(rowid);
      this.db
        .prepare('INSERT INTO mail_fts (rowid, subject, people, body) VALUES (?, ?, ?, ?)')
        .run(rowid, foldTr(row.subject), foldTr(people), foldTr(String(body ?? '').slice(0, 200000)));
    });
    return { isNew: !existing };
  }

  #setLabels(id, labelIds) {
    this.db.prepare('DELETE FROM mail_message_labels WHERE message_id = ?').run(id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO mail_message_labels (message_id, label_id) VALUES (?, ?)');
    for (const l of labelIds) ins.run(id, l);
  }

  labelsOf(id) {
    return this.db.prepare('SELECT label_id FROM mail_message_labels WHERE message_id = ?').all(id).map((r) => r.label_id);
  }

  changeLabels(id, add = [], remove = []) {
    if (!this.hasMessage(id)) return false;
    transaction(this.db, () => {
      const ins = this.db.prepare('INSERT OR IGNORE INTO mail_message_labels (message_id, label_id) VALUES (?, ?)');
      const del = this.db.prepare('DELETE FROM mail_message_labels WHERE message_id = ? AND label_id = ?');
      add.forEach((l) => ins.run(id, l));
      remove.forEach((l) => del.run(id, l));
    });
    return true;
  }

  deleteMessage(id) {
    const row = this.db.prepare('SELECT rowid FROM mail_messages WHERE id = ?').get(id);
    if (!row) return;
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM mail_fts WHERE rowid = ?').run(row.rowid);
      this.db.prepare('DELETE FROM mail_messages WHERE id = ?').run(id);
    });
  }

  markOpened(ids) {
    const stmt = this.db.prepare('UPDATE mail_messages SET opened = 1 WHERE id = ?');
    ids.forEach((id) => stmt.run(id));
  }

  threadMessageIds(threadId) {
    return this.db.prepare('SELECT id FROM mail_messages WHERE thread_id = ? ORDER BY internal_date').all(threadId).map((r) => r.id);
  }

  threadMessages(threadId) {
    return this.db.prepare('SELECT * FROM mail_messages WHERE thread_id = ? ORDER BY internal_date').all(threadId).map((m) => ({
      ...m,
      labels: this.labelsOf(m.id),
    }));
  }

  /** Belirli bir etiketteki en eski önbellek tarihi (daha eski sayfaları Gmail'den çekmek için). */
  oldestDate(label) {
    const sql = label === 'ALL'
      ? 'SELECT MIN(internal_date) d FROM mail_messages'
      : 'SELECT MIN(m.internal_date) d FROM mail_messages m JOIN mail_message_labels l ON l.message_id = m.id AND l.label_id = ?';
    return (label === 'ALL' ? this.db.prepare(sql).get() : this.db.prepare(sql).get(label)).d ?? null;
  }

  /**
   * Konuşma listesi. label='ALL' → spam/çöp hariç tüm postalar. q → tam metin arama.
   * @returns {{ total: number, threads: object[] }}
   */
  listThreads({ label = 'INBOX', q = '', offset = 0, limit = 50, threadIds = null } = {}) {
    const where = [];
    const args = [];
    let join = '';
    if (threadIds) {
      where.push('m.thread_id IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(threadIds));
    } else if (label === 'ALL') {
      where.push("NOT EXISTS (SELECT 1 FROM mail_message_labels x WHERE x.message_id = m.id AND x.label_id IN ('SPAM','TRASH'))");
    } else if (label) {
      join = 'JOIN mail_message_labels l ON l.message_id = m.id AND l.label_id = ?';
      args.unshift(label);
    }
    const fq = ftsQuery(q);
    if (fq) {
      where.push('m.rowid IN (SELECT rowid FROM mail_fts WHERE mail_fts MATCH ?)');
      args.push(fq);
    }
    const base = `FROM mail_messages m ${join} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const total = this.db.prepare(`SELECT COUNT(DISTINCT m.thread_id) n ${base}`).get(...args).n;
    const ids = this.db
      .prepare(`SELECT m.thread_id, MAX(m.internal_date) last_date ${base} GROUP BY m.thread_id ORDER BY last_date DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset);
    return { total, threads: ids.map((r) => this.threadSummary(r.thread_id)) };
  }

  threadSummary(threadId) {
    const msgs = this.db
      .prepare('SELECT id, from_name, from_email, subject, snippet, internal_date, has_attachments, to_json FROM mail_messages WHERE thread_id = ? ORDER BY internal_date')
      .all(threadId);
    const labels = this.db
      .prepare('SELECT DISTINCT l.label_id FROM mail_message_labels l JOIN mail_messages m ON m.id = l.message_id WHERE m.thread_id = ?')
      .all(threadId)
      .map((r) => r.label_id);
    const unread = this.db
      .prepare("SELECT COUNT(*) n FROM mail_message_labels l JOIN mail_messages m ON m.id = l.message_id WHERE m.thread_id = ? AND l.label_id = 'UNREAD'")
      .get(threadId).n;
    const last = msgs.at(-1) ?? {};
    const people = [];
    for (const m of msgs) {
      const p = m.from_name || m.from_email;
      if (p && !people.includes(p)) people.push(p);
    }
    return {
      id: threadId,
      subject: msgs[0]?.subject ?? '',
      snippet: last.snippet ?? '',
      date: last.internal_date ?? 0,
      count: msgs.length,
      unread: unread > 0,
      starred: labels.includes('STARRED'),
      important: labels.includes('IMPORTANT'),
      hasAttachments: msgs.some((m) => m.has_attachments),
      labels,
      people,
      fromEmail: last.from_email,
      to: JSON.parse(last.to_json ?? '[]'),
    };
  }

  /** Önbellek penceresinin dışında kalan ve açılmamış mesajları siler. */
  prune(days) {
    const cutoff = Date.now() - days * 86400000;
    const ids = this.db.prepare('SELECT id FROM mail_messages WHERE internal_date < ? AND opened = 0').all(cutoff).map((r) => r.id);
    ids.forEach((id) => this.deleteMessage(id));
    return ids.length;
  }

  wipe() {
    transaction(this.db, () => {
      for (const t of ['mail_fts', 'mail_message_labels', 'mail_messages', 'mail_labels', 'mail_drafts', 'mail_sync_state']) {
        this.db.prepare(`DELETE FROM ${t}`).run();
      }
    });
  }

  // ---- taslaklar
  setDrafts(pairs) {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM mail_drafts').run();
      const ins = this.db.prepare('INSERT OR REPLACE INTO mail_drafts (draft_id, message_id) VALUES (?, ?)');
      pairs.forEach((d) => ins.run(d.id, d.message.id));
    });
  }
  draftIdFor(messageId) {
    return this.db.prepare('SELECT draft_id FROM mail_drafts WHERE message_id = ?').get(messageId)?.draft_id ?? null;
  }
}
