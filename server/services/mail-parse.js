import iconv from 'iconv-lite';

/**
 * Gmail API `users.messages.get` yanıtını (format=full veya metadata) düz bir yapıya çevirir.
 */

const fromB64url = (s) => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function charsetOf(contentType) {
  const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '');
  return m ? m[1].toLowerCase() : 'utf-8';
}

/**
 * Gövde baytlarını metne çevirir. Gmail bazı mesajları zaten UTF-8'e dönüştürülmüş verir; bu yüzden
 * bildirilen karakter seti UTF-8 dışıysa ama baytlar geçerli UTF-8 ise UTF-8 kabul edilir.
 */
export function decodeBody(buf, charset = 'utf-8') {
  const cs = charset.toLowerCase().replace(/^(x-|cp)/, (m) => (m === 'cp' ? 'cp' : ''));
  if (/^(utf-?8|us-ascii|ascii)$/.test(cs)) return buf.toString('utf8');
  try {
    const asUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (/[^\x00-\x7f]/.test(asUtf8)) return asUtf8;
  } catch {
    /* gerçekten başka bir karakter seti */
  }
  return iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString('latin1');
}

/** RFC 2047 kodlu kelimeleri çözer: =?UTF-8?B?...?= / =?ISO-8859-9?Q?...?= */
export function decodeWords(value) {
  if (!value || !value.includes('=?')) return value ?? '';
  return value
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, enc, text) => {
      try {
        const buf = enc.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        return iconv.encodingExists(cs) ? iconv.decode(buf, cs) : buf.toString('utf8');
      } catch {
        return text;
      }
    });
}

/** "Ali Veli" <ali@x.com>, b@y.com, Ayşe <ayse@z.com> → [{name, email}] (tırnak içindeki virgüllere dayanıklı) */
export function parseAddressList(value) {
  const out = [];
  if (!value) return out;
  let cur = '';
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const part = cur.trim();
    cur = '';
    if (!part) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(part);
    if (m) {
      const name = decodeWords(m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')).trim();
      out.push({ name: name || null, email: m[2].trim().toLowerCase() });
    } else if (part.includes('@')) {
      out.push({ name: null, email: part.replace(/^"|"$/g, '').trim().toLowerCase() });
    }
  };
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle++;
    if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) flush();
    else cur += ch;
  }
  flush();
  return out;
}

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function headerMap(headers = []) {
  const map = {};
  for (const h of headers) {
    const k = h.name.toLowerCase();
    if (!(k in map)) map[k] = h.value;
  }
  return map;
}

/**
 * @returns {{
 *  id, threadId, historyId, internalDate, labelIds, snippet, size,
 *  from, to, cc, bcc, replyTo, subject, messageIdHeader, inReplyTo, references, listUnsubscribe,
 *  text, html, attachments, deliveryStatus, failedRecipients, bodyFetched
 * }}
 */
