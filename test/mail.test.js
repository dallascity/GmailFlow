import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { buildApp } from '../server/app.js';
import { MemorySecretStore } from '../server/lib/secret-store.js';
import { SCOPES } from '../server/services/oauth.js';
import { decodeWords, parseAddressList, decodeBody, parseGmailMessage, prepareDisplayHtml } from '../server/services/mail-parse.js';
import { parseBounce, stripQuoted, UNSUBSCRIBE_RE } from '../server/services/tracking.js';
import { QuotaBucket } from '../server/services/gmail-api.js';
import { FakeGmail } from './helpers/fake-gmail.js';

describe('mail-parse', () => {
  it('decodes RFC 2047 words and address lists', () => {
    expect(decodeWords('=?UTF-8?B?R8O2csO8xZ9tZQ==?= talebi')).toBe('Görüşme talebi');
    expect(decodeWords('=?ISO-8859-9?Q?=DE=FDrket?=')).toBe('Şırket');
    expect(parseAddressList('"Veli, Ali" <ALI@x.com>, b@y.com, =?UTF-8?B?QXnFn2U=?= <ayse@z.com>')).toEqual([
      { name: 'Veli, Ali', email: 'ali@x.com' },
      { name: null, email: 'b@y.com' },
      { name: 'Ayşe', email: 'ayse@z.com' },
    ]);
  });

  it('decodes windows-1254 bodies but keeps already-UTF-8 bytes', () => {
    expect(decodeBody(iconv.encode('Güneş Çağ', 'win1254'), 'windows-1254')).toBe('Güneş Çağ');
    expect(decodeBody(Buffer.from('Güneş', 'utf8'), 'windows-1254')).toBe('Güneş');
  });

  it('parses a full Gmail message with attachments and inline images', () => {
    const fake = new FakeGmail();
    const m = fake.addMessage({
      subject: 'Teklif',
      html: '<p>Merhaba <img src="cid:logo1"></p>',
      text: 'Merhaba',
      attachments: [
        { filename: 'teklif.pdf', mimeType: 'application/pdf', data: '%PDF' },
        { contentId: 'logo1', mimeType: 'image/png', data: 'PNG' },
      ],
    });
    const p = parseGmailMessage(JSON.parse(JSON.stringify(m)));
    expect(p.subject).toBe('Teklif');
    expect(p.from).toEqual({ name: 'Ali Veli', email: 'ali@ornek.com' });
    expect(p.html).toContain('cid:logo1');
    expect(p.attachments.map((a) => [a.filename, a.inline])).toEqual([
      ['teklif.pdf', false],
      [expect.stringMatching(/^ek-/), true],
    ]);
  });

  it('sanitises HTML and blocks remote images', () => {
    const { html, blockedImages } = prepareDisplayHtml(
      '<p onclick="x()">Hi</p><script>alert(1)</script><img src="https://t.co/pixel.gif"><img src="cid:a"><a href="javascript:evil()">x</a><div style="background:url(https://x/y.png)">z</div>',
      { cidMap: { a: 'data:image/png;base64,AA' } },
    );
    expect(html).not.toMatch(/<script|onclick|javascript:/i);
    expect(html).toContain('data:image/png;base64,AA');
    expect(html).not.toContain('https://t.co/pixel.gif');
    expect(blockedImages).toBe(2);
    expect(prepareDisplayHtml('<img src="https://x/y.png">', { allowRemote: true }).html).toContain('https://x/y.png');
  });
});

