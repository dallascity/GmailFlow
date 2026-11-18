/**
 * Basit şablon motoru:  {{ad}}  ·  {{sirket|Değerli müşterimiz}}
 * Sütun adları değişken anahtarlarına çevrilir: "Şirket Adı" → "sirket_adi".
 */
const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };

export function toVariableKey(column) {
  const key = String(column)
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (ch) => TR_MAP[ch])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'alan';
}

/** Sütun listesinden { key → sütun } eşlemesi üretir (çakışmalarda _2, _3 eklenir). */
export function buildVariableMap(columns) {
  const map = {};
  for (const col of columns) {
    let key = toVariableKey(col);
    let n = 2;
    while (map[key] && map[key] !== col) key = `${toVariableKey(col)}_${n++}`;
    map[key] = col;
  }
  return map;
}

const TAG_RE = /\{\{\s*([\p{L}\p{N}_.-]+)\s*(?:\|([^}]*))?\}\}/gu;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Şablondaki değişken adlarını döner. */
export function findVariables(template) {
  const out = new Set();
  for (const m of String(template ?? '').matchAll(TAG_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

/**
 * @param {string} template
 * @param {Record<string,string>} values  key → değer (anahtarlar küçük harf)
 * @param {{ html?: boolean }} opts  html=true ise değerler HTML-escape edilir
 * @returns {{ output: string, missing: string[] }}
 */
export function render(template, values, { html = false } = {}) {
  const missing = new Set();
  const output = String(template ?? '').replace(TAG_RE, (_, name, fallback) => {
    const key = name.toLowerCase();
    let v = values[key];
    if (v == null || String(v).trim() === '') {
      if (fallback != null) v = fallback.trim();
      else {
        missing.add(key);
        v = '';
      }
    }
    v = String(v);
    return html ? escapeHtml(v) : v;
  });
  return { output, missing: [...missing] };
}

/** Bir alıcının satır verisinden şablon değerlerini hazırlar. */
export function valuesForRecipient(columns, data, email) {
  const map = buildVariableMap(columns);
  const values = {};
  for (const [key, col] of Object.entries(map)) values[key] = data?.[col] ?? '';
  values.email ??= email;
  values.eposta ??= email;
  return values;
}
