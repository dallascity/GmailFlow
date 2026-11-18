import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { convert } from 'html-to-text';
import { AppError } from '../lib/errors.js';

export const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024; // Gmail ek sınırı
export const MAX_MESSAGE_BYTES = 35 * 1024 * 1024; // Gmail API upload sınırı

export function htmlToText(html) {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  });
}

/** E-posta gövdesini, istemcilerde tutarlı görünmesi için basit bir HTML belgesine sarar. */
export function wrapHtml(inner) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:16px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328">`
    + `${inner}</body></html>`;
}

/**
 * RFC 5322 mesajı üretir. Her mesajın yalnızca TEK bir alıcısı vardır (To);
 * CC/BCC hiçbir zaman kullanılmaz.
 */
export async function buildMessage({ from, to, subject, html, text, attachments = [], headers = {} }) {
  if (!to || Array.isArray(to) || String(to).includes(',')) throw new Error('Tek bir alıcı gerekli');
  const total = attachments.reduce((s, a) => s + (a.size ?? 0), 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw new AppError('attachments.too_large');

  const mail = new MailComposer({
    from,
    to,
    subject,
    text: html ? text ?? htmlToText(html) : text ?? '',
    html: html ? wrapHtml(html) : undefined,
    attachments: attachments.map((a) => ({ filename: a.filename, path: a.path, contentType: a.contentType })),
    headers,
    textEncoding: 'quoted-printable',
  });
  const raw = await new Promise((resolve, reject) => {
    mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
  if (raw.length > MAX_MESSAGE_BYTES) throw new AppError('attachments.too_large');
  return raw;
}

const fmtAddr = (a) => (typeof a === 'string' ? a : a.name ? { name: a.name, address: a.email } : a.email);

/**
 * Posta ekranından yazılan kişisel mailler için MIME (Kime/Cc/Bcc birden çok alıcı olabilir).
 * Kampanya gönderimleri bunu KULLANMAZ; onlar tek alıcılı buildMessage ile üretilir.
 * attachments: { filename, contentType, path? , content? (Buffer) }
 */
export async function buildMailMessage({ from, to = [], cc = [], bcc = [], subject, html, text, attachments = [], inReplyTo, references }) {
  const total = attachments.reduce((s, a) => s + (a.size ?? a.content?.length ?? 0), 0);
  if (total > MAX_ATTACHMENTS_BYTES) throw new AppError('attachments.too_large');
  const mail = new MailComposer({
    from,
    to: to.map(fmtAddr),
    cc: cc.length ? cc.map(fmtAddr) : undefined,
    bcc: bcc.length ? bcc.map(fmtAddr) : undefined,
    subject,
    text: html ? text ?? htmlToText(html) : text ?? '',
    html: html ? wrapHtml(html) : undefined,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    attachments: attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, ...(a.content ? { content: a.content } : { path: a.path }) })),
    textEncoding: 'quoted-printable',
  });
  const node = mail.compile();
  node.keepBcc = true; // Gmail API alıcıları ham başlıklardan okur ve Bcc'yi kendisi gizler
  const raw = await new Promise((resolve, reject) => node.build((err, msg) => (err ? reject(err) : resolve(msg))));
  if (raw.length > MAX_MESSAGE_BYTES) throw new AppError('attachments.too_large');
  return raw;
}
