import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, nowIso } from '../server/db/index.js';
import { SettingsService } from '../server/services/settings.js';
import { Sender } from '../server/services/sender.js';
import { GmailError } from '../server/services/gmail.js';

function setup({ emails = ['a@x.co', 'b@x.co', 'c@x.co'], send } = {}) {
  const db = openDatabase(':memory:');
  const settings = new SettingsService(db);
  db.prepare("INSERT INTO account (id, email, connected_at) VALUES (1, 'me@gmail.com', ?)").run(nowIso());
  const oauth = {
    status: () => ({ connected: true }),
    getAccessToken: async () => 'token',
    invalidateAccessToken: () => {},
  };
  const listId = Number(
    db.prepare("INSERT INTO lists (name, email_column, columns_json, stats_json, created_at) VALUES ('L', 'E', '[\"E\",\"Ad\"]', '{}', ?)").run(nowIso()).lastInsertRowid,
  );
  emails.forEach((e, i) =>
    db.prepare('INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid) VALUES (?, ?, ?, ?, ?, 1)').run(listId, i + 2, e, e, JSON.stringify({ E: e, Ad: `Kişi ${i}` })),
  );
  const newCampaign = (extra = {}) =>
    Number(
      db
        .prepare(
          `INSERT INTO campaigns (name, list_id, subject, body_html, delay_sec, skip_previously_sent, created_at, updated_at)
           VALUES ('K', ?, 'Merhaba {{ad}}', '<p>Selam {{ad}}</p>', 1, ?, ?, ?)`,
        )
        .run(listId, extra.skip ?? 1, nowIso(), nowIso()).lastInsertRowid,
    );
  const sent = [];
  const sender = new Sender({
    db,
    settings,
    oauth,
    sleep: async (_ms, signal) => !signal?.aborted,
    send:
      send ??
      (async (_t, raw) => {
        sent.push(raw.toString());
        return { id: `m${sent.length}` };
      }),
  });
  const run = async (id) => {
    await sender.start(id);
    await sender.active?.promise;
  };
  return { db, settings, sender, newCampaign, sent, run };
}

