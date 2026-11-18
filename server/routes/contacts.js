import { transaction, nowIso } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { csvResponse } from '../lib/csv.js';
import { parsePastedEmails } from '../services/importer.js';
import { processRows } from '../services/validator.js';
import { upsertContacts, contactWhere, CONTACT_SELECT, serializeContact } from '../services/contacts.js';
import { appendRecipients, serializeList } from './lists.js';

const MAX_SELECTION = 50000;

export default async function contactRoutes(app) {
  const { db, settings, locale } = app.ctx;
  const tr = () => (settings.get('language') ?? (String(locale).startsWith('tr') ? 'tr' : 'en')) === 'tr';

  const filterFrom = (src = {}) => ({ q: src.q, status: src.status, listId: src.listId });

  /** İstekteki seçimi kişi kayıtlarına çevirir: ya açık id listesi ya da "filtreye uyan tümü". */
  function resolveSelection(body) {
    if (Array.isArray(body?.ids)) {
      const ids = body.ids.map(Number).filter(Number.isInteger).slice(0, MAX_SELECTION);
      if (!ids.length) throw new AppError('contacts.empty_selection');
      return db.prepare(`SELECT * FROM contacts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY email_norm`).all(JSON.stringify(ids));
    }
    if (body?.filter) {
      const { sql, args } = contactWhere(filterFrom(body.filter));
      return db.prepare(`SELECT c.* FROM contacts c ${sql} ORDER BY c.email_norm LIMIT ${MAX_SELECTION}`).all(...args);
    }
    throw new AppError('contacts.empty_selection');
  }

  app.get('/', async (req) => {
    const { offset = 0, limit = 100, sort = 'created' } = req.query;
    const { sql, args } = contactWhere(filterFrom(req.query));
    const order = { email: 'c.email_norm', name: "COALESCE(c.name, '') = '', c.name COLLATE NOCASE", created: 'c.id DESC', last_sent: 'last_sent_at IS NULL, last_sent_at DESC' }[sort] ?? 'c.id DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM contacts c ${sql}`).get(...args).n;
    const rows = db
      .prepare(`${CONTACT_SELECT} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, Math.min(500, Number(limit) || 100), Number(offset) || 0)
      .map(serializeContact);
    return { total, rows };
  });

  app.get('/stats', async () => {
    const one = (status) => {
      const { sql, args } = contactWhere({ status });
      return db.prepare(`SELECT COUNT(*) n FROM contacts c ${sql}`).get(...args).n;
    };
    return {
      total: one(),
      never_sent: one('never_sent'),
      sent: one('sent'),
      failed: one('failed'),
      replied: one('replied'),
      bounced: one('bounced'),
      unsubscribed: one('unsubscribed'),
      suppressed: one('suppressed'),
    };
  });

  // Elle / yapıştırarak deftere adres ekleme
  app.post('/', async (req) => {
    const parsed = parsePastedEmails(req.body?.text, 'email');
    const { recipients, stats } = processRows(parsed.rows, 'email');
    const valid = recipients.filter((r) => r.valid);
    const before = db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
    transaction(db, () => upsertContacts(db, valid, { emailColumn: 'email', columns: ['email'], source: 'manual' }));
    const added = db.prepare('SELECT COUNT(*) n FROM contacts').get().n - before;
    return { added, duplicates: stats.duplicates + (valid.length - added), invalid: stats.invalid };
  });

  app.patch('/:id', async (req) => {
    const c = db.prepare('SELECT id FROM contacts WHERE id = ?').get(Number(req.params.id));
    if (!c) throw new AppError('contacts.not_found', 404);
    const name = String(req.body?.name ?? '').trim() || null;
    db.prepare('UPDATE contacts SET name = ?, name_locked = 1, updated_at = ? WHERE id = ?').run(name, nowIso(), c.id);
    return serializeContact(db.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(c.id));
  });

  // Engelleme: engelli adreslere hiçbir kampanyada gönderim yapılmaz
  app.post('/suppress', async (req) => {
    const rows = resolveSelection(req.body);
    const stmt = db.prepare("UPDATE contacts SET suppressed = 'manual', updated_at = ? WHERE id = ? AND suppressed IS NULL");
    transaction(db, () => rows.forEach((r) => stmt.run(nowIso(), r.id)));
    return { count: rows.length };
  });

  app.post('/unsuppress', async (req) => {
    const rows = resolveSelection(req.body);
    const stmt = db.prepare('UPDATE contacts SET suppressed = NULL, updated_at = ? WHERE id = ?');
    transaction(db, () => rows.forEach((r) => stmt.run(nowIso(), r.id)));
    return { count: rows.length };
  });

  // Seçilenleri defterden siler (listeler ve gönderim geçmişi etkilenmez)
  app.post('/delete', async (req) => {
    const rows = resolveSelection(req.body);
    const del = db.prepare('DELETE FROM contacts WHERE id = ?');
    transaction(db, () => rows.forEach((r) => del.run(r.id)));
    return { deleted: rows.length };
  });

  // Seçilenlerden yeni liste oluşturur ya da var olan listeye ekler
  app.post('/to-list', async (req) => {
    const rows = resolveSelection(req.body);
    if (!rows.length) throw new AppError('contacts.empty_selection');
    const emailCol = tr() ? 'E-posta' : 'Email';
    const nameCol = tr() ? 'Ad Soyad' : 'Name';

    const toRecipient = (c) => {
      const data = JSON.parse(c.data_json);
      if (c.name && !data[nameCol]) data[nameCol] = c.name;
      return { email: c.email, emailNorm: c.email_norm, data, valid: true, invalidReason: null };
    };

    if (req.body?.listId) {
      const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(req.body.listId));
      if (!list) throw new AppError('list.not_found', 404);
      const recips = rows.map(toRecipient);
      const res = transaction(db, () =>
        appendRecipients(db, list, recips, { total: recips.length, valid: recips.length, invalid: 0, duplicates: 0, empty: 0 }),
      );
      return { list: serializeList(db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id), db), ...res };
    }

    // Yeni liste: sütunlar = e-posta + ad + kişilerin verilerindeki diğer alanlar (sıklığa göre)
    const recips = rows.map(toRecipient);
    const freq = new Map();
    for (const r of recips) for (const k of Object.keys(r.data)) if (k !== emailCol) freq.set(k, (freq.get(k) ?? 0) + 1);
    const extra = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => k !== nameCol).slice(0, 30);
    const hasName = freq.has(nameCol);
    const columns = [emailCol, ...(hasName ? [nameCol] : []), ...extra];

    const name = String(req.body?.name ?? '').trim() || (tr() ? 'Kayıtlı maillerden liste' : 'List from saved addresses');
    const id = transaction(db, () => {
      const stats = { total: recips.length, valid: recips.length, invalid: 0, duplicates: 0, empty: 0 };
      const info = db
        .prepare('INSERT INTO lists (name, source_file, email_column, columns_json, stats_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, tr() ? 'Kayıtlı mailler' : 'Saved addresses', emailCol, JSON.stringify(columns), JSON.stringify(stats), nowIso());
      const listId = Number(info.lastInsertRowid);
      const ins = db.prepare('INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid) VALUES (?, ?, ?, ?, ?, 1)');
      recips.forEach((r, i) => {
        const data = Object.fromEntries(columns.map((c) => [c, c === emailCol ? r.email : (r.data[c] ?? '')]));
        ins.run(listId, i + 2, r.email, r.emailNorm, JSON.stringify(data));
      });
      return listId;
    });
    return { list: serializeList(db.prepare('SELECT * FROM lists WHERE id = ?').get(id), db), added: recips.length, duplicates: 0, invalid: 0 };
  });

  app.get('/export', async (req, reply) => {
    const { sql, args } = contactWhere(filterFrom(req.query));
    const rows = db.prepare(`${CONTACT_SELECT} ${sql} ORDER BY c.email_norm`).all(...args).map(serializeContact);
    const t = tr();
    return csvResponse(
      reply,
      t ? 'kayitli-mailler.csv' : 'saved-addresses.csv',
      t
        ? ['E-posta', 'Ad Soyad', 'Listeler', 'Gönderim sayısı', 'Son gönderim', 'Hatalı gönderim', 'Eklenme']
        : ['Email', 'Name', 'Lists', 'Sent count', 'Last sent', 'Failed sends', 'Added'],
      rows.map((r) => [r.email, r.name ?? '', r.lists.map((l) => l.name).join(', '), r.sent_count, r.last_sent_at ?? '', r.failed_count, r.created_at]),
    );
  });
}
