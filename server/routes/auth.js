import fs from 'node:fs';
import { AppError } from '../lib/errors.js';

const PAGE = (ok, title, text) => `<!doctype html><html><head><meta charset="utf-8"><title>GmailFlow</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7fb;color:#1f2328}
.card{background:#fff;padding:40px 48px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);max-width:440px;text-align:center}
.icon{font-size:44px;margin-bottom:8px;color:${ok ? '#1a7f37' : '#cf222e'}}h1{font-size:20px;margin:0 0 8px}p{color:#57606a;margin:0;line-height:1.5}</style></head>
<body><div class="card"><div class="icon">${ok ? '&#10004;' : '&#10006;'}</div><h1>${title}</h1><p>${text}</p></div></body></html>`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export default async function authRoutes(app) {
  const { oauth } = app.ctx;

  app.get('/status', async () => oauth.status());

  // Bağlı hesabın profil resmi (img etiketi başlık gönderemediği için anahtar ?key= ile gelir)
  app.get('/avatar', async (req, reply) => {
    const p = oauth.avatarPath;
    if (!oauth.status().connected || !p || !fs.existsSync(p)) return reply.code(404).send({ error: 'not_found' });
    const buf = fs.readFileSync(p);
    const type = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : buf.subarray(0, 4).toString() === 'RIFF' ? 'image/webp' : 'image/gif';
    reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=31536000').header('X-Content-Type-Options', 'nosniff');
    return buf;
  });

  app.put('/config', async (req) => oauth.setConfig(req.body ?? {}));

  app.post('/start', async () => oauth.startAuth());

  app.post('/disconnect', async () => {
    const { sender } = app.ctx;
    if (sender.active) throw new AppError('campaign.another_running');
    oauth.disconnect({ revoke: true });
    return oauth.status();
  });

  // Google'ın tarayıcıyı yönlendirdiği loopback adresi (oturum anahtarı gerektirmez; state ile korunur).
  app.get('/callback', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    try {
      const { email } = await oauth.handleCallback(req.query ?? {});
      return PAGE(
        true,
        'Hesap bağlandı · Account connected',
        `<b>${escape(email)}</b><br>GmailFlow'a geri dönebilirsiniz.<br>You can return to GmailFlow.`,
      );
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'auth.failed';
      return PAGE(false, 'Bağlantı başarısız · Connection failed', `${escape(code)}<br>${escape(err?.params?.detail ?? '')}`);
    }
  });
}