describe('sender', () => {
  let t;
  beforeEach(() => {
    t = setup();
  });

  it('sends one message per recipient, in order, with personalisation', async () => {
    const id = t.newCampaign();
    await t.run(id);
    expect(t.sender.campaign(id).status).toBe('completed');
    expect(t.sent).toHaveLength(3);
    t.sent.forEach((raw, i) => {
      const to = raw.match(/^To: (.*)$/m)[1].trim();
      expect(to).toBe(['a@x.co', 'b@x.co', 'c@x.co'][i]);
      expect(raw).not.toMatch(/^(Cc|Bcc):/im);
    });
    expect(t.sender.counts(id)).toMatchObject({ sent: 3, pending: 0 });
  });

  it('never sends twice to an address already sent by an earlier campaign', async () => {
    await t.run(t.newCampaign());
    const id2 = t.newCampaign();
    await expect(t.run(id2)).resolves.toBeUndefined();
    expect(t.sent).toHaveLength(3);
    expect(t.sender.counts(id2)).toMatchObject({ skipped: 3, sent: 0 });
  });

  it('pauses on daily limit', async () => {
    t.settings.set('daily_limit', 2);
    const id = t.newCampaign();
    await t.run(id);
    const c = t.sender.campaign(id);
    expect(c.status).toBe('paused');
    expect(c.pause_reason).toBe('daily_limit');
    expect(c.resume_after).toBeTruthy();
    expect(t.sent).toHaveLength(2);
  });

  it('marks invalid recipients failed and continues; pauses on quota error', async () => {
    let n = 0;
    t = setup({
      send: async () => {
        n++;
        if (n === 1) throw new GmailError({ kind: 'recipient', status: 400, reason: 'invalidArgument', message: 'Invalid To' });
        if (n === 3) throw new GmailError({ kind: 'quota', status: 403, reason: 'dailyLimitExceeded' });
        return { id: 'x' };
      },
    });
    const id = t.newCampaign();
    await t.run(id);
    expect(t.sender.counts(id)).toMatchObject({ failed: 1, sent: 1, pending: 1 });
    expect(t.sender.campaign(id)).toMatchObject({ status: 'paused', pause_reason: 'quota' });
  });

  it('retries rate-limit errors then succeeds', async () => {
    let n = 0;
    t = setup({
      emails: ['a@x.co'],
      send: async () => {
        if (++n < 3) throw new GmailError({ kind: 'rate', status: 429, reason: 'rateLimitExceeded' });
        return { id: 'ok' };
      },
    });
    const id = t.newCampaign();
    await t.run(id);
    expect(n).toBe(3);
    expect(t.sender.counts(id).sent).toBe(1);
  });

  it('marks ambiguous network failures unknown instead of resending', async () => {
    t = setup({
      emails: ['a@x.co', 'b@x.co'],
      send: async () => {
        throw new GmailError({ kind: 'transient', status: 0, reason: 'network', message: 'ECONNRESET' });
      },
    });
    const id = t.newCampaign();
    await t.run(id);
    expect(t.sender.counts(id)).toMatchObject({ unknown: 1, pending: 1 });
    expect(t.sender.campaign(id).pause_reason).toBe('network');
  });

  it('recovers after crash: running → paused, sending → unknown', () => {
    const id = t.newCampaign();
    t.sender.prepare(t.sender.campaign(id));
    t.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(id);
    t.db.prepare("UPDATE sends SET status = 'sending' WHERE seq = 1").run();
    t.sender.recover();
    expect(t.sender.campaign(id)).toMatchObject({ status: 'paused', pause_reason: 'app_restart' });
    expect(t.sender.counts(id)).toMatchObject({ unknown: 1, pending: 2 });
  });

  it('pause stops the loop; resume continues', async () => {
    let releaseFirst;
    let calls = 0;
    t = setup({
      send: async () => {
        calls++;
        if (calls === 1) await new Promise((r) => (releaseFirst = r));
        return { id: 'x' };
      },
    });
    const id = t.newCampaign();
    await t.sender.start(id);
    await new Promise((r) => setTimeout(r, 10));
    t.sender.pause(id);
    releaseFirst();
    await t.sender.active?.promise;
    expect(t.sender.campaign(id).status).toBe('paused');
    expect(t.sender.counts(id)).toMatchObject({ sent: 1, pending: 2 });
    await t.run(id);
    expect(t.sender.campaign(id).status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('random order keeps every recipient exactly once', async () => {
    const id = t.newCampaign();
    t.db.prepare("UPDATE campaigns SET order_mode = 'random' WHERE id = ?").run(id);
    await t.run(id);
    const tos = t.sent.map((r) => r.match(/^To: (.*)$/m)[1].trim()).sort();
    expect(tos).toEqual(['a@x.co', 'b@x.co', 'c@x.co']);
  });
});

describe('mükerrer gönderim koruması', () => {
  it('canonicalEmail: Gmail noktaları, +etiket ve googlemail aynı kişi', async () => {
    const { canonicalEmail, processRows } = await import('../server/services/validator.js');
    expect(canonicalEmail('A.li+teklif@GoogleMail.com')).toBe('ali@gmail.com');
    expect(canonicalEmail('ali@gmail.com')).toBe('ali@gmail.com');
    // Gmail dışı alan adlarında nokta/+ anlamlı olabilir → dokunulmaz
    expect(canonicalEmail('a.li+x@firma.com')).toBe('a.li+x@firma.com');
    const { stats } = processRows([{ e: 'ali@gmail.com' }, { e: 'a.li@gmail.com' }, { e: 'ali+x@googlemail.com' }], 'e');
    expect(stats).toMatchObject({ valid: 1, duplicates: 2 });
  });

  it('never auto-retries a Gmail 5xx (message may have been sent) → unknown + paused', async () => {
    let calls = 0;
    const t = setup({
      emails: ['a@x.co', 'b@x.co'],
      send: async () => {
        calls++;
        throw new GmailError({ kind: 'transient', status: 503, reason: 'backendError', message: 'Backend Error' });
      },
    });
    const id = t.newCampaign();
    await t.run(id);
    expect(calls).toBe(1);
    expect(t.sender.counts(id)).toMatchObject({ unknown: 1, pending: 1, sent: 0 });
    expect(t.db.prepare("SELECT error_code FROM sends WHERE status = 'unknown'").get().error_code).toBe('server_error');
    expect(t.sender.campaign(id).status).toBe('paused');
  });

  it('treats an "unknown" send in another campaign as already sent', async () => {
    const t = setup();
    const first = t.newCampaign();
    t.sender.prepare(t.sender.campaign(first));
    t.db.prepare("UPDATE sends SET status = 'unknown' WHERE campaign_id = ? AND email = 'a@x.co'").run(first);
    t.db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(first);
    const second = t.newCampaign();
    t.sender.prepare(t.sender.campaign(second));
    expect(t.db.prepare("SELECT status, error_code FROM sends WHERE campaign_id = ? AND email = 'a@x.co'").get(second)).toEqual({ status: 'skipped', error_code: 'previously_sent' });
  });

  it('skips a second spelling of the same Gmail mailbox inside one send and across sends', async () => {
    const t = setup({ emails: ['ali@gmail.com', 'a.li+promo@googlemail.com', 'veli@x.co'] });
    const id = t.newCampaign();
    expect(t.sender.plan(t.sender.campaign(id)).counts).toMatchObject({ toSend: 2, duplicates: 1 });
    await t.run(id);
    expect(t.sent).toHaveLength(2);
    expect(t.db.prepare("SELECT email, error_code FROM sends WHERE status = 'skipped'").all()).toEqual([{ email: 'a.li+promo@googlemail.com', error_code: 'duplicate' }]);

    // Başka bir listede farklı yazımla gelen aynı kişi de atlanır
    const listId = Number(t.db.prepare("INSERT INTO lists (name, email_column, columns_json, stats_json, created_at) VALUES ('L2', 'E', '[\"E\"]', '{}', ?)").run(nowIso()).lastInsertRowid);
    t.db.prepare("INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid) VALUES (?, 2, 'Ali@Gmail.com', 'a.l.i@gmail.com', '{}', 1)").run(listId);
    const c2 = Number(t.db.prepare("INSERT INTO campaigns (name, list_id, subject, body_html, delay_sec, created_at, updated_at) VALUES ('K2', ?, 's', '<p>x</p>', 1, ?, ?)").run(listId, nowIso(), nowIso()).lastInsertRowid);
    expect(t.sender.plan(t.sender.campaign(c2)).counts).toMatchObject({ toSend: 0, previouslySent: 1 });
  });
});
