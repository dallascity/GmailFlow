import { AppError } from '../lib/errors.js';

const safeId = (v) => {
  if (!/^[\w-]{1,1024}$/.test(String(v ?? ''))) throw new AppError('mail.not_found', 404);
  return String(v);
};
const ids = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^[\w-]+$/.test(x)).slice(0, 500) : []);
const labelIds = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^[\w-]+$/.test(x)).slice(0, 20) : []);

export default async function mailRoutes(app) {
  const { mail, mailSync, mailStore } = app.ctx;

  app.get('/status', async () => mailSync.status());

  app.post('/sync', async (req) => {
    mail.requireReady();
    await mailSync.syncNow({ full: Boolean(req.body?.full) });
    return mailSync.status();
  });

  app.get('/labels', async () => mailStore.labels());

  app.get('/threads', async (req) => {
    const { label = 'INBOX', q = '', offset = 0, limit = 50 } = req.query;
    return mailStore.listThreads({ label: String(label), q: String(q), offset: Number(offset) || 0, limit: Math.min(100, Number(limit) || 50) });
  });

  // Önbellekteki en eskiden daha eski bir sayfayı Gmail'den getir
  app.post('/threads/older', async (req) => {
    mail.requireReady();
    return mailSync.fetchOlder(String(req.body?.label ?? 'INBOX'));
  });

  // Tüm Gmail'de arama (Gmail arama sözdizimi: from:, has:attachment, older_than: …)
  app.get('/search/remote', async (req) => {
    mail.requireReady();
    const q = String(req.query.q ?? '').trim();
    if (!q) return { total: 0, threads: [] };
    const threadIds = await mailSync.searchRemote(q);
    return mailStore.listThreads({ threadIds, label: null, limit: 100 });
  });

  app.get('/threads/:id', async (req) => {
    mail.requireReady();
    return mail.thread(safeId(req.params.id), { images: req.query.images === '1' });
  });

  app.get('/messages/:id/attachments/:attId', async (req, reply) => {
    mail.requireReady();
    const { data, filename, mimeType } = await mail.attachment(safeId(req.params.id), safeId(req.params.attId));
    const safe = filename.replace(/[\\/:*?"<>|\r\n]+/g, '_');
    reply
      .header('Content-Type', mimeType)
      .header('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safe.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`)
      .header('X-Content-Type-Options', 'nosniff');
    return data;
  });

  app.post('/modify', async (req) => mail.modify(ids(req.body?.threadIds), labelIds(req.body?.add), labelIds(req.body?.remove)));
  app.post('/trash', async (req) => mail.trash(ids(req.body?.threadIds)));
  app.post('/untrash', async (req) => mail.trash(ids(req.body?.threadIds), true));
  app.post('/images/allow', async (req) => {
    mail.allowImages(req.body?.email ?? '');
    return { ok: true };
  });

  // ---- yazma
  app.post('/compose/attachments', async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('import.no_file');
    return mail.saveUpload(file);
  });
  app.post('/send', async (req) => mail.send(req.body ?? {}));
  app.post('/drafts', async (req) => mail.saveDraft(req.body ?? {}));
  app.delete('/drafts/:draftId', async (req) => mail.deleteDraft(safeId(req.params.draftId)));
  app.get('/drafts/by-message/:messageId', async (req) => mail.draftForMessage(safeId(req.params.messageId)));
  app.get('/suggest', async (req) => mail.suggest(req.query.q));
}
