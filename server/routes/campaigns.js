import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { nowIso } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { clampDelay } from '../services/settings.js';
import { buildVariableMap, findVariables } from '../services/template.js';
import { MAX_ATTACHMENTS_BYTES, wrapHtml } from '../services/mime.js';
import { csvResponse } from '../lib/csv.js';

export const ALLOWED_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  zip: 'application/zip',
};

const EDITABLE_DRAFT = ['name', 'list_id', 'subject', 'body_html', 'body_text', 'format', 'delay_sec', 'order_mode', 'skip_previously_sent', 'list_unsubscribe'];
const EDITABLE_PAUSED = ['name', 'delay_sec'];

export default async function campaignRoutes(app) {
  const { db, sender, settings, dataDir } = app.ctx;
  const attachDir = (id) => path.join(dataDir, 'attachments', String(id));

  const getCampaign = (id) => sender.campaign(Number(id));

  const serialize = (c, { full = true } = {}) => {
    const list = c.list_id ? db.prepare('SELECT id, name, columns_json, stats_json FROM lists WHERE id = ?').get(c.list_id) : null;
    const out = {
      ...c,
      skip_previously_sent: Boolean(c.skip_previously_sent),
      list_unsubscribe: Boolean(c.list_unsubscribe),
      tracking: db
        .prepare('SELECT COUNT(replied_at) replied, COUNT(bounced_at) bounced FROM sends WHERE campaign_id = ?')
        .get(c.id),
      list: list ? { id: list.id, name: list.name, valid: JSON.parse(list.stats_json).valid } : null,
      counts: sender.counts(c.id),
      is_active: sender.active?.campaignId === c.id,
    };
    if (!full) {
      delete out.body_html;
      delete out.body_text;
      return out;
    }
    const columns = list ? JSON.parse(list.columns_json) : [];
    const variables = buildVariableMap(columns);
    const used = findVariables(`${c.subject} ${c.format === 'html' ? c.body_html : c.body_text}`);
    const known = new Set([...Object.keys(variables), 'email', 'eposta']);
    out.variables = variables;
    out.unknown_variables = used.filter((v) => !known.has(v));
    out.attachments = sender.attachmentsFor(c.id).map(({ id, filename, mime, size }) => ({ id, filename, mime, size }));
    return out;
  };

  app.get('/', async () => db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all().map((c) => serialize(c, { full: false })));

  app.get('/:id', async (req) => serialize(getCampaign(req.params.id)));

  app.post('/', async (req) => {
    const b = req.body ?? {};
    const now = nowIso();
    const listId = b.list_id ? Number(b.list_id) : null;
    if (listId && !db.prepare('SELECT 1 FROM lists WHERE id = ?').get(listId)) throw new AppError('list.not_found', 404);
    const info = db
      .prepare('INSERT INTO campaigns (name, list_id, delay_sec, list_unsubscribe, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        String(b.name ?? '').trim() || 'Yeni toplu gönderim',
        listId,
        clampDelay(settings.get('default_delay_sec')),
        settings.get('list_unsubscribe_default') ? 1 : 0,
        now,
        now,
      );
    return serialize(getCampaign(Number(info.lastInsertRowid)));
  });

  app.put('/:id', async (req) => {
    const c = getCampaign(req.params.id);
    const allowed = c.status === 'draft' ? EDITABLE_DRAFT : c.status === 'paused' ? EDITABLE_PAUSED : ['name'];
    const b = req.body ?? {};
    const fields = {};
    for (const k of allowed) {
      if (!(k in b)) continue;
      let v = b[k];
      if (k === 'name') v = String(v ?? '').trim() || c.name;
      if (k === 'subject') v = String(v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 900);
      if (k === 'body_html' || k === 'body_text') v = String(v ?? '');
      if (k === 'format' && !['html', 'text'].includes(v)) continue;
      if (k === 'order_mode' && !['list', 'alpha', 'random'].includes(v)) continue;
      if (k === 'delay_sec') v = clampDelay(v);
      if (k === 'skip_previously_sent' || k === 'list_unsubscribe') v = v ? 1 : 0;
      if (k === 'list_id') {
        v = v ? Number(v) : null;
        if (v && !db.prepare('SELECT 1 FROM lists WHERE id = ?').get(v)) throw new AppError('list.not_found', 404);
      }
      fields[k] = v;
    }
    if (Object.keys(fields).length) {
      fields.updated_at = nowIso();
      const keys = Object.keys(fields);
      db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), c.id);
    }
    return serialize(getCampaign(c.id));
  });

  app.delete('/:id', async (req) => {
    const c = getCampaign(req.params.id);
    if (c.status === 'running') throw new AppError('campaign.invalid_state');
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(c.id);
    fs.rmSync(attachDir(c.id), { recursive: true, force: true });
    return { ok: true };
  });

  app.post('/:id/duplicate', async (req) => {
    const c = getCampaign(req.params.id);
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO campaigns (name, list_id, subject, body_html, body_text, format, delay_sec, order_mode, skip_previously_sent, list_unsubscribe, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`${c.name} (2)`, c.list_id, c.subject, c.body_html, c.body_text, c.format, c.delay_sec, c.order_mode, c.skip_previously_sent, c.list_unsubscribe, now, now);
    const newId = Number(info.lastInsertRowid);
    for (const a of sender.attachmentsFor(c.id)) {
      if (!fs.existsSync(a.stored_path)) continue;
      fs.mkdirSync(attachDir(newId), { recursive: true });
      const dest = path.join(attachDir(newId), path.basename(a.stored_path));
      fs.copyFileSync(a.stored_path, dest);
      db.prepare('INSERT INTO campaign_attachments (campaign_id, filename, stored_path, mime, size) VALUES (?, ?, ?, ?, ?)')
        .run(newId, a.filename, dest, a.mime, a.size);
    }
    return serialize(getCampaign(newId));
  });

  // ---- Gönderim kontrolü
  app.post('/:id/start', async (req) => {
    await sender.start(Number(req.params.id));
    return serialize(getCampaign(req.params.id), { full: false });
  });
  app.post('/:id/pause', async (req) => {
    sender.pause(Number(req.params.id));
    return serialize(getCampaign(req.params.id), { full: false });
  });
  app.post('/:id/cancel', async (req) => {
    sender.cancel(Number(req.params.id));
    return serialize(getCampaign(req.params.id), { full: false });
  });
  app.post('/:id/test', async (req) => sender.sendTest(Number(req.params.id), req.body?.to));
  app.post('/:id/retry-failed', async (req) => ({ count: sender.retryFailed(Number(req.params.id)) }));
  app.post('/:id/sends/:sendId/resolve', async (req) => {
    sender.resolveSend(Number(req.params.id), Number(req.params.sendId), req.body?.action);
    return { ok: true };
  });

  // Gönderim öncesi özet: alıcı sayısı, atlanacaklar, kota, tahmini süre
  app.get('/:id/summary', async (req) => {
    const c = getCampaign(req.params.id);
    const quota = sender.quota();
    let recipients = 0;
    let previouslySent = 0;
    let suppressed = 0;
    let duplicates = 0;
    if (c.status === 'draft' && c.list_id) {
      // Gönderimin kendisiyle birebir aynı kurallar (Sender.plan)
      ({ recipients, previouslySent, suppressed, duplicates } = sender.plan(c).counts);
    } else {
      const counts = sender.counts(c.id);
      recipients = counts.pending;
    }
    const toSend = recipients - previouslySent - suppressed - duplicates;
    return {
      recipients,
      previouslySent,
      suppressed,
      duplicates,
      toSend,
      quota,
      sendableToday: Math.min(toSend, quota.remaining),
      estimatedSeconds: Math.max(0, Math.min(toSend, quota.remaining) - 1) * c.delay_sec + Math.min(toSend, quota.remaining) * 1.5,
    };
  });

  // ---- Gönderim satırları
  app.get('/:id/sends', async (req) => {
    const c = getCampaign(req.params.id);
    const { status, q = '', offset = 0, limit = 100 } = req.query;
    const where = ['campaign_id = ?'];
    const args = [c.id];
    if (status === 'replied') where.push('replied_at IS NOT NULL');
    else if (status === 'bounced') where.push('bounced_at IS NOT NULL');
    else if (status) {
      where.push('status = ?');
      args.push(status);
    }
    if (q) {
      where.push('email_norm LIKE ?');
      args.push(`%${String(q).toLowerCase()}%`);
    }
    const sql = `FROM sends WHERE ${where.join(' AND ')}`;
    return {
      total: db.prepare(`SELECT COUNT(*) n ${sql}`).get(...args).n,
      rows: db
        .prepare(
          `SELECT id, seq, email, status, error_code, error_message, attempts, attempted_at, sent_at, gmail_message_id, gmail_thread_id,
             replied_at, bounced_at, bounce_reason ${sql} ORDER BY seq LIMIT ? OFFSET ?`,
        )
        .all(...args, Math.min(500, Number(limit) || 100), Number(offset) || 0),
    };
  });

  app.get('/:id/export', async (req, reply) => {
    const c = getCampaign(req.params.id);
    const status = req.query.status;
    const rows = db
      .prepare(`SELECT seq, email, status, error_code, error_message, sent_at FROM sends WHERE campaign_id = ? ${status ? 'AND status = ?' : ''} ORDER BY seq`)
      .all(...(status ? [c.id, status] : [c.id]));
    return csvResponse(
      reply,
      `${c.name}-${status || 'tum'}.csv`,
      ['#', 'E-posta', 'Durum', 'Hata kodu', 'Hata', 'Gönderim zamanı'],
      rows.map((r) => [r.seq, r.email, r.status, r.error_code ?? '', r.error_message ?? '', r.sent_at ?? '']),
    );
  });

  // ---- Ekler
  app.post('/:id/attachments', async (req) => {
    const c = getCampaign(req.params.id);
    if (c.status !== 'draft') throw new AppError('campaign.not_editable');
    const file = await req.file();
    if (!file) throw new AppError('import.no_file');
    const ext = path.extname(file.filename).slice(1).toLowerCase();
    if (!ALLOWED_EXT[ext]) {
      file.file.resume();
      throw new AppError('attachments.type_not_allowed', 400, { ext });
    }
    fs.mkdirSync(attachDir(c.id), { recursive: true });
    const dest = path.join(attachDir(c.id), `${crypto.randomUUID()}.${ext}`);
    await pipeline(file.file, fs.createWriteStream(dest));
    if (file.file.truncated) {
      fs.rmSync(dest, { force: true });
      throw new AppError('attachments.too_large');
    }
    const size = fs.statSync(dest).size;
    const current = db.prepare('SELECT COALESCE(SUM(size),0) s FROM campaign_attachments WHERE campaign_id = ?').get(c.id).s;
    if (current + size > MAX_ATTACHMENTS_BYTES) {
      fs.rmSync(dest, { force: true });
      throw new AppError('attachments.too_large');
    }
    const safeName = path.basename(file.filename).replace(/[\r\n"]/g, '_');
    db.prepare('INSERT INTO campaign_attachments (campaign_id, filename, stored_path, mime, size) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, safeName, dest, ALLOWED_EXT[ext], size);
    return serialize(getCampaign(c.id)).attachments;
  });

  app.delete('/:id/attachments/:attId', async (req) => {
    const c = getCampaign(req.params.id);
    if (c.status !== 'draft') throw new AppError('campaign.not_editable');
    const a = db.prepare('SELECT * FROM campaign_attachments WHERE id = ? AND campaign_id = ?').get(Number(req.params.attId), c.id);
    if (!a) throw new AppError('attachments.not_found', 404);
    fs.rmSync(a.stored_path, { force: true });
    db.prepare('DELETE FROM campaign_attachments WHERE id = ?').run(a.id);
    return serialize(getCampaign(c.id)).attachments;
  });

  // ---- Önizleme (kaydedilmemiş içerikle de çalışır)
  app.post('/:id/preview', async (req) => {
    const c = getCampaign(req.params.id);
    const draft = { ...c, ...pick(req.body ?? {}, ['subject', 'body_html', 'body_text', 'format', 'list_id']) };
    const index = Math.max(0, Number(req.body?.index) || 0);
    const listId = draft.list_id ? Number(draft.list_id) : null;
    let recipient = null;
    let total = 0;
    if (listId) {
      total = db.prepare('SELECT COUNT(*) n FROM recipients WHERE list_id = ? AND valid = 1').get(listId).n;
      recipient = db
        .prepare('SELECT email, data_json FROM recipients WHERE list_id = ? AND valid = 1 ORDER BY row_no LIMIT 1 OFFSET ?')
        .get(listId, Math.min(index, Math.max(0, total - 1)));
    }
    const data = recipient ? JSON.parse(recipient.data_json) : {};
    const email = recipient?.email ?? 'ornek@example.com';
    const r = sender.renderFor(draft, data, email);
    return {
      total,
      index: Math.min(index, Math.max(0, total - 1)),
      to: email,
      subject: r.subject,
      format: draft.format,
      html: draft.format === 'html' ? wrapHtml(r.body) : null,
      text: draft.format === 'text' ? r.body : null,
      missing: r.missing,
    };
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
