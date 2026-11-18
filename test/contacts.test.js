import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../server/app.js';
import { MemorySecretStore } from '../server/lib/secret-store.js';
import { openDatabase } from '../server/db/index.js';
import { migrations } from '../server/db/migrations.js';

let app;
let dir;

const json = (r) => JSON.parse(r.body);
const post = async (url, payload) => json(await app.inject({ method: 'POST', url, payload }));
const get = async (url) => json(await app.inject({ method: 'GET', url }));

async function importCsv(csv, name) {
  const boundary = '----gf';
  const body =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="l.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
  const imp = json(
    await app.inject({ method: 'POST', url: '/api/lists/import', payload: Buffer.from(body), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }),
  );
  return post('/api/lists', { importId: imp.importId, emailColumn: imp.emailColumn, name });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-test-'));
  app = await buildApp({ dataDir: dir, secretStore: new MemorySecretStore(), getPublicOrigin: () => 'http://127.0.0.1:1', locale: 'tr' });
});
afterEach(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('kayıtlı mailler', () => {
  it('collects every imported address once, with name and merged data', async () => {
    await importCsv('Ad Soyad;E-posta;Şirket\nAyşe;ayse@x.com;ACME\nAli;ali@x.com;Beta\nBozuk;bozuk\n', 'L1');
    await importCsv('İsim;Mail;Şehir\nAyşe Y.;AYSE@x.com;İzmir\nCan;can@x.com;Bursa\n', 'L2');
    const { total, rows } = await get('/api/contacts?sort=email');
    expect(total).toBe(3);
    const ayse = rows.find((r) => r.email.toLowerCase() === 'ayse@x.com');
    expect(ayse.name).toBe('Ayşe Y.');
    expect(ayse.data).toMatchObject({ Şirket: 'ACME', Şehir: 'İzmir' });
    expect(ayse.lists.map((l) => l.name).sort()).toEqual(['L1', 'L2']);
    expect(ayse.data).not.toHaveProperty('E-posta');
  });

  it('adds pasted addresses manually and keeps them after list deletion', async () => {
    const l = await importCsv('E-posta\na@x.com\n', 'L1');
    const r = await post('/api/contacts', { text: 'a@x.com, b@x.com:c@x.com: bozuk@' });
    expect(r).toEqual({ added: 2, duplicates: 1, invalid: 1 });
    await app.inject({ method: 'DELETE', url: `/api/lists/${l.id}` });
    expect((await get('/api/contacts')).total).toBe(3);
  });

  it('filters by list, search and sending status', async () => {
    const l1 = await importCsv('E-posta;Ad\na@x.com;Ahmet\nb@y.com;Berk\n', 'L1');
    await post('/api/contacts', { text: 'c@z.com' });
    expect((await get(`/api/contacts?listId=${l1.id}`)).total).toBe(2);
    expect((await get('/api/contacts?q=berk')).total).toBe(1);
    const { db } = app.ctx;
    const cid = db.prepare("INSERT INTO campaigns (name, created_at, updated_at) VALUES ('K', 'x', 'x')").run().lastInsertRowid;
    db.prepare("INSERT INTO sends (campaign_id, email, email_norm, data_json, seq, status, sent_at) VALUES (?, 'a@x.com', 'a@x.com', '{}', 1, 'sent', '2026-11-18T10:00:00Z')").run(cid);
    db.prepare("INSERT INTO sends (campaign_id, email, email_norm, data_json, seq, status) VALUES (?, 'b@y.com', 'b@y.com', '{}', 2, 'failed')").run(cid);
    expect(await get('/api/contacts/stats')).toMatchObject({ total: 3, never_sent: 2, sent: 1, failed: 1, replied: 0, bounced: 0 });
    const sent = await get('/api/contacts?status=sent');
    expect(sent.rows[0]).toMatchObject({ email: 'a@x.com', sent_count: 1, last_sent_at: '2026-11-18T10:00:00Z' });
  });

  it('creates a new list from a selection and from "all matching"', async () => {
    await importCsv('Ad Soyad;E-posta;Şirket\nAyşe;ayse@x.com;ACME\nAli;ali@x.com;Beta\n', 'L1');
    await post('/api/contacts', { text: 'yeni@x.com' });
    const ids = (await get('/api/contacts?q=ayse')).rows.map((r) => r.id);
    const r1 = await post('/api/contacts/to-list', { ids, name: 'Seçilenler' });
    expect(r1.list).toMatchObject({ name: 'Seçilenler', email_column: 'E-posta' });
    expect(r1.list.columns).toEqual(['E-posta', 'Ad Soyad', 'Şirket']);
    const rec = await get(`/api/lists/${r1.list.id}/recipients`);
    expect(rec.rows[0].data).toEqual({ 'E-posta': 'ayse@x.com', 'Ad Soyad': 'Ayşe', Şirket: 'ACME' });

    const r2 = await post('/api/contacts/to-list', { filter: { status: 'never_sent' }, name: 'Hepsi' });
    expect(r2.added).toBe(3);
  });

  it('appends a selection to an existing list without duplicates', async () => {
    const l = await importCsv('E-posta;Ad Soyad\na@x.com;A\n', 'L1');
    await post('/api/contacts', { text: 'a@x.com b@x.com' });
    const r = await post('/api/contacts/to-list', { filter: {}, listId: l.id });
    expect(r).toMatchObject({ added: 1, duplicates: 1 });
    expect(r.list.stats.valid).toBe(2);
  });

  it('deletes from the address book only', async () => {
    const l = await importCsv('E-posta\na@x.com\nb@x.com\n', 'L1');
    const { rows } = await get('/api/contacts');
    expect(await post('/api/contacts/delete', { ids: [rows[0].id] })).toEqual({ deleted: 1 });
    expect((await get('/api/contacts')).total).toBe(1);
    expect((await get(`/api/lists/${l.id}`)).stats.valid).toBe(2);
  });
});

describe('migration v2', () => {
  it('backfills the address book from existing lists', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gf-mig-')), 'db.sqlite');
    const old = new DatabaseSync(file);
    old.exec(migrations[0]);
    old.exec('PRAGMA user_version = 1');
    old.prepare("INSERT INTO lists (name, email_column, columns_json, stats_json, created_at) VALUES ('L', 'Mail', '[\"Mail\",\"İsim\"]', '{}', 'x')").run();
    old.prepare("INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid) VALUES (1, 2, 'A@x.com', 'a@x.com', '{\"Mail\":\"A@x.com\",\"İsim\":\"Ahmet\"}', 1)").run();
    old.prepare("INSERT INTO recipients (list_id, row_no, email, email_norm, data_json, valid, invalid_reason) VALUES (1, 3, 'bozuk', 'bozuk', '{}', 0, 'invalid_format')").run();
    old.close();

    const db = openDatabase(file);
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(migrations.length);
    expect(db.prepare('SELECT email, email_norm, name, data_json FROM contacts').all()).toEqual([
      { email: 'A@x.com', email_norm: 'a@x.com', name: 'Ahmet', data_json: '{"İsim":"Ahmet"}' },
    ]);
    db.close();
  });
});
