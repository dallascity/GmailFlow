import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { buildApp } from '../server/app.js';
import { MemorySecretStore } from '../server/lib/secret-store.js';
import { parseClientJson } from '../server/services/oauth.js';

// Uydurma değerler (gerçek bir istemciye ait değil)
const ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const SECRET = 'GOCSPX-TestSecretValue1234567890ab';
const INSTALLED_JSON = JSON.stringify({
  installed: {
    client_id: ID,
    project_id: 'demo-123',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_secret: SECRET,
    redirect_uris: ['http://localhost'],
  },
});

let app;
let dir;
let secrets;
const put = async (payload) => {
  const r = await app.inject({ method: 'PUT', url: '/api/auth/config', payload });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};
const logs = () => app.ctx.db.prepare('SELECT code, message FROM events_log ORDER BY id').all();

async function start(store = new MemorySecretStore()) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-oauth-'));
  secrets = store;
  app = await buildApp({ dataDir: dir, secretStore: secrets, getPublicOrigin: () => 'http://127.0.0.1:1', mailSync: false });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('parseClientJson', () => {
  it('reads the downloaded Desktop client file', () => {
    expect(parseClientJson(INSTALLED_JSON)).toEqual({ clientId: ID, clientSecret: SECRET });
  });
  it('rejects web clients and garbage', () => {
    expect(() => parseClientJson(JSON.stringify({ web: { client_id: ID, client_secret: SECRET } }))).toThrow(expect.objectContaining({ code: 'auth.wrong_client_type' }));
    expect(() => parseClientJson('{not json')).toThrow(expect.objectContaining({ code: 'auth.invalid_json' }));
    expect(() => parseClientJson('{"installed":{}}')).toThrow(expect.objectContaining({ code: 'auth.invalid_json' }));
  });
});

describe('istemci yapılandırması', () => {
  beforeEach(() => start());

  it('accepts the JSON file content', async () => {
    const r = await put({ json: INSTALLED_JSON });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ clientId: ID, configured: true });
    expect(secrets.get('oauth_client_secret')).toBe(SECRET);
  });

  it('extracts the secret when the whole JSON is pasted into the secret field (the reported bug)', async () => {
    const r = await put({ clientId: '', clientSecret: INSTALLED_JSON });
    expect(r.status).toBe(200);
    expect(secrets.get('oauth_client_secret')).toBe(SECRET);
    expect(app.ctx.settings.get('oauth_client_id')).toBe(ID);
  });

  it('rejects malformed secrets and web clients', async () => {
    for (const bad of ['GOCSPX abc def ghi', '"GOCSPX-abcdefghijk"', 'kısa']) {
      expect((await put({ clientId: ID, clientSecret: bad })).body.error, bad).toBe('auth.invalid_client_secret');
    }
    expect((await put({ json: JSON.stringify({ web: { client_id: ID, client_secret: SECRET } }) })).body.error).toBe('auth.wrong_client_type');
    // trim: baştaki/sondaki boşluklar sorun değil
    expect((await put({ clientId: ` ${ID} `, clientSecret: ` ${SECRET}\n` })).status).toBe(200);
    expect(secrets.get('oauth_client_secret')).toBe(SECRET);
  });

  it('reports invalid_client from Google clearly and logs it', async () => {
    await put({ json: INSTALLED_JSON });
    const { url } = await app.ctx.oauth.startAuth();
    const state = new URL(url).searchParams.get('state');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockRejectedValue({ response: { data: { error: 'invalid_client', error_description: 'Unauthorized' } }, message: 'invalid_client' });
    const r = await app.inject({ method: 'GET', url: `/api/auth/callback?code=x&state=${state}` });
    expect(r.body).toContain('auth.invalid_client');
    expect(r.body).toContain('invalid_client: Unauthorized');
    expect(logs()).toEqual([{ code: 'auth.failed', message: 'auth.invalid_client — invalid_client: Unauthorized' }]);
    expect(JSON.stringify(logs())).not.toContain(SECRET);
  });
});

describe('otomatik onarım', () => {
  it('repairs a stored secret that contains the whole JSON file', async () => {
    const store = new MemorySecretStore();
    store.set('oauth_client_secret', INSTALLED_JSON);
    await start(store);
    expect(secrets.get('oauth_client_secret')).toBe(SECRET);
    expect(app.ctx.settings.get('oauth_client_id')).toBe(ID);
    expect(logs().map((l) => l.code)).toEqual(['auth.secret_repaired']);
  });

  it('leaves a correct secret untouched', async () => {
    const store = new MemorySecretStore();
    store.set('oauth_client_secret', SECRET);
    await start(store);
    expect(secrets.get('oauth_client_secret')).toBe(SECRET);
    expect(logs()).toEqual([]);
  });
});

describe('profil resmi', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

  async function connect(picture) {
    const fetched = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-avatar-'));
    secrets = new MemorySecretStore();
    app = await buildApp({
      dataDir: dir,
      secretStore: secrets,
      getPublicOrigin: () => 'http://127.0.0.1:1',
      mailSync: false,
      oauthFetch: async (url) => {
        fetched.push(url);
        return { ok: true, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => PNG };
      },
    });
    await put({ json: INSTALLED_JSON });
    const { url } = await app.ctx.oauth.startAuth();
    expect(new URL(url).searchParams.get('scope')).toContain('profile');
    vi.spyOn(OAuth2Client.prototype, 'getToken').mockResolvedValue({
      tokens: {
        refresh_token: 'r',
        scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.profile openid',
        id_token: idToken({ email: 'ben@gmail.com', email_verified: true, name: 'Eymen N.', picture }),
      },
    });
    await app.inject({ method: 'GET', url: `/api/auth/callback?code=x&state=${new URL(url).searchParams.get('state')}` });
    return fetched;
  }

  it('downloads the Google profile picture once (256 px) and serves it locally', async () => {
    const fetched = await connect('https://lh3.googleusercontent.com/a/ACg8abc=s96-c');
    expect(fetched).toEqual(['https://lh3.googleusercontent.com/a/ACg8abc=s256-c']);
    const status = app.ctx.oauth.status();
    expect(status).toMatchObject({ connected: true, name: 'Eymen N.', email: 'ben@gmail.com' });
    expect(status.avatarUrl).toMatch(/^\/api\/auth\/avatar\?v=\d+$/);
    const img = await app.inject({ method: 'GET', url: status.avatarUrl });
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    // bağlantı kesilince resim silinir
    app.ctx.oauth.disconnect({ revoke: false });
    expect(app.ctx.oauth.status().avatarUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/auth/avatar' })).statusCode).toBe(404);
  });

  it('ignores picture URLs that are not on Google servers', async () => {
    const fetched = await connect('https://evil.example.com/p.png');
    expect(fetched).toEqual([]);
    expect(app.ctx.oauth.status()).toMatchObject({ connected: true, avatarUrl: null });
  });
});
