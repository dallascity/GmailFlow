import { upsertContacts } from './contacts.js';

const nowIso = () => new Date().toISOString();

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon)@/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliver(ed|able)|delivery (has )?failed|delivery failure|mail delivery (failed|subsystem)|returned mail|address not found|teslim edilemedi|iletilemedi|adres bulunamad)/i;
const PERMANENT_TEXT = /(does ?n[o']t exist|couldn't be found|could not be found|no such user|user unknown|unknown user|address not found|mailbox (unavailable|not found)|recipient address rejected|invalid recipient|adres bulunamad|hesap mevcut de[gğ]il|b[öo]yle bir kullan[ıi]c[ıi] yok)/i;

// TR/EN abonelikten çıkma ifadeleri (yanıtın alıntı dışındaki ilk kısmında aranır)
export const UNSUBSCRIBE_RE =
  /(unsubscribe|remove me|take me off|stop (sending|emailing)|opt[ -]?out|listeden [çc][ıi]kar|abonelikten [çc][ıi]k|aboneli[gğ]imi iptal|beni [çc][ıi]kar|(mail|e-?posta|ileti)(ler)?\s*(atmay[ıi]n|g[öo]ndermeyin|istemiyorum)|bir daha (mail|e-?posta) (atmay[ıi]n|g[öo]ndermeyin))/i;

const htmlToPlain = (html) =>
  String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');

/** Yanıttaki alıntılanmış (önceki) metni atar; yalnızca kişinin yeni yazdığı kısım kalır. */
export function stripQuoted(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*On .+wrote:\s*$/i.test(line) || /tarihinde .+(yazdı|şunu yazdı):\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*(Original Message|Orijinal ileti|Özgün ileti)/i.test(line)) break;
    if (/^\s*(From|Kimden):\s/i.test(line) && out.length) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Bounce mesajından kalıcı olarak başarısız olan alıcıları ve nedeni çıkarır. */
export function parseBounce({ failedRecipients = [], deliveryStatus = '', text = '' }) {
  const recipients = new Set(failedRecipients.map((s) => s.toLowerCase()));
  for (const m of String(deliveryStatus).matchAll(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/gi)) recipients.add(m[1].toLowerCase());
  const statusMatch = /Status:\s*([245])\.\d{1,3}\.\d{1,3}/i.exec(deliveryStatus) ?? /\b([45])\.\d\.\d{1,3}\b/.exec(text);
  const code = statusMatch ? statusMatch[1] : null;
  const diag = /Diagnostic-Code:\s*(.+)/i.exec(deliveryStatus)?.[1] ?? text.split('\n').find((l) => PERMANENT_TEXT.test(l) || /\b[45]\.\d\.\d/.test(l)) ?? '';
  const permanent = code === '5' || (code == null && PERMANENT_TEXT.test(`${deliveryStatus}\n${text}`));
  return { recipients: [...recipients], permanent, temporary: code === '4', reason: diag.trim().slice(0, 300) };
}

/**
 * Senkronizasyonla gelen her mesajı bir kez işler; kampanya gönderimleriyle eşleştirir.
 */
export class Tracking {
  constructor({ db, store, me, log = () => {}, emit = () => {} }) {
    this.db = db;
    this.store = store;
    this.me = me;
    this.log = log;
    this.emit = emit;
  }

  process(messageId) {
    const m = this.store.message(messageId);
    if (!m || m.tracked || !m.body_fetched) return null;
    let result = null;
    try {
      result = this.#process(m);
    } finally {
      this.db.prepare('UPDATE mail_messages SET tracked = 1 WHERE id = ?').run(m.id);
    }
    if (result) this.emit({ type: 'tracking', ...result });
    return result;
  }

  #process(m) {
    const me = (this.me() ?? '').toLowerCase();
    if (m.from_email && m.from_email === me) return null;
    const text = m.body_text || htmlToPlain(m.body_html);

    if (BOUNCE_FROM.test(m.from_email ?? '') || BOUNCE_SUBJECT.test(m.subject)) {
      return this.#bounce(m, text);
    }

    const send = this.db.prepare("SELECT * FROM sends WHERE gmail_thread_id = ? AND status = 'sent' LIMIT 1").get(m.thread_id);
    const subjectUnsub = /^\s*(unsubscribe|abonelikten [çc][ıi]k)/i.test(m.subject ?? '');

    if (send) {
      const at = new Date(m.internal_date).toISOString();
      if (!send.replied_at) {
        this.db.prepare('UPDATE sends SET replied_at = ? WHERE id = ?').run(at, send.id);
        this.#contact(send.email, send.email_norm, { replied_at: at });
        this.log('info', send.campaign_id, 'tracking.replied', send.email);
      }
      const fresh = stripQuoted(text).slice(0, 800);
      if (subjectUnsub || UNSUBSCRIBE_RE.test(fresh)) {
        this.#unsubscribe(send.email, send.email_norm, send.campaign_id);
        return { kind: 'unsubscribed', email: send.email_norm, campaignId: send.campaign_id };
      }
      return { kind: 'replied', email: send.email_norm, campaignId: send.campaign_id };
    }

    // List-Unsubscribe (mailto) ile gelen "unsubscribe" konulu mailler
    if (subjectUnsub && m.from_email) {
      const known =
        this.db.prepare('SELECT 1 FROM contacts WHERE email_norm = ?').get(m.from_email) ??
        this.db.prepare("SELECT 1 FROM sends WHERE email_norm = ? AND status = 'sent'").get(m.from_email);
      if (known) {
        this.#unsubscribe(m.from_email, m.from_email, null);
        return { kind: 'unsubscribed', email: m.from_email };
      }
    }
    return null;
  }

  #bounce(m, text) {
    const b = parseBounce({ failedRecipients: JSON.parse(m.failed_recipients ?? '[]'), deliveryStatus: m.delivery_status ?? '', text });
    let recipients = b.recipients;
    if (!recipients.length) {
      // Gmail bounce'ları özgün mesajla aynı konuşmaya koyar → o konuşmanın alıcısı
      recipients = this.db.prepare('SELECT email_norm FROM sends WHERE gmail_thread_id = ?').all(m.thread_id).map((r) => r.email_norm);
    }
    if (!b.permanent) {
      if (recipients.length) this.log('info', null, 'tracking.bounce_temporary', recipients.join(', '));
      return null;
    }
    const at = new Date(m.internal_date).toISOString();
    const since = new Date(m.internal_date - 30 * 86400000).toISOString();
    const hits = [];
    for (const email of recipients) {
      const send = this.db
        .prepare(
          `SELECT * FROM sends WHERE email_norm = ? AND status = 'sent' AND sent_at >= ?
           ORDER BY (gmail_thread_id = ?) DESC, sent_at DESC LIMIT 1`,
        )
        .get(email, since, m.thread_id);
      if (send && !send.bounced_at) {
        this.db.prepare('UPDATE sends SET bounced_at = ?, bounce_reason = ? WHERE id = ?').run(at, b.reason || null, send.id);
      }
      this.#contact(send?.email ?? email, email, { bounced_at: at }, 'bounced');
      this.log('warn', send?.campaign_id ?? null, 'tracking.bounced', `${email}${b.reason ? ` — ${b.reason}` : ''}`);
      hits.push(email);
    }
    return hits.length ? { kind: 'bounced', emails: hits } : null;
  }

  #unsubscribe(email, emailNorm, campaignId) {
    this.#contact(email, emailNorm, { unsubscribed_at: nowIso() }, 'unsubscribed');
    this.log('warn', campaignId, 'tracking.unsubscribed', emailNorm);
  }

  /** Kişiyi (yoksa oluşturarak) günceller; suppress verilirse ve kişi henüz engelli değilse engeller. */
  #contact(email, emailNorm, fields, suppress = null) {
    if (!this.db.prepare('SELECT 1 FROM contacts WHERE email_norm = ?').get(emailNorm)) {
      upsertContacts(this.db, [{ email, emailNorm, data: {} }], { source: 'import' });
    }
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE contacts SET ${keys.map((k) => `${k} = COALESCE(${k}, ?)`).join(', ')}${suppress ? ', suppressed = COALESCE(suppressed, ?)' : ''} WHERE email_norm = ?`)
      .run(...keys.map((k) => fields[k]), ...(suppress ? [suppress] : []), emailNorm);
  }
}