export function parseGmailMessage(msg, { full = true } = {}) {
  const payload = msg.payload ?? {};
  const h = headerMap(payload.headers);
  const textParts = [];
  const htmlParts = [];
  const attachments = [];
  let deliveryStatus = null;

  const walk = (part) => {
    if (!part) return;
    const mime = (part.mimeType ?? '').toLowerCase();
    const ph = headerMap(part.headers);
    const filename = decodeWords(part.filename ?? '');
    const cid = (ph['content-id'] ?? '').replace(/^<|>$/g, '') || null;
    const disposition = (ph['content-disposition'] ?? '').toLowerCase();

    if (mime.startsWith('multipart/')) {
      (part.parts ?? []).forEach(walk);
      return;
    }
    if (mime === 'message/delivery-status' || mime === 'message/global-delivery-status') {
      if (part.body?.data) deliveryStatus = fromB64url(part.body.data).toString('utf8');
      return;
    }
    const isBodyText = (mime === 'text/plain' || mime === 'text/html') && !filename && !disposition.startsWith('attachment');
    if (isBodyText && part.body?.data) {
      const text = decodeBody(fromB64url(part.body.data), charsetOf(ph['content-type']));
      (mime === 'text/html' ? htmlParts : textParts).push(text);
      return;
    }
    if (part.body?.attachmentId || filename || (cid && part.body?.data)) {
      attachments.push({
        partId: part.partId,
        attachmentId: part.body?.attachmentId ?? null,
        filename: filename || (mime === 'message/rfc822' ? 'message.eml' : `ek-${part.partId}`),
        mimeType: mime || 'application/octet-stream',
        size: part.body?.size ?? 0,
        contentId: cid,
        inline: Boolean(cid) && !disposition.startsWith('attachment'),
        // Küçük satır içi parçalar doğrudan veri olarak gelebilir
        data: !part.body?.attachmentId && part.body?.data ? part.body.data : undefined,
      });
    }
    (part.parts ?? []).forEach(walk);
  };
  walk(payload);

  const failed = (h['x-failed-recipients'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    id: msg.id,
    threadId: msg.threadId,
    historyId: msg.historyId ?? null,
    internalDate: Number(msg.internalDate ?? Date.now()),
    labelIds: msg.labelIds ?? [],
    snippet: decodeEntities(msg.snippet),
    size: msg.sizeEstimate ?? 0,
    from: parseAddressList(h.from)[0] ?? { name: null, email: null },
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    bcc: parseAddressList(h.bcc),
    replyTo: parseAddressList(h['reply-to'])[0]?.email ?? null,
    subject: decodeWords(h.subject ?? '').replace(/[\r\n]+/g, ' '),
    messageIdHeader: h['message-id'] ?? null,
    inReplyTo: h['in-reply-to'] ?? null,
    references: h.references ?? null,
    listUnsubscribe: h['list-unsubscribe'] ?? null,
    text: textParts.length ? textParts.join('\n\n') : null,
    html: htmlParts.length ? htmlParts.join('<hr>') : null,
    attachments,
    deliveryStatus,
    failedRecipients: failed,
    bodyFetched: full,
  };
}

// ------------------------------------------------------------- gösterim
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Düz metni bağlantıları tıklanabilir, satır sonları korunmuş HTML'e çevirir. */
export function textToHtml(text) {
  const esc = escapeHtml(text ?? '');
  const linked = esc.replace(/\bhttps?:\/\/[^\s<>"]+/g, (u) => `<a href="${u}">${u}</a>`);
  return `<div style="white-space:pre-wrap;font-family:inherit">${linked}</div>`;
}

/**
 * E-posta HTML'ini sandbox iframe'de güvenle gösterilecek hale getirir:
 *  - betik / form / gömülü içerik kaldırılır (iframe zaten betikleri çalıştırmaz; ikinci savunma hattı)
 *  - cid: görseller verilen data URI'lerle değiştirilir
 *  - uzak görseller (izleme pikselleri dahil) izin verilmedikçe engellenir
 * @returns {{ html: string, blockedImages: number }}
 */
export function prepareDisplayHtml(html, { cidMap = {}, allowRemote = false } = {}) {
  let out = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|frameset|frame)[\s\S]*?(<\/\1\s*>|\/?>)/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');

  out = out.replace(/(["'(])cid:([^"')\s]+)/gi, (m, q, cid) => {
    const uri = cidMap[decodeURIComponent(cid)] ?? cidMap[cid];
    return uri ? `${q}${uri}` : m;
  });

  let blocked = 0;
  if (!allowRemote) {
    out = out.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["'])(https?:[^"']*)\2/gi, (_, pre) => {
      blocked++;
      return `<img${pre} data-gf-blocked="1" src=""`;
    });
    out = out.replace(/\s(srcset|background)\s*=\s*(["'])https?:[^"']*\2/gi, () => {
      blocked++;
      return '';
    });
    out = out.replace(/url\(\s*(["']?)https?:[^)]*\1\s*\)/gi, () => {
      blocked++;
      return 'none';
    });
  }

  const head =
    '<meta charset="utf-8"><base target="_blank">'
    + '<style>html,body{margin:0;padding:0}body{font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2328;word-wrap:break-word;padding:2px}'
    + 'img{max-width:100%;height:auto}img[data-gf-blocked]{display:none}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:2px solid #d0d7de;color:#57606a}'
    + 'pre{white-space:pre-wrap}html{overflow-y:hidden;overflow-x:auto}</style>';
  return { html: `<!doctype html><html><head>${head}</head><body>${out}</body></html>`, blockedImages: blocked };
}
