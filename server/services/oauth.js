import crypto from 'node:crypto';
import fs from 'node:fs';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { AppError } from '../lib/errors.js';
import { nowIso } from '../db/index.js';

const G = 'https://www.googleapis.com/auth/';
export const SEND_SCOPE = `${G}gmail.send`;
// Posta istemcisi: okuma + etiket/çöp işlemleri (modify) ve taslaklar (compose).
export const MAIL_SCOPES = [`${G}gmail.modify`, `${G}gmail.compose`];
export const SCOPES = [SEND_SCOPE, ...MAIL_SCOPES, 'openid', 'email', 'profile'];
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const SECRET_KEY = 'oauth_client_secret';
const REFRESH_KEY = 'oauth_refresh_token';
const STATE_TTL_MS = 10 * 60 * 1000;
const CLIENT_ID_RE = /^[\w.-]+\.apps\.googleusercontent\.com$/;
// Google client secret'ları: "GOCSPX-…" (yeni) veya ~24 karakterlik eski biçim. Boşluk/tırnak/{ içeremez.
const CLIENT_SECRET_RE = /^[\w-]{10,100}$/;

/**
 * Google Cloud Console'dan indirilen client_secret_….json içeriğini çözer.
 * Yalnızca "Desktop app" (installed) istemcileri kabul edilir.
 */
export function parseClientJson(text) {
  let obj;
  try {
    obj = JSON.parse(String(text ?? '').trim());
  } catch {
    throw new AppError('auth.invalid_json');
  }
  if (obj?.web && !obj?.installed) throw new AppError('auth.wrong_client_type');
  const c = obj?.installed ?? obj;
  const clientId = String(c?.client_id ?? '').trim();
  const clientSecret = String(c?.client_secret ?? '').trim();
  if (!clientId || !clientSecret) throw new AppError('auth.invalid_json');
  return { clientId, clientSecret };
}

const looksLikeJson = (s) => String(s ?? '').trim().startsWith('{');

/**
 * Kullanıcının kendi Google Cloud projesindeki "Desktop app" OAuth istemcisiyle
 * PKCE + loopback yönlendirme akışı. Refresh token yalnızca secretStore'da tutulur.
 */
export class OAuthService {
  constructor({ db, settings, secretStore, getRedirectUri, log = () => {}, avatarPath = null, fetchImpl = (...a) => fetch(...a) }) {
    this.db = db;
    this.settings = settings;
    this.secrets = secretStore;
    this.getRedirectUri = getRedirectUri;
    this.log = log;
    this.avatarPath = avatarPath;
    this.fetch = fetchImpl;
    this.pending = new Map(); // state → { verifier, redirectUri, created }
    this.client = null;
    this.onConnectionChange = () => {};
    this.#repairStoredSecret();
  }

