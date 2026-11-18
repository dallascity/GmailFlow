import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { openDatabase } from './db/index.js';
import { AppError } from './lib/errors.js';
import { SettingsService } from './services/settings.js';
import { OAuthService } from './services/oauth.js';
import { Sender } from './services/sender.js';
import { GmailError } from './services/gmail.js';
import authRoutes from './routes/auth.js';
import listRoutes from './routes/lists.js';
import campaignRoutes from './routes/campaigns.js';
import miscRoutes from './routes/misc.js';
import contactRoutes from './routes/contacts.js';
import mailRoutes from './routes/mail.js';
import { MailStore } from './services/mail-store.js';
import { GmailApi } from './services/gmail-api.js';
import { MailSync } from './services/mail-sync.js';
import { MailService } from './services/mail-actions.js';
import { Tracking } from './services/tracking.js';

/**
 * @param {object} opts
 * @param {string} opts.dataDir          kalıcı veri dizini (Electron: %APPDATA%\GmailFlow)
 * @param {object} opts.secretStore      FileSecretStore / MemorySecretStore
 * @param {string} [opts.apiKey]         verilirse tüm /api istekleri bu anahtarı taşımalıdır
 * @param {string} [opts.staticDir]      derlenmiş arayüz (üretimde)
 * @param {() => string} opts.getPublicOrigin  OAuth yönlendirmesi için (ör. http://127.0.0.1:3000)
 * @param {() => string[]} [opts.allowedHosts] DNS rebinding koruması için izin verilen Host başlıkları
 * @param {string} [opts.locale]         işletim sistemi dili
 * @param {Function} [opts.sendImpl]     test için Gmail gönderim fonksiyonu
 * @param {Function} [opts.gmailFetch]   test için Gmail API fetch'i
 * @param {boolean} [opts.mailSync]      false → arka plan posta senkronizasyonu başlatılmaz (testler)
 */
export async function buildApp(opts) {
  const { dataDir, secretStore, apiKey, staticDir, getPublicOrigin, allowedHosts, locale = 'tr', sendImpl, logger = false } = opts;
  fs.mkdirSync(path.join(dataDir, 'attachments'), { recursive: true });

  const db = openDatabase(opts.dbPath ?? path.join(dataDir, 'gmailflow.db'));
  const settings = new SettingsService(db);
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  // OAuth, Sender'dan önce oluşur (ve açılışta kayıt onarımı loglayabilir) → o ana kadar doğrudan tabloya yazılır.
  let sender = null;
  const oauthLog = (level, campaignId, code, message) => {
    if (sender) return sender.log(level, campaignId, code, message);
    db.prepare('INSERT INTO events_log (ts, level, campaign_id, code, message) VALUES (?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), level, campaignId ?? null, code, String(message ?? ''));
  };
  const oauth = new OAuthService({
    db,
    settings,
    secretStore,
    getRedirectUri: () => `${getPublicOrigin()}/api/auth/callback`,
    log: oauthLog,
    avatarPath: path.join(dataDir, 'avatar.img'),
    ...(opts.oauthFetch ? { fetchImpl: opts.oauthFetch } : {}),
  });
  sender = new Sender({ db, settings, oauth, ...(sendImpl ? { send: sendImpl } : {}) });
  sender.on('event', (e) => bus.emit('event', e));
  sender.recover();

  // --- Posta istemcisi + kampanya takibi
  const emit = (e) => bus.emit('event', e);
  const log = (...a) => sender.log(...a);
  const mailStore = new MailStore(db);
  const gmailApi = opts.gmailApi ?? new GmailApi({ oauth, ...(opts.gmailFetch ? { fetchImpl: opts.gmailFetch } : {}), ...(opts.gmailBucket ? { bucket: opts.gmailBucket } : {}) });
  const me = () => db.prepare('SELECT email FROM account WHERE id = 1').get()?.email ?? null;
  const tracking = new Tracking({ db, store: mailStore, me, log, emit });
  const mailSync = new MailSync({ api: gmailApi, store: mailStore, settings, oauth, tracking, log });
  mailSync.on('event', emit);
  const mail = new MailService({ db, store: mailStore, api: gmailApi, sync: mailSync, sender, settings, oauth, dataDir, emit });

  oauth.onConnectionChange = (status) => {
    emit({ type: 'auth', status });
    const cachedFor = mailStore.getState('email');
    // Bağlantı kesildi ya da başka bir hesaba geçildi → posta önbelleği silinir.
    if (!status.connected || (cachedFor && status.email && cachedFor !== status.email.toLowerCase())) {
      mailSync.stop();
      mailStore.wipe();
      emit({ type: 'mail:changed', full: true });
    }
    if (status.connected && status.mailReady && opts.mailSync !== false) {
      mailSync.stop();
      mailSync.start();
    }
  };

  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 });
  app.decorate('ctx', { db, settings, oauth, sender, bus, dataDir, locale, secretStore, mail, mailSync, mailStore, tracking, gmailApi });

  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

  // --- Güvenlik: Host başlığı + oturum anahtarı ---
  const keyBuf = apiKey ? Buffer.from(apiKey) : null;
  app.addHook('onRequest', async (req, reply) => {
    if (allowedHosts && !allowedHosts().includes(req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
    if (!keyBuf || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth/callback')) return;
    const given = Buffer.from(String(req.headers['x-api-key'] ?? req.query?.key ?? ''));
    if (given.length !== keyBuf.length || !crypto.timingSafeEqual(given, keyBuf)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ error: err.code, params: err.params });
    if (err instanceof GmailError) {
      return reply.code(502).send({ error: `gmail.${err.kind}`, params: { detail: `${err.status} ${err.reason} ${err.message}`.trim() } });
    }
    if (err.validation) return reply.code(400).send({ error: 'validation', params: { detail: err.message } });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'upload.too_large' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'request', params: { detail: err.message } });
    req.log.error(err);
    sender.log('error', null, 'internal', err?.stack ?? String(err));
    return reply.code(500).send({ error: 'internal', params: { detail: err.message } });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(listRoutes, { prefix: '/api/lists' });
  await app.register(campaignRoutes, { prefix: '/api/campaigns' });
  await app.register(contactRoutes, { prefix: '/api/contacts' });
  await app.register(mailRoutes, { prefix: '/api/mail' });
  await app.register(miscRoutes, { prefix: '/api' });

  if (staticDir) {
    await app.register(fastifyStatic, { root: staticDir, index: 'index.html' });
  }

  if (opts.mailSync !== false) mailSync.start();

  app.addHook('onClose', async () => {
    mailSync.stop();
    await sender.stop();
    await secretStore.flushed?.();
    db.close();
  });

  return app;
}