describe('tracking helpers', () => {
  it('parses permanent and temporary bounces', () => {
    const perm = parseBounce({
      deliveryStatus: 'Final-Recipient: rfc822; yok@ornek.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 user unknown',
    });
    expect(perm).toMatchObject({ recipients: ['yok@ornek.com'], permanent: true, reason: 'smtp; 550 5.1.1 user unknown' });
    expect(parseBounce({ failedRecipients: ['a@b.co'], deliveryStatus: 'Status: 4.2.2' })).toMatchObject({ permanent: false, temporary: true });
    expect(parseBounce({ text: "Address not found. Your message wasn't delivered because the address couldn't be found" }).permanent).toBe(true);
  });

  it('strips quoted text and detects unsubscribe wording', () => {
    const t = 'Lütfen beni listeden çıkarın.\n\n18 Kas 2026 Çar 10:00 tarihinde Ben <ben@gmail.com> şunu yazdı:\n> Merhaba, kampanyamız…';
    expect(stripQuoted(t)).toBe('Lütfen beni listeden çıkarın.');
    for (const s of ['Please unsubscribe me', 'Bir daha mail atmayın', 'Abonelikten çıkmak istiyorum', 'remove me from your list']) expect(UNSUBSCRIBE_RE.test(s), s).toBe(true);
    for (const s of ['Teşekkürler, teklifi inceleyeceğim', 'Toplantı için müsaitim']) expect(UNSUBSCRIBE_RE.test(s), s).toBe(false);
  });

  it('quota bucket lets requests larger than its burst through (no deadlock) and backs off on penalty', async () => {
    let t = 0;
    const waits = [];
    const throttles = [];
    const b = new QuotaBucket({ rate: 80, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, onThrottle: (x) => throttles.push(x) });
    await b.take(100); // gönderim maliyeti > burst (40)
    expect(b.tokens).toBe(-60);
    await b.take(5); // borç ödenene kadar bekler
    expect(waits.at(-1)).toBe(Math.ceil((65 / 80) * 1000));
    b.penalize(61000);
    expect(b.rate).toBe(40);
    expect(throttles[0].until).toBe(t + 61000);
    const before = t;
    await b.take(5);
    expect(t - before).toBeGreaterThanOrEqual(61000);
    for (let i = 0; i < 50; i++) b.reward();
    expect(b.rate).toBe(50);
  });

  it('quota bucket waits when exhausted', async () => {
    let t = 0;
    const waits = [];
    const b = new QuotaBucket({ rate: 10, now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
    await b.take(10);
    await b.take(5);
    expect(waits).toEqual([500]);
  });
});

// ------------------------------------------------------------------ entegrasyon
let app;
let dir;
let fake;
let events;

const json = (r) => JSON.parse(r.body);
const req = async (method, url, payload) => {
  const r = await app.inject({ method, url, payload });
  const body = r.body ? json(r) : null;
  if (r.statusCode >= 400) throw Object.assign(new Error(`${r.statusCode} ${r.body}`), { body });
  return body;
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-mail-'));
  fake = new FakeGmail({ email: 'ben@gmail.com' });
  app = await buildApp({ dataDir: dir, secretStore: new MemorySecretStore(), getPublicOrigin: () => 'http://127.0.0.1:1', gmailFetch: fake.fetch, gmailBucket: new QuotaBucket({ rate: 1e6 }), mailSync: false });
  const { db, oauth, settings, bus } = app.ctx;
  // Bağlı bir hesabı taklit et
  db.prepare("INSERT INTO account (id, email, connected_at) VALUES (1, 'ben@gmail.com', 'x')").run();
  oauth.secrets.set('oauth_refresh_token', 'r');
  settings.set('oauth_client_id', 'x.apps.googleusercontent.com');
  oauth.secrets.set('oauth_client_secret', 's');
  settings.set('oauth_scopes', SCOPES.join(' '));
  oauth.getAccessToken = async () => 'token';
  events = [];
  bus.on('event', (e) => events.push(e));
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('posta istemcisi', () => {
  it('requires the mail scopes', async () => {
    app.ctx.settings.set('oauth_scopes', 'https://www.googleapis.com/auth/gmail.send');
    const r = await app.inject({ method: 'GET', url: '/api/mail/threads/x' });
    expect(json(r).error).toBe('mail.reconnect_required');
  });

  it('syncs, lists folders and threads, searches and opens a conversation', async () => {
    fake.addMessage({ from: 'Ayşe Yılmaz <ayse@ornek.com>', subject: 'Toplantı', text: 'Yarın 10:00 uygun mu?' });
    const first = fake.addMessage({ from: 'Banka <info@banka.com>', subject: 'Hesap özeti', html: '<p>Özet <img src="https://track/p.gif"></p>', labels: ['INBOX', 'CATEGORY_UPDATES'] });
    fake.addMessage({ from: 'ben@gmail.com', to: 'info@banka.com', subject: 'Re: Hesap özeti', text: 'Teşekkürler', threadId: first.threadId, labels: ['SENT'] });
    fake.addMessage({ subject: 'Çok eski', text: 'x', date: Date.now() - 90 * 86400000 });

    await req('POST', '/api/mail/sync');
    const labels = await req('GET', '/api/mail/labels');
    expect(labels.find((l) => l.id === 'INBOX')).toMatchObject({ messages_total: 3, threads_unread: 2 });

    const inbox = await req('GET', '/api/mail/threads?label=INBOX');
    expect(inbox.total).toBe(2); // 90 günlük mail önbellekte değil (30 gün)
    const bank = inbox.threads.find((t) => t.subject === 'Hesap özeti');
    expect(bank).toMatchObject({ count: 2, unread: false, people: ['Banka', 'ben@gmail.com'] });
    expect((await req('GET', '/api/mail/threads?label=CATEGORY_UPDATES')).total).toBe(1);

    // Türkçe karaktersiz arama (FTS remove_diacritics)
    expect((await req('GET', '/api/mail/threads?label=ALL&q=toplanti')).threads[0].subject).toBe('Toplantı');

    const thread = await req('GET', `/api/mail/threads/${first.threadId}`);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[0]).toMatchObject({ blockedImages: 1, from: { email: 'info@banka.com' } });
    expect(thread.messages[0].html).not.toContain('https://track/p.gif');
    await req('POST', '/api/mail/images/allow', { email: 'info@banka.com' });
    expect((await req('GET', `/api/mail/threads/${first.threadId}`)).messages[0].html).toContain('https://track/p.gif');

    // daha eski sayfa isteğe bağlı olarak getirilir
    const older = await req('POST', '/api/mail/threads/older', { label: 'INBOX' });
    expect(older.fetched).toBe(1);
    expect((await req('GET', '/api/mail/threads?label=INBOX')).total).toBe(3);
  });

  it('applies changes both ways (app → Gmail and Gmail → app)', async () => {
    const m = fake.addMessage({ subject: 'Yıldızla beni', text: 'x' });
    await req('POST', '/api/mail/sync');
    await req('POST', '/api/mail/modify', { threadIds: [m.threadId], add: ['STARRED'], remove: ['UNREAD'] });
    expect(fake.messages.get(m.id).labelIds).toEqual(expect.arrayContaining(['STARRED']));
    expect(fake.messages.get(m.id).labelIds).not.toContain('UNREAD');
    expect((await req('GET', '/api/mail/threads?label=STARRED')).total).toBe(1);

    // Gmail web'de arşivlendi + yeni mail geldi → artımlı senkronizasyon
    fake.setLabels(m.id, [], ['INBOX']);
    const n = fake.addMessage({ from: 'Can <can@x.com>', subject: 'Yeni mail', text: 'selam' });
    await req('POST', '/api/mail/sync');
    const inbox = await req('GET', '/api/mail/threads?label=INBOX');
    expect(inbox.threads.map((t) => t.subject)).toEqual(['Yeni mail']);
    expect(events.find((e) => e.type === 'mail:new')?.message).toMatchObject({ id: n.id, subject: 'Yeni mail' });

    await req('POST', '/api/mail/trash', { threadIds: [n.threadId] });
    expect(fake.messages.get(n.id).labelIds).toContain('TRASH');
    expect((await req('GET', '/api/mail/threads?label=INBOX')).total).toBe(0);
  });

  it('survives per-minute quota errors: waits, defers failed messages and fetches them later (reported issue)', async () => {
    // Sanal saat: 61 sn beklemeler anında geçer
    let vt = Date.now();
    const bucket = new QuotaBucket({ rate: 80, now: () => vt, sleep: async (ms) => { vt += ms; } });
    app.ctx.gmailApi.bucket = bucket;
    bucket.onThrottle = ({ until }) => events.push({ type: 'throttle', until });

    const ok = fake.addMessage({ subject: 'Normal', text: 'x' });
    const flaky = fake.addMessage({ subject: 'Bir kez kotaya takılan', text: 'x' });
    const stubborn = fake.addMessage({ subject: 'İnatçı', text: 'x' });
    fake.failures = new Map([[flaky.id, 1], [stubborn.id, 10]]);

    await req('POST', '/api/mail/sync');
    const ids = () => app.ctx.db.prepare('SELECT id FROM mail_messages').all().map((r) => r.id).sort();
    // bir kez takılan: 61 sn beklenip yeniden denendi → indirildi
    expect(ids()).toEqual([ok.id, flaky.id].sort());
    expect(events.some((e) => e.type === 'throttle')).toBe(true);
    // inatçı: kaybolmadı, kuyrukta; tek bir özet kayıt yazıldı
    expect(JSON.parse(app.ctx.mailStore.getState('retry_ids'))).toEqual([stubborn.id]);
    const deferred = app.ctx.db.prepare("SELECT message FROM events_log WHERE code = 'mail.fetch_deferred'").all();
    expect(deferred).toHaveLength(1);
    expect(deferred[0].message).toMatch(/^1 \(1 kota\)/);

    // Kota düzelince bir sonraki senkronizasyonda indirilir
    fake.failures.clear();
    await req('POST', '/api/mail/sync');
    expect(ids()).toEqual([ok.id, flaky.id, stubborn.id].sort());
    expect(JSON.parse(app.ctx.mailStore.getState('retry_ids'))).toEqual([]);
    expect((await req('GET', '/api/mail/status')).pending).toBe(0);
  });

  it('reconciles on start: messages missing from the cache are fetched again', async () => {
    const a = fake.addMessage({ subject: 'A', text: 'a' });
    const b = fake.addMessage({ subject: 'B', text: 'b' });
    await req('POST', '/api/mail/sync');
    // Eski sürümde kaybolmuş bir postayı taklit et
    app.ctx.mailStore.deleteMessage(b.id);
    app.ctx.mailSync.reconciled = false; // uygulama yeniden açıldı
    await req('POST', '/api/mail/sync');
    expect(app.ctx.mailStore.hasMessage(a.id) && app.ctx.mailStore.hasMessage(b.id)).toBe(true);
    expect(app.ctx.db.prepare("SELECT message FROM events_log WHERE code = 'mail.reconciled'").get().message).toBe('1');
  });

  it('falls back to a full sync when the history id has expired', async () => {
    fake.addMessage({ subject: 'A', text: 'a' });
    await req('POST', '/api/mail/sync');
    fake.addMessage({ subject: 'B', text: 'b' });
    fake.expireHistory();
    await req('POST', '/api/mail/sync');
    expect((await req('GET', '/api/mail/threads?label=INBOX')).total).toBe(2);
    expect(fake.calls.filter((c) => c === 'GET /profile')).toHaveLength(2);
  });

  it('replies in the same thread, saves/sends drafts and counts toward the daily quota', async () => {
    const orig = fake.addMessage({ from: 'Ayşe <ayse@ornek.com>', subject: 'Soru', text: 'Merhaba?' });
    await req('POST', '/api/mail/sync');
    const th = await req('GET', `/api/mail/threads/${orig.threadId}`);
    const m = th.messages[0];
    await req('POST', '/api/mail/send', {
      to: [{ email: 'ayse@ornek.com' }],
      cc: ['ali@x.com'],
      subject: 'Re: Soru',
      html: '<p>Merhaba Ayşe</p>',
      threadId: orig.threadId,
      inReplyTo: m.messageIdHeader,
      references: m.messageIdHeader,
    });
    const sent = [...fake.messages.values()].find((x) => x.labelIds.includes('SENT'));
    expect(sent.threadId).toBe(orig.threadId);
    expect(sent.payload.headers.find((h) => h.name === 'Cc').value).toContain('ali@x.com');
    expect((await req('GET', '/api/quota')).used).toBe(2);

    const d = await req('POST', '/api/mail/drafts', { to: ['b@y.com'], subject: 'Taslak', html: '<p>v1</p>' });
    const d2 = await req('POST', '/api/mail/drafts', { draftId: d.draftId, to: ['b@y.com'], subject: 'Taslak v2', html: '<p>v2</p>' });
    expect(d2.draftId).toBe(d.draftId);
    await req('POST', '/api/mail/sync');
    const loaded = await req('GET', `/api/mail/drafts/by-message/${d2.messageId}`);
    expect(loaded).toMatchObject({ draftId: d.draftId, subject: 'Taslak v2' });
    await req('POST', '/api/mail/send', { draftId: d.draftId, to: ['b@y.com'], subject: 'Taslak v2', html: '<p>v2</p>' });
    expect(fake.drafts.size).toBe(0);

    await expect(req('POST', '/api/mail/send', { to: ['bozuk@'], subject: 'x', html: 'x' })).rejects.toMatchObject({ body: { error: 'mail.invalid_recipient' } });
  });

  it('tracks replies, bounces and unsubscribes of campaign mails and suppresses those addresses', async () => {
    const { db } = app.ctx;
    // Üç kampanya gönderimi (Gmail'de SENT olarak duruyor)
    const cid = db.prepare("INSERT INTO campaigns (name, created_at, updated_at, list_id) VALUES ('K', 'x', 'x', NULL)").run().lastInsertRowid;
    const sentTo = {};
    for (const email of ['yanit@ornek.com', 'yok@ornek.com', 'cik@ornek.com']) {
      const s = fake.addMessage({ from: 'ben@gmail.com', to: email, subject: 'Kampanya', text: 'Teklif', labels: ['SENT'] });
      db.prepare("INSERT INTO sends (campaign_id, email, email_norm, data_json, seq, status, sent_at, gmail_thread_id) VALUES (?, ?, ?, '{}', 1, 'sent', ?, ?)")
        .run(cid, email, email, new Date().toISOString(), s.threadId);
      sentTo[email] = s;
    }
    await req('POST', '/api/mail/sync');

    fake.addMessage({ from: 'Yanıt <yanit@ornek.com>', subject: 'Re: Kampanya', text: 'Teşekkürler, arayın.\n\nOn Mon, Ben wrote:\n> unsubscribe', threadId: sentTo['yanit@ornek.com'].threadId });
    fake.addMessage({
      from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
      subject: 'Delivery Status Notification (Failure)',
      text: "Address not found\nYour message wasn't delivered to yok@ornek.com because the address couldn't be found.",
      deliveryStatus: 'Final-Recipient: rfc822; yok@ornek.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 The email account does not exist',
      headers: { 'X-Failed-Recipients': 'yok@ornek.com' },
      threadId: sentTo['yok@ornek.com'].threadId,
    });
    fake.addMessage({ from: 'cik@ornek.com', subject: 'Re: Kampanya', text: 'Lütfen beni listeden çıkarın.', threadId: sentTo['cik@ornek.com'].threadId });
    await req('POST', '/api/mail/sync');

    const s = Object.fromEntries(db.prepare('SELECT email, replied_at, bounced_at, bounce_reason FROM sends').all().map((r) => [r.email, r]));
    expect(s['yanit@ornek.com'].replied_at).toBeTruthy();
    expect(s['yok@ornek.com']).toMatchObject({ replied_at: null, bounce_reason: 'smtp; 550 5.1.1 The email account does not exist' });
    expect(s['yok@ornek.com'].bounced_at).toBeTruthy();
    expect(s['cik@ornek.com'].replied_at).toBeTruthy();

    const c = Object.fromEntries(db.prepare('SELECT email_norm, suppressed FROM contacts').all().map((r) => [r.email_norm, r.suppressed]));
    expect(c).toEqual({ 'yanit@ornek.com': null, 'yok@ornek.com': 'bounced', 'cik@ornek.com': 'unsubscribed' });

    const camp = await req('GET', `/api/campaigns/${cid}`);
    expect(camp.tracking).toEqual({ replied: 2, bounced: 1 });
    expect((await req('GET', '/api/contacts/stats')).suppressed).toBe(2);

    // Engelli adresler sonraki kampanyada otomatik atlanır
    const listId = db.prepare("INSERT INTO lists (name, email_column, columns_json, stats_json, created_at) VALUES ('L','E','[\"E\"]','{}','x')").run().lastInsertRowid;
    for (const [i, e] of ['yanit@ornek.com', 'yok@ornek.com', 'cik@ornek.com'].entries()) {
      db.prepare("INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid) VALUES (?, ?, ?, ?, '{}', 1)").run(listId, i + 2, e, e);
    }
    const c2 = db.prepare("INSERT INTO campaigns (name, list_id, skip_previously_sent, created_at, updated_at) VALUES ('K2', ?, 0, 'x', 'x')").run(listId).lastInsertRowid;
    expect(await req('GET', `/api/campaigns/${c2}/summary`)).toMatchObject({ recipients: 3, suppressed: 2, toSend: 1 });
    app.ctx.sender.prepare(app.ctx.sender.campaign(Number(c2)));
    const rows = db.prepare('SELECT email, status, error_code FROM sends WHERE campaign_id = ? ORDER BY seq').all(c2);
    expect(rows).toEqual([
      { email: 'yanit@ornek.com', status: 'pending', error_code: null },
      { email: 'yok@ornek.com', status: 'skipped', error_code: 'suppressed_bounced' },
      { email: 'cik@ornek.com', status: 'skipped', error_code: 'suppressed_unsubscribed' },
    ]);

    // Engeli kaldırma
    const ids = (await req('GET', '/api/contacts?status=suppressed')).rows.map((r) => r.id);
    await req('POST', '/api/contacts/unsuppress', { ids });
    expect((await req('GET', '/api/contacts/stats')).suppressed).toBe(0);
  });

  it('wipes the mail cache on disconnect', async () => {
    fake.addMessage({ subject: 'A', text: 'a' });
    await req('POST', '/api/mail/sync');
    expect(app.ctx.db.prepare('SELECT COUNT(*) n FROM mail_messages').get().n).toBe(1);
    app.ctx.oauth.disconnect({ revoke: false });
    expect(app.ctx.db.prepare('SELECT COUNT(*) n FROM mail_messages').get().n).toBe(0);
  });
});
