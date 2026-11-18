// Pratik (RFC 5322'nin yaygın alt kümesi) e-posta doğrulaması.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function normalizeEmail(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '') // görünmez karakterler (Excel'den kopyalamada sık görülür)
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^<(.*)>$/, '$1')
    .trim()
    .toLowerCase();
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Aynı posta kutusuna giden farklı yazımları tek anahtara indirger (mükerrer gönderim koruması).
 * Gmail noktaları ve "+etiket" kısmını yok sayar; googlemail.com = gmail.com.
 *   "A.li+teklif@GoogleMail.com" → "ali@gmail.com"
 * Diğer alan adlarında yalnızca küçük harf/boşluk normalleştirmesi yapılır (kurallar sağlayıcıya göre değişir).
 */
export function canonicalEmail(raw) {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  const domain = email.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return email;
  const local = email.slice(0, at).split('+')[0].replace(/\./g, '');
  return `${local}@gmail.com`;
}

/** Geçerliyse null, değilse hata kodunu döner. */
export function validateEmail(email) {
  if (!email) return 'empty';
  if (email.length > 254) return 'too_long';
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1 || email.indexOf('@') !== at) return 'invalid_format';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return 'invalid_format';
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return 'invalid_domain';
  if (!/^[a-z]{2,63}$/i.test(labels.at(-1)) && !/^xn--[a-z0-9-]+$/i.test(labels.at(-1))) return 'invalid_domain';
  return null;
}

/**
 * İçe aktarılan satırları doğrular, normalleştirir ve liste içi tekrarları ayıklar.
 * Boş satırlar atlanır, tekrarlar tutulmaz, geçersiz adresler raporlanmak üzere tutulur.
 */
export function processRows(rows, emailColumn) {
  const seen = new Set();
  const recipients = [];
  const stats = { total: rows.length, valid: 0, invalid: 0, duplicates: 0, empty: 0 };

  rows.forEach((row, i) => {
    const raw = row[emailColumn];
    const email = String(raw ?? '').trim();
    const norm = normalizeEmail(raw);
    if (!norm) {
      stats.empty++;
      return;
    }
    const error = validateEmail(norm);
    if (!error) {
      const key = canonicalEmail(norm);
      if (seen.has(key)) {
        stats.duplicates++;
        return;
      }
      seen.add(key);
      stats.valid++;
    } else {
      stats.invalid++;
    }
    recipients.push({ rowNo: i + 2, email, emailNorm: norm, data: row, valid: !error, invalidReason: error });
  });

  return { recipients, stats };
}
