import { i18n } from '../i18n/index.js';

const loc = () => (i18n.global.locale.value === 'tr' ? 'tr-TR' : 'en-GB');

/** Liste tarihi: bugünse saat, bu yılsa gün+ay, değilse tam tarih (Gmail gibi). */
export function fmtMailDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(loc(), { hour: '2-digit', minute: '2-digit' }).format(d);
  if (d.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(loc(), { day: 'numeric', month: 'short' }).format(d);
  return new Intl.DateTimeFormat(loc(), { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function fmtMailDateLong(ms) {
  return new Intl.DateTimeFormat(loc(), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export const addrLabel = (a) => (a?.name ? a.name : a?.email ?? '');
export const addrFull = (a) => (a?.name ? `${a.name} <${a.email}>` : a?.email ?? '');

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Görüntülenen e-posta belgesinin <body> içeriği (alıntı için). */
export const bodyInner = (html) => /<body[^>]*>([\s\S]*)<\/body>/i.exec(html ?? '')?.[1] ?? html ?? '';

/**
 * Yanıtla / tümünü yanıtla / ilet için oluşturucu başlangıç verisi.
 * Alıntı (quoteHtml) düzenleyicinin dışında tutulur; böylece biçimi bozulmadan eklenir.
 */
export function buildReplyInit(msg, mode, me) {
  const t = i18n.global.t;
  const meL = (me ?? '').toLowerCase();
  const base = { mode };
  if (mode === 'forward') {
    base.subject = /^(fwd?|ilt|ileti):/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`;
    base.quoteHtml =
      `<p>${escapeHtml(t('mail.composer.forwardedHeader'))}<br>`
      + `${escapeHtml(t('mail.composer.from'))}: ${escapeHtml(addrFull(msg.from))}<br>`
      + `${escapeHtml(t('mail.composer.date'))}: ${escapeHtml(fmtMailDateLong(msg.date))}<br>`
      + `${escapeHtml(t('mail.composer.subject'))}: ${escapeHtml(msg.subject)}<br>`
      + `${escapeHtml(t('mail.to'))}: ${escapeHtml(msg.to.map(addrFull).join(', '))}</p>`
      + bodyInner(msg.html);
    base.forward = msg.attachments
      .filter((a) => a.attachmentId)
      .map((a) => ({ messageId: msg.id, attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, size: a.size }));
    return base;
  }
  const fromMe = msg.from?.email === meL;
  const primary = fromMe ? msg.to : [msg.replyTo ? { email: msg.replyTo, name: null } : msg.from];
  base.to = primary.filter((a) => a?.email);
  if (mode === 'replyAll') {
    const seen = new Set([meL, ...base.to.map((a) => a.email)]);
    base.cc = [...msg.to, ...msg.cc].filter((a) => a?.email && !seen.has(a.email) && seen.add(a.email));
  }
  base.subject = /^(re|ynt|cvp):/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`;
  base.threadId = msg.threadId;
  base.inReplyTo = msg.messageIdHeader;
  base.references = [msg.references, msg.messageIdHeader].filter(Boolean).join(' ');
  base.quoteHtml = `<p>${escapeHtml(t('mail.composer.wrote', { date: fmtMailDateLong(msg.date), from: addrFull(msg.from) }))}</p><blockquote>${bodyInner(msg.html)}</blockquote>`;
  return base;
}
