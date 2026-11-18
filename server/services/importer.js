import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import iconv from 'iconv-lite';
import { AppError } from '../lib/errors.js';
import { normalizeEmail, validateEmail } from './validator.js';

export const MAX_ROWS = 50000;

/**
 * Excel (.xlsx) veya CSV dosyasını okur.
 * @returns {{ columns: string[], rows: Record<string,string>[], hasHeader: boolean }}
 */
export async function parseFile(buffer, filename, { columnLabel = 'Sütun' } = {}) {
  const ext = String(filename).toLowerCase().split('.').pop();
  let matrix;
  if (ext === 'xlsx') matrix = await readXlsx(buffer);
  else if (ext === 'csv' || ext === 'txt') matrix = readCsv(buffer);
  else if (ext === 'xls') throw new AppError('import.xls_unsupported');
  else throw new AppError('import.unsupported_type');

  matrix = matrix.filter((r) => r.some((c) => c !== ''));
  if (matrix.length === 0) throw new AppError('import.empty_file');

  // İlk satır e-posta adresi içeriyorsa başlık satırı yok kabul edilir.
  const hasHeader = !matrix[0].some((c) => !validateEmail(normalizeEmail(c)));
  const width = Math.max(...matrix.map((r) => r.length));
  const columns = makeColumnNames(hasHeader ? matrix[0] : [], width, columnLabel);
  const body = hasHeader ? matrix.slice(1) : matrix;
  if (body.length > MAX_ROWS) throw new AppError('import.too_many_rows', 400, { max: MAX_ROWS });

  const rows = body.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
  return { columns, rows, hasHeader };
}

function makeColumnNames(header, width, label) {
  const used = new Map();
  const names = [];
  for (let i = 0; i < width; i++) {
    let name = String(header[i] ?? '').trim() || `${label} ${i + 1}`;
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    names.push(name);
  }
  return names;
}

/**
 * Elle yazılan / yapıştırılan metinden e-posta adreslerini ayıklar.
 * Ayırıcı olarak virgül, noktalı virgül, iki nokta, boşluk, satır sonu, | ve <> kabul edilir:
 *   "a@x.com,b@y.com"   "a@x.com:b@y.com:"   "Ali <a@x.com>; b@y.com"
 * '@' içermeyen parçalar (isimler, "mailto" vb.) yok sayılır; geri kalanlar doğrulamaya gider.
 */
export function parsePastedEmails(text, columnName = 'E-posta') {
  const tokens = String(text ?? '')
    .split(/[\s,;:|<>"'()[\]]+/)
    .map((t) => t.trim().replace(/\.+$/, ''))
    .filter((t) => t.includes('@'));
  if (tokens.length === 0) throw new AppError('import.no_emails_in_text');
  if (tokens.length > MAX_ROWS) throw new AppError('import.too_many_rows', 400, { max: MAX_ROWS });
  return { columns: [columnName], rows: tokens.map((t) => ({ [columnName]: t })), hasHeader: true };
}

/** E-posta sütununu tahmin eder: önce başlık adına, sonra içeriğe bakar. */
export function guessEmailColumn(columns, rows) {
  const byName = columns.find((c) => /^(e-?posta|e-?mail|mail|email address|e-posta adresi|eposta adresi)$/i.test(c.trim()))
    ?? columns.find((c) => /(e-?posta|e-?mail|mail)/i.test(c));
  if (byName) return byName;
  const sample = rows.slice(0, 200);
  let best = columns[0];
  let bestScore = -1;
  for (const c of columns) {
    const score = sample.filter((r) => !validateEmail(normalizeEmail(r[c]))).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// ---------- XLSX ----------
async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new AppError('import.corrupt_file');
  }
  const ws = wb.worksheets.find((s) => s.actualRowCount > 0);
  if (!ws) throw new AppError('import.empty_file');
  const matrix = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const out = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      out[col - 1] = cellToString(cell.value);
    });
    for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = '';
    matrix.push(out);
  });
  return matrix;
}

function cellToString(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text.trim(); // hyperlink
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('').trim();
    if ('result' in v) return cellToString(v.result); // formül
    if ('hyperlink' in v) return String(v.hyperlink).replace(/^mailto:/i, '').trim();
    if ('error' in v) return '';
    return '';
  }
  return String(v).trim();
}

// ---------- CSV ----------
export function decodeText(buffer) {
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer.subarray(2), 'utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Türkçe Windows'ta Excel'in "CSV" kaydı genellikle Windows-1254 kodlamasıdır.
    return iconv.decode(buffer, 'win1254');
  }
}

function readCsv(buffer) {
  const text = decodeText(buffer);
  const res = Papa.parse(text, {
    header: false,
    skipEmptyLines: 'greedy',
    delimitersToGuess: [';', ',', '\t', '|'],
  });
  if (!res.data.length && res.errors.length) throw new AppError('import.corrupt_file');
  return res.data.map((r) => r.map((c) => String(c ?? '').trim()));
}
