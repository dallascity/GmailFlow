export default async function miscRoutes(app) {
  const { db, settings, sender, bus, dataDir, locale, secretStore } = app.ctx;

  app.get('/health', async () => ({ ok: true }));

  app.get('/info', async () => ({
    dataDir,
    locale,
    secretsEncrypted: secretStore.encrypted,
    version: process.env.npm_package_version ?? null,
  }));

  app.get('/settings', async () => settings.getPublic());
  app.put('/settings', async (req) => settings.update(req.body ?? {}));

  app.get('/stats', async () => {
    const totals = db
      .prepare(
        `SELECT
           SUM(status = 'sent') sent, SUM(status = 'failed') failed, SUM(status = 'skipped') skipped,
           SUM(status = 'unknown') unknown, SUM(status = 'pending') pending
         FROM sends`,
      )
      .get();
    const campaigns = db.prepare('SELECT status, COUNT(*) n FROM campaigns GROUP BY status').all();
    const lists = db.prepare('SELECT COUNT(*) n FROM lists').get().n;

    // Son 14 gün (yerel saat)
    const daily = db
      .prepare(
        `SELECT date(COALESCE(sent_at, attempted_at), 'localtime') d,
                SUM(status = 'sent') sent, SUM(status = 'failed') failed
         FROM sends
         WHERE status IN ('sent','failed') AND COALESCE(sent_at, attempted_at) >= datetime('now', '-15 days')
         GROUP BY d`,
      )
      .all();
    const byDay = new Map(daily.map((r) => [r.d, r]));
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const r = byDay.get(key);
      days.push({ date: key, sent: r?.sent ?? 0, failed: r?.failed ?? 0 });
    }

    const sent = totals.sent ?? 0;
    const failed = totals.failed ?? 0;
    return {
      totals: { sent, failed, skipped: totals.skipped ?? 0, unknown: totals.unknown ?? 0, pending: totals.pending ?? 0, lists },
      campaigns: Object.fromEntries(campaigns.map((c) => [c.status, c.n])),
      successRate: sent + failed ? sent / (sent + failed) : null,
      tracking: (() => {
        const r = db.prepare("SELECT COUNT(replied_at) replied, COUNT(bounced_at) bounced FROM sends WHERE status = 'sent'").get();
        return { ...r, replyRate: sent ? r.replied / sent : null, bounceRate: sent ? r.bounced / sent : null };
      })(),
      daily: days,
      quota: sender.quota(),
      active: sender.active ? sender.active.campaignId : null,
      recent: db
        .prepare('SELECT id, name, status, created_at, started_at, finished_at FROM campaigns ORDER BY id DESC LIMIT 5')
        .all()
        .map((c) => ({ ...c, counts: sender.counts(c.id) })),
    };
  });

  app.get('/quota', async () => sender.quota());

  app.get('/logs', async (req) => {
    const { campaignId, level, limit = 200, before } = req.query;
    const where = [];
    const args = [];
    if (campaignId) {
      where.push('campaign_id = ?');
      args.push(Number(campaignId));
    }
    if (level) {
      where.push('level = ?');
      args.push(level);
    }
    if (before) {
      where.push('id < ?');
      args.push(Number(before));
    }
    return db
      .prepare(
        `SELECT l.*, c.name campaign_name FROM events_log l LEFT JOIN campaigns c ON c.id = l.campaign_id
         ${where.length ? `WHERE ${where.map((w) => `l.${w}`).join(' AND ')}` : ''}
         ORDER BY l.id DESC LIMIT ?`,
      )
      .all(...args, Math.min(1000, Number(limit) || 200));
  });

  app.delete('/logs', async () => {
    db.prepare('DELETE FROM events_log').run();
    return { ok: true };
  });

  // Canlı ilerleme: Server-Sent Events
  const streams = new Set();
  app.addHook('onClose', async () => {
    for (const end of streams) end();
  });
  app.get('/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const onEvent = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    bus.on('event', onEvent);
    const close = () => {
      clearInterval(ping);
      bus.off('event', onEvent);
      streams.delete(end);
    };
    const end = () => {
      close();
      res.end();
    };
    streams.add(end);
    req.raw.on('close', close);
  });
}
