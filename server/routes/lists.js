import crypto from 'node:crypto';
import { transaction, nowIso } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { parseFile, guessEmailColumn, parsePastedEmails } from '../services/importer.js';
import { processRows, canonicalEmail } from '../services/validator.js';
import { buildVariableMap } from '../services/template.js';
import { csvResponse } from '../lib/csv.js';
import { upsertContacts } from '../services/contacts.js';

const IMPORT_TTL_MS = 30 * 60 * 1000;

/**
 * Var olan listeye alıcı ekler (çağıran transaction içinde çalıştırmalıdır).
 * recipients: processRows çıktısı; `data` verilmezse yalnızca e-posta sütunu doldurulur.
 * Listede zaten bulunan geçerli adresler eklenmez.
 */
export function appendRecipients(db, list, recipients, stats) {
  const columns = JSON.parse(list.columns_json);
  const existing = new Set(
    db.prepare('SELECT email_norm FROM recipients WHERE list_id = ? AND valid = 1').all(list.id).map((r) => canonicalEmail(r.email_norm)),
  );
  let rowNo = db.prepare('SELECT COALESCE(MAX(row_no), 1) m FROM recipients WHERE list_id = ?').get(list.id).m;
  let added = 0;
  let duplicates = stats.duplicates;
  const ins = db.prepare(
    'INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid, invalid_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const r of recipients) {
    if (r.valid && existing.has(canonicalEmail(r.emailNorm))) {
      duplicates++;
      continue;
    }
    if (r.valid) existing.add(canonicalEmail(r.emailNorm));
    const data = Object.fromEntries(columns.map((c) => [c, c === list.email_column ? r.email : (r.data?.[c] ?? '')]));
    ins.run(list.id, ++rowNo, r.email, r.emailNorm, JSON.stringify(data), r.valid ? 1 : 0, r.invalidReason);
    if (r.valid) added++;
  }
  const s = JSON.parse(list.stats_json);
  const next = {
    total: s.total + stats.total,
    valid: s.valid + added,
    invalid: s.invalid + stats.invalid,
    duplicates: s.duplicates + duplicates,
    empty: s.empty,
  };
  db.prepare('UPDATE lists SET stats_json = ? WHERE id = ?').run(JSON.stringify(next), list.id);
  return { added, invalid: stats.invalid, duplicates };
}

export function serializeList(row, db) {
  const columns = JSON.parse(row.columns_json);
  return {
    id: row.id,
    name: row.name,
    source_file: row.source_file,
    email_column: row.email_column,
    columns,
    variables: buildVariableMap(columns),
    stats: JSON.parse(row.stats_json),
    created_at: row.created_at,
    campaign_count: db.prepare('SELECT COUNT(*) n FROM campaigns WHERE list_id = ?').get(row.id).n,
  };
}