  /**
   * Önceki sürümler Client Secret alanına yapıştırılan JSON dosyasının tamamını kontrol etmeden
   * kaydediyordu (Google "invalid_client" döner). Böyle bir kayıt varsa içindeki secret'a düzeltilir.
   */
  #repairStoredSecret() {
    const stored = this.secrets.get(SECRET_KEY);
    if (!looksLikeJson(stored)) return;
    try {
      const { clientId, clientSecret } = parseClientJson(stored);
      if (!CLIENT_SECRET_RE.test(clientSecret)) return;
      this.secrets.set(SECRET_KEY, clientSecret);
      if (!this.settings.get('oauth_client_id') && CLIENT_ID_RE.test(clientId)) this.settings.set('oauth_client_id', clientId);
      this.log('warn', null, 'auth.secret_repaired', '');
    } catch {
      /* çözülemeyen kayıt: kullanıcı yeniden girene kadar bağlantı hatası verir */
    }
  }

  status() {
    const account = this.db.prepare('SELECT email, connected_at FROM account WHERE id = 1').get();
    const clientId = this.settings.get('oauth_client_id');
    const granted = String(this.settings.get('oauth_scopes') ?? '').split(' ').filter(Boolean);
    const connected = Boolean(account && this.secrets.get(REFRESH_KEY));
    return {
      configured: Boolean(clientId && this.secrets.get(SECRET_KEY)),
      clientId: clientId || '',
      connected,
      grantedScopes: granted,
      // Bağlı ama posta izinleri yoksa (eski sürümde bağlanmış) → "Yeniden bağlan" gerekir.
      mailReady: connected && MAIL_SCOPES.every((sc) => granted.includes(sc)),
      email: account?.email ?? null,
      connectedAt: account?.connected_at ?? null,
      redirectUri: this.getRedirectUri(),
      secretsEncrypted: this.secrets.encrypted,
      name: connected ? this.settings.get('account_name') || null : null,
      // Önbellekteki profil resmi; ?v= tarayıcı önbelleğini her yeni resimde geçersiz kılar
      avatarUrl: connected && this.avatarPath && fs.existsSync(this.avatarPath) ? `/api/auth/avatar?v=${this.settings.get('avatar_version') ?? 0}` : null,
    };
  }

  /**
   * İstemci bilgilerini kaydeder. Üç kullanım desteklenir:
   *  - { json }: indirilen JSON dosyasının içeriği
   *  - Client ID veya Client Secret alanına JSON'un tamamı yapıştırılmışsa otomatik çözülür
   *  - { clientId, clientSecret }: ayrı ayrı girilen değerler
   */
  setConfig({ clientId, clientSecret, json } = {}) {
    if (json != null || looksLikeJson(clientSecret) || looksLikeJson(clientId)) {
      ({ clientId, clientSecret } = parseClientJson(json ?? (looksLikeJson(clientSecret) ? clientSecret : clientId)));
    }
    clientId = String(clientId ?? '').trim();
    clientSecret = String(clientSecret ?? '').trim();
    if (!CLIENT_ID_RE.test(clientId)) throw new AppError('auth.invalid_client_id');
    if (clientSecret && !CLIENT_SECRET_RE.test(clientSecret)) throw new AppError('auth.invalid_client_secret');
    const prev = this.settings.get('oauth_client_id');
    if (!clientSecret && !(prev === clientId && this.secrets.get(SECRET_KEY))) throw new AppError('auth.client_secret_required');
    if (prev && prev !== clientId) this.disconnect({ revoke: false }); // farklı istemci → eski token geçersiz
    this.settings.set('oauth_client_id', clientId);
    if (clientSecret) this.secrets.set(SECRET_KEY, clientSecret);
    this.client = null;
    return this.status();
  }

  #newClient(redirectUri) {
    const clientId = this.settings.get('oauth_client_id');
    const clientSecret = this.secrets.get(SECRET_KEY);
    if (!clientId || !clientSecret) throw new AppError('auth.not_configured');
    return new OAuth2Client({ clientId, clientSecret, redirectUri });
  }

  async startAuth() {
    const redirectUri = this.getRedirectUri();
    const client = this.#newClient(redirectUri);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.created > STATE_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { verifier: codeVerifier, redirectUri, created: now });
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent', // her bağlantıda refresh token alınmasını garanti eder
      scope: SCOPES,
      include_granted_scopes: false,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      state,
    });
    return { url };
  }

  async handleCallback(query) {
    try {
      return await this.#handleCallback(query);
    } catch (err) {
      // Bağlantı hataları Kayıtlar ekranında görünsün (secret asla yazılmaz)
      this.log('error', null, 'auth.failed', `${err.code ?? 'error'}${err.params?.detail ? ` — ${err.params.detail}` : ''}`);
      throw err;
    }
  }

  async #handleCallback({ code, state, error }) {
    if (error) throw new AppError(error === 'access_denied' ? 'auth.denied' : 'auth.failed', 400, { detail: error });
    const entry = this.pending.get(state);
    if (!entry || Date.now() - entry.created > STATE_TTL_MS) throw new AppError('auth.invalid_state');
    this.pending.delete(state);

    const client = this.#newClient(entry.redirectUri);
    let tokens;
    try {
      ({ tokens } = await client.getToken({ code, codeVerifier: entry.verifier }));
    } catch (err) {
      const data = err?.response?.data ?? {};
      const detail = [data.error, data.error_description].filter(Boolean).join(': ') || err.message;
      // invalid_client: Client Secret hatalı, istemci silinmiş ya da secret yenilenmiş
      throw new AppError(data.error === 'invalid_client' ? 'auth.invalid_client' : 'auth.failed', 400, { detail });
    }
    const granted = String(tokens.scope ?? '').split(' ');
    if (!granted.includes(SEND_SCOPE)) throw new AppError('auth.scope_missing');
    if (!tokens.refresh_token) throw new AppError('auth.no_refresh_token');

    const profile = parseIdToken(tokens.id_token);
    const email = profile && profile.email_verified !== false ? profile.email ?? null : null;
    if (!email) throw new AppError('auth.failed', 400, { detail: 'id_token' });
    this.settings.set('account_name', profile.name ?? '');
    await this.#saveAvatar(profile.picture);

    this.secrets.set(REFRESH_KEY, tokens.refresh_token);
    this.settings.set('oauth_scopes', granted.join(' '));
    this.db
      .prepare('INSERT INTO account (id, email, connected_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, connected_at = excluded.connected_at')
      .run(email, nowIso());
    this.client = null;
    this.onConnectionChange(this.status());
    return { email };
  }

  /**
   * Google hesabının profil fotoğrafını (Gmail'de görünen resim) bir kez indirip saklar;
   * böylece uygulama her açılışta Google'a istek atmaz ve çevrimdışıyken de görünür.
   */
  async #saveAvatar(url) {
    if (!this.avatarPath) return;
    try {
      fs.rmSync(this.avatarPath, { force: true });
      if (!url || !/^https:\/\/[\w.-]+\.googleusercontent\.com\//.test(url)) return;
      // Google resim adresleri boyut eki taşır (…=s96-c) → daha net bir 256 px sürüm iste
      const sized = /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, '=s256-c') : url;
      const res = await this.fetch(sized);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > AVATAR_MAX_BYTES) return;
      fs.writeFileSync(this.avatarPath, buf);
      this.settings.set('avatar_version', Date.now());
    } catch (err) {
      this.log('warn', null, 'auth.avatar_failed', err?.message ?? String(err));
    }
  }

  /** Geçerli bir erişim token'ı döner (gerekirse otomatik yeniler). */
  async getAccessToken() {
    const refresh = this.secrets.get(REFRESH_KEY);
    if (!refresh) throw new AppError('auth.not_connected', 401);
    if (!this.client) {
      this.client = this.#newClient(this.getRedirectUri());
      this.client.setCredentials({ refresh_token: refresh });
    }
    try {
      const { token } = await this.client.getAccessToken();
      if (!token) throw new Error('empty token');
      return token;
    } catch (err) {
      const reason = err?.response?.data?.error;
      if (reason === 'invalid_grant' || reason === 'invalid_client' || reason === 'unauthorized_client') {
        this.log('error', null, 'auth.failed', [reason, err?.response?.data?.error_description].filter(Boolean).join(': '));
        // Token iptal edilmiş / süresi dolmuş (Testing modunda 7 gün) → yeniden bağlanmak gerekir.
        this.disconnect({ revoke: false });
        throw new AppError('auth.reconnect_required', 401);
      }
      throw err;
    }
  }

  /** Bir sonraki çağrıda token'ın yeniden alınmasını zorlar (401 sonrası). */
  invalidateAccessToken() {
    if (this.client) this.client.credentials.access_token = undefined;
    this.client = null;
  }

  disconnect({ revoke = true } = {}) {
    const refresh = this.secrets.get(REFRESH_KEY);
    if (revoke && refresh) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
    }
    this.secrets.delete(REFRESH_KEY);
    this.settings.set('oauth_scopes', '');
    this.settings.set('account_name', '');
    if (this.avatarPath) fs.rmSync(this.avatarPath, { force: true });
    this.db.prepare('DELETE FROM account').run();
    this.client = null;
    this.onConnectionChange(this.status());
  }
}

/** id_token içeriği: email, email_verified, name, picture (profile izniyle). */
function parseIdToken(idToken) {
  try {
    // Token, TLS üzerinden doğrudan Google'ın token uç noktasından alındığı için imza doğrulaması gerekmez.
    return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
