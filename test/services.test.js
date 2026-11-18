import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import { normalizeEmail, validateEmail, processRows } from '../server/services/validator.js';
import { parseFile, guessEmailColumn, parsePastedEmails } from '../server/services/importer.js';
import { render, toVariableKey, buildVariableMap, findVariables } from '../server/services/template.js';
import { buildMessage } from '../server/services/mime.js';
import { classifyError } from '../server/services/gmail.js';

describe('validator', () => {
  it('normalizes', () => {
    expect(normalizeEmail('  Ali@Example.COM ')).toBe('ali@example.com');
    expect(normalizeEmail('mailto:a@b.co')).toBe('a@b.co');
    expect(normalizeEmail('<a@b.co>')).toBe('a@b.co');
    expect(normalizeEmail('a@b.co​')).toBe('a@b.co');
  });
  it('validates', () => {
    for (const ok of ['a@b.co', 'first.last+tag@sub.example.com.tr', 'x_y@xn--mnchen-3ya.de']) expect(validateEmail(ok)).toBeNull();
    for (const bad of ['', 'a', 'a@', '@b.co', 'a@b', 'a..b@c.com', 'a@b..com', 'a@-b.com', 'a b@c.com', 'a@b.c', 'a@@b.com']) {
      expect(validateEmail(normalizeEmail(bad)), bad).not.toBeNull();
    }
  });
  it('dedupes and counts', () => {
    const rows = [{ e: 'a@b.co' }, { e: 'A@B.CO ' }, { e: 'bad' }, { e: '' }, { e: 'c@d.co' }];
    const { recipients, stats } = processRows(rows, 'e');
    expect(stats).toEqual({ total: 5, valid: 2, invalid: 1, duplicates: 1, empty: 1 });
    expect(recipients.filter((r) => r.valid).map((r) => r.emailNorm)).toEqual(['a@b.co', 'c@d.co']);
  });
});

describe('importer', () => {
  it('reads ; CSV with UTF-8 BOM', async () => {
    const buf = Buffer.from('﻿Ad;E-posta\nŞule;sule@ornek.com\n', 'utf8');
    const r = await parseFile(buf, 'x.csv');
    expect(r.columns).toEqual(['Ad', 'E-posta']);
    expect(r.rows[0]).toEqual({ Ad: 'Şule', 'E-posta': 'sule@ornek.com' });
  });
  it('reads , CSV in windows-1254', async () => {
    const buf = iconv.encode('İsim,Mail\nGüneş Çağ,g@x.com\n', 'win1254');
    const r = await parseFile(buf, 'x.csv');
    expect(r.columns).toEqual(['İsim', 'Mail']);
    expect(r.rows[0]['İsim']).toBe('Güneş Çağ');
    expect(guessEmailColumn(r.columns, r.rows)).toBe('Mail');
  });
  it('detects headerless files', async () => {
    const r = await parseFile(Buffer.from('a@b.co;Ali\nc@d.co;Veli\n'), 'x.csv');
    expect(r.hasHeader).toBe(false);
    expect(r.rows).toHaveLength(2);
    expect(guessEmailColumn(r.columns, r.rows)).toBe(r.columns[0]);
  });
  it('reads xlsx incl. hyperlink and formula cells', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Firma', 'Email']);
    ws.addRow(['ACME', { text: 'x@acme.com', hyperlink: 'mailto:x@acme.com' }]);
    ws.addRow([{ formula: '"Be"&"ta"', result: 'Beta' }, 'y@beta.com']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await parseFile(buf, 'l.xlsx');
    expect(r.rows).toEqual([
      { Firma: 'ACME', Email: 'x@acme.com' },
      { Firma: 'Beta', Email: 'y@beta.com' },
    ]);
  });
  it('parses pasted addresses with any separator', () => {
    const emails = (txt) => parsePastedEmails(txt, 'E').rows.map((r) => r.E);
    expect(emails('a@gmail.com,b@gmail.com')).toEqual(['a@gmail.com', 'b@gmail.com']);
    expect(emails('a@gmail.com:b@gmail.com:')).toEqual(['a@gmail.com', 'b@gmail.com']);
    expect(emails('a@x.com; b@y.com\nc@z.com\td@w.com | e@v.com')).toHaveLength(5);
    expect(emails('Ali Veli <ali@x.com>, mailto:veli@y.com. not-an-email')).toEqual(['ali@x.com', 'veli@y.com']);
    expect(() => parsePastedEmails('hiç adres yok', 'E')).toThrow();
  });
  it('rejects .xls', async () => {
    await expect(parseFile(Buffer.from('x'), 'a.xls')).rejects.toMatchObject({ code: 'import.xls_unsupported' });
  });
});

describe('template', () => {
  it('builds keys', () => {
    expect(toVariableKey('Şirket Adı')).toBe('sirket_adi');
    expect(toVariableKey('E-posta')).toBe('e_posta');
    expect(buildVariableMap(['Ad', 'ad'])).toEqual({ ad: 'Ad', ad_2: 'ad' });
  });
  it('renders with defaults and escaping', () => {
    const r = render('Merhaba {{ad}}, {{sirket|Değerli müşterimiz}} {{x}}', { ad: '<b>Ali</b>', sirket: '' }, { html: true });
    expect(r.output).toBe('Merhaba &lt;b&gt;Ali&lt;/b&gt;, Değerli müşterimiz ');
    expect(r.missing).toEqual(['x']);
    expect(findVariables('{{ Ad }} {{b|c}}')).toEqual(['ad', 'b']);
  });
});

describe('mime', () => {
  it('builds single-recipient UTF-8 message with attachment', async () => {
    const raw = (
      await buildMessage({
        from: 'me@gmail.com',
        to: 'ali@example.com',
        subject: 'Görüşme talebi – ŞİRKET',
        html: '<p>Merhaba</p>',
        attachments: [{ filename: 'teklif.pdf', path: new URL('./fixtures/sample.pdf', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), contentType: 'application/pdf', size: 10 }],
      })
    ).toString();
    expect(raw).toMatch(/^To: ali@example.com$/m);
    expect(raw).not.toMatch(/^(Cc|Bcc):/im);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('filename=teklif.pdf');
  });
  it('refuses multiple recipients and oversized attachments', async () => {
    await expect(buildMessage({ from: 'a@b.co', to: 'x@y.co, z@w.co', subject: 's', text: 't' })).rejects.toThrow();
    await expect(
      buildMessage({ from: 'a@b.co', to: 'x@y.co', subject: 's', text: 't', attachments: [{ filename: 'a', path: 'a', size: 26 * 1024 * 1024 }] }),
    ).rejects.toMatchObject({ code: 'attachments.too_large' });
  });
});

describe('gmail error classification', () => {
  const err = (status, reason, message = '') => classifyError(status, { error: { errors: [{ reason }], message } });
  it('classifies', () => {
    expect(err(400, 'invalidArgument', 'Invalid To header').kind).toBe('recipient');
    expect(err(401, 'authError').kind).toBe('auth');
    expect(err(429, 'rateLimitExceeded').kind).toBe('rate');
    expect(err(403, 'dailyLimitExceeded').kind).toBe('quota');
    const far = new Date(Date.now() + 3 * 3600e3).toISOString();
    expect(err(429, 'rateLimitExceeded', `User-rate limit exceeded.  Retry after ${far}`).kind).toBe('quota');
    expect(err(503, 'backendError').kind).toBe('transient');
  });
});