export default async function listRoutes(app) {
  const { db, settings, locale } = app.ctx;
  const imports = new Map(); // geçici içe aktarma önizlemeleri

  const getList = (id) => {
    const row = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(id));
    if (!row) throw new AppError('list.not_found', 404);
    return row;
  };

  app.get('/', async () => db.prepare('SELECT * FROM lists ORDER BY id DESC').all().map((r) => serializeList(r, db)));

  app.get('/:id', async (req) => serializeList(getList(req.params.id), db));

  const lang = () => settings.get('language') ?? (String(locale).startsWith('tr') ? 'tr' : 'en');

  /** Ayrıştırılmış veriyi geçici olarak saklar ve önizleme yanıtını üretir. */
  function registerImport(parsed, filename) {
    const now = Date.now();
    for (const [k, v] of imports) if (now - v.created > IMPORT_TTL_MS) imports.delete(k);
    const importId = crypto.randomUUID();
    imports.set(importId, { ...parsed, filename, created: now });

    const emailColumn = guessEmailColumn(parsed.columns, parsed.rows);
    return {
      importId,
      filename,
      columns: parsed.columns,
      hasHeader: parsed.hasHeader,
      emailColumn,
      rowCount: parsed.rows.length,
      sample: parsed.rows.slice(0, 15),
      preview: processRows(parsed.rows, emailColumn).stats,
    };
  }

  // 1. adım (dosya): dosyayı oku, sütunları ve önizlemeyi döndür
  app.post('/import', async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('import.no_file');
    const buffer = await file.toBuffer();
    const parsed = await parseFile(buffer, file.filename, { columnLabel: lang() === 'tr' ? 'Sütun' : 'Column' });
    return registerImport(parsed, file.filename);
  });

  // 1. adım (elle / yapıştır): "a@x.com, b@y.com" veya "a@x.com:b@y.com:" gibi metinler
  app.post('/paste', async (req) => {
    const tr = lang() === 'tr';
    const parsed = parsePastedEmails(req.body?.text, tr ? 'E-posta' : 'Email');
    const d = new Date();
    const stamp = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    return registerImport(parsed, `${tr ? 'Elle eklenen liste' : 'Pasted list'} ${stamp}`);
  });

  // Seçilen e-posta sütunu değişince istatistikleri yeniden hesapla
  app.post('/import/:importId/analyze', async (req) => {
    const imp = imports.get(req.params.importId);
    if (!imp) throw new AppError('import.expired');
    const col = req.body?.emailColumn;
    if (!imp.columns.includes(col)) throw new AppError('import.invalid_column');
    return processRows(imp.rows, col).stats;
  });

  // 2. adım: listeyi kaydet
  app.post('/', async (req) => {
    const { importId, name, emailColumn } = req.body ?? {};
    const imp = imports.get(importId);
    if (!imp) throw new AppError('import.expired');
    if (!imp.columns.includes(emailColumn)) throw new AppError('import.invalid_column');
    const listName = String(name ?? '').trim() || imp.filename.replace(/\.[^.]+$/, '');
    const { recipients, stats } = processRows(imp.rows, emailColumn);
    if (stats.valid === 0) throw new AppError('import.no_valid_emails');

    const id = transaction(db, () => {
      const info = db
        .prepare('INSERT INTO lists (name, source_file, email_column, columns_json, stats_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(listName, imp.filename, emailColumn, JSON.stringify(imp.columns), JSON.stringify(stats), nowIso());
      const listId = Number(info.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid, invalid_reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of recipients) {
        ins.run(listId, r.rowNo, r.email, r.emailNorm, JSON.stringify(r.data), r.valid ? 1 : 0, r.invalidReason);
      }
      upsertContacts(db, recipients.filter((r) => r.valid), { emailColumn, columns: imp.columns });
      return listId;
    });
    imports.delete(importId);
    return serializeList(getList(id), db);
  });

  app.patch('/:id', async (req) => {
    const list = getList(req.params.id);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new AppError('validation');
    db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(name, list.id);
    return serializeList(getList(list.id), db);
  });

  // Var olan listeye elle / yapıştırarak adres ekleme
  app.post('/:id/recipients', async (req) => {
    const list = getList(req.params.id);
    const parsed = parsePastedEmails(req.body?.text, list.email_column);
    const { recipients, stats } = processRows(parsed.rows, list.email_column);
    const r = transaction(db, () => {
      const res = appendRecipients(db, list, recipients, stats);
      upsertContacts(db, recipients.filter((x) => x.valid), { emailColumn: list.email_column, columns: [list.email_column], source: 'manual' });
      return res;
    });
    return { list: serializeList(getList(list.id), db), ...r };
  });

  app.get('/:id/recipients', async (req) => {
    const list = getList(req.params.id);
    const { valid = '1', q = '', offset = 0, limit = 100 } = req.query;
    const where = ['list_id = ?', 'valid = ?'];
    const args = [list.id, valid === '0' ? 0 : 1];
    if (q) {
      where.push('(email_norm LIKE ? OR data_json LIKE ?)');
      args.push(`%${String(q).toLowerCase()}%`, `%${q}%`);
    }
    const sql = `FROM recipients WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${sql}`).get(...args).n;
    const rows = db
      .prepare(`SELECT id, row_no, email, data_json, invalid_reason ${sql} ORDER BY row_no LIMIT ? OFFSET ?`)
      .all(...args, Math.min(500, Number(limit) || 100), Number(offset) || 0)
      .map((r) => ({ id: r.id, row_no: r.row_no, email: r.email, data: JSON.parse(r.data_json), invalid_reason: r.invalid_reason }));
    return { total, rows };
  });

  app.get('/:id/export', async (req, reply) => {
    const list = getList(req.params.id);
    const valid = req.query.valid === '1' ? 1 : 0;
    const columns = JSON.parse(list.columns_json);
    const rows = db.prepare('SELECT data_json, invalid_reason FROM recipients WHERE list_id = ? AND valid = ? ORDER BY row_no').all(list.id, valid);
    const header = valid ? columns : [...columns, 'Hata / Error'];
    const data = rows.map((r) => {
      const d = JSON.parse(r.data_json);
      const out = columns.map((c) => d[c] ?? '');
      if (!valid) out.push(r.invalid_reason);
      return out;
    });
    return csvResponse(reply, `${list.name}-${valid ? 'gecerli' : 'gecersiz'}.csv`, header, data);
  });

  app.delete('/:id', async (req) => {
    const list = getList(req.params.id);
    const used = db.prepare("SELECT COUNT(*) n FROM campaigns WHERE list_id = ? AND status IN ('running','paused')").get(list.id).n;
    if (used) throw new AppError('list.in_use');
    db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
    return { ok: true };
  });
}
