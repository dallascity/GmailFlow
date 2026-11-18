// db/index.js → migrations.js → bu modül zinciri döngüye girmesin diye nowIso burada tanımlı.
const nowIso = () => new Date().toISOString();

/**
 * "Kayıtlı mailler": içe aktarılan veya elle eklenen tüm geçerli adreslerin kalıcı defteri.
 * Listeler silinse de adresler burada kalır. Gönderim istatistikleri sends tablosundan hesaplanır.
 */

const NAME_EXACT = /^(ad[ı]?\s*soyad[ı]?|ad[-_ ]soyad|isim|isim\s*soyisim|ad|adı|name|full\s*name|contact\s*name|kişi|yetkili)$/i;
const NAME_LOOSE = /(ad\s*soyad|isim|name|yetkili)/i;

export function guessNameColumn(columns, emailColumn) {
  const candidates = columns.filter((c) => c !== emailColumn);
  // "İsim" / "ISIM" gibi Türkçe büyük harfler /i ile eşleşmez → iki farklı küçültmeyle denenir.
  const forms = (c) => [c.trim().toLocaleLowerCase('tr'), c.trim().toLowerCase()];
  return (
    candidates.find((c) => forms(c).some((f) => NAME_EXACT.test(f))) ??
    candidates.find((c) => forms(c).some((f) => NAME_LOOSE.test(f))) ??
    null
  );
}

const nonEmpty = (obj) => Object.fromEntries(Object.entries(obj ?? {}).filter(([, v]) => String(v ?? '').trim() !== ''));

/**
 * Adresleri deftere ekler veya günceller (aynı adres tekrar gelirse verisi birleştirilir).
 * @param {{ email: string, emailNorm: string, data?: object }[]} items
 * @returns {{ inserted: number, updated: number }}
 */
export function upsertContacts(db, items, { emailColumn = null, columns = [], source = 'import' } = {}) {
  const nameCol = columns.length ? guessNameColumn(columns, emailColumn) : null;
  const get = db.prepare('SELECT id, name, name_locked, data_json FROM contacts WHERE email_norm = ?');
  const ins = db.prepare(
    'INSERT INTO contacts (email, email_norm, name, data_json, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const upd = db.prepare('UPDATE contacts SET name = ?, data_json = ?, updated_at = ? WHERE id = ?');
  const now = nowIso();
  let inserted = 0;
  let updated = 0;
  for (const it of items) {
    const data = { ...nonEmpty(it.data) };
    if (emailColumn) delete data[emailColumn];
    const name = (nameCol && String(it.data?.[nameCol] ?? '').trim()) || null;
    const row = get.get(it.emailNorm);
    if (!row) {
      ins.run(it.email.trim(), it.emailNorm, name, JSON.stringify(data), source, now, now);
      inserted++;
    } else {
      const merged = { ...JSON.parse(row.data_json), ...data };
      const nextName = row.name_locked ? row.name : name || row.name;
      upd.run(nextName, JSON.stringify(merged), now, row.id);
      updated++;
    }
  }
  return { inserted, updated };
}

/**
 * Filtre → SQL WHERE. Filtre: { q, status: all|never_sent|sent|failed, listId }
 */
export function contactWhere(filter = {}) {
  const where = [];
  const args = [];
  const q = String(filter.q ?? '').trim().toLowerCase();
  if (q) {
    where.push('(c.email_norm LIKE ? OR LOWER(COALESCE(c.name, \'\')) LIKE ? OR LOWER(c.data_json) LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sentExists = "EXISTS (SELECT 1 FROM sends s WHERE s.email_norm = c.email_norm AND s.status = 'sent')";
  if (filter.status === 'never_sent') where.push(`NOT ${sentExists}`);
  if (filter.status === 'sent') where.push(sentExists);
  if (filter.status === 'failed') where.push("EXISTS (SELECT 1 FROM sends s WHERE s.email_norm = c.email_norm AND s.status = 'failed')");
  if (filter.status === 'replied') where.push('c.replied_at IS NOT NULL');
  if (filter.status === 'bounced') where.push('c.bounced_at IS NOT NULL');
  if (filter.status === 'unsubscribed') where.push('c.unsubscribed_at IS NOT NULL');
  if (filter.status === 'suppressed') where.push('c.suppressed IS NOT NULL');
  if (filter.listId) {
    where.push('EXISTS (SELECT 1 FROM recipients r WHERE r.email_norm = c.email_norm AND r.list_id = ? AND r.valid = 1)');
    args.push(Number(filter.listId));
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export const CONTACT_SELECT = `
  SELECT c.id, c.email, c.email_norm, c.name, c.data_json, c.source, c.created_at,
    c.replied_at, c.bounced_at, c.unsubscribed_at, c.suppressed,
    (SELECT COUNT(*) FROM sends s WHERE s.email_norm = c.email_norm AND s.status = 'sent') sent_count,
    (SELECT MAX(s.sent_at) FROM sends s WHERE s.email_norm = c.email_norm AND s.status = 'sent') last_sent_at,
    (SELECT COUNT(*) FROM sends s WHERE s.email_norm = c.email_norm AND s.status = 'failed') failed_count,
    (SELECT json_group_array(json_object('id', l.id, 'name', l.name))
       FROM recipients r JOIN lists l ON l.id = r.list_id
      WHERE r.email_norm = c.email_norm AND r.valid = 1) lists_json
  FROM contacts c`;

export function serializeContact(r) {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    data: JSON.parse(r.data_json),
    source: r.source,
    created_at: r.created_at,
    sent_count: r.sent_count,
    last_sent_at: r.last_sent_at,
    failed_count: r.failed_count,
    lists: JSON.parse(r.lists_json ?? '[]'),
    replied_at: r.replied_at,
    bounced_at: r.bounced_at,
    unsubscribed_at: r.unsubscribed_at,
    suppressed: r.suppressed,
  };
}
