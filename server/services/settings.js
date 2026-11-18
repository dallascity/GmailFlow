export const ACCOUNT_LIMITS = {
  // Google'ın yayımladığı resmi günlük alıcı limitleri ve uygulamanın uyguladığı güvenli üst sınır.
  personal: { google: 500, safe: 450 },
  workspace: { google: 2000, safe: 1800 },
};

export const MIN_DELAY_SEC = 1;
export const MAX_DELAY_SEC = 3600;

const DEFAULTS = {
  language: null, // null → işletim sistemi dili
  theme: 'system',
  account_type: 'personal',
  daily_limit: ACCOUNT_LIMITS.personal.safe,
  default_delay_sec: 10,
  oauth_client_id: '',
  oauth_scopes: '',
  mail_cache_days: 30,
  mail_notifications: true,
  mail_signature: '',
  mail_images: 'ask', // ask | always
  list_unsubscribe_default: true,
};

const PUBLIC_KEYS = [
  'language',
  'theme',
  'account_type',
  'daily_limit',
  'default_delay_sec',
  'mail_cache_days',
  'mail_notifications',
  'mail_signature',
  'mail_images',
  'list_unsubscribe_default',
];

export class SettingsService {
  constructor(db) {
    this.db = db;
  }

  getAll() {
    const out = { ...DEFAULTS };
    for (const r of this.db.prepare('SELECT key, value FROM settings').all()) out[r.key] = JSON.parse(r.value);
    return out;
  }

  get(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : DEFAULTS[key];
  }

  set(key, value) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  /** Kullanıcının değiştirebildiği ayarları doğrulayıp kaydeder. */
  update(patch) {
    for (const key of Object.keys(patch)) {
      if (!PUBLIC_KEYS.includes(key)) continue;
      let v = patch[key];
      if (key === 'language' && !['tr', 'en', null].includes(v)) continue;
      if (key === 'theme' && !['system', 'light', 'dark'].includes(v)) continue;
      if (key === 'account_type' && !ACCOUNT_LIMITS[v]) continue;
      if (key === 'daily_limit') v = Math.max(1, Math.round(Number(v) || 1));
      if (key === 'default_delay_sec') v = clampDelay(v);
      if (key === 'mail_cache_days') v = Math.max(7, Math.min(365, Math.round(Number(v) || 30)));
      if (key === 'mail_notifications' || key === 'list_unsubscribe_default') v = Boolean(v);
      if (key === 'mail_signature') v = String(v ?? '').slice(0, 20000);
      if (key === 'mail_images' && !['ask', 'always'].includes(v)) continue;
      this.set(key, v);
    }
    // Hesap türü değişip limit verilmediyse yeni türün güvenli sınırı varsayılır.
    const cap = this.dailyCap();
    if (patch.account_type && patch.daily_limit == null) this.set('daily_limit', cap);
    if (this.get('daily_limit') > cap) this.set('daily_limit', cap);
    return this.getPublic();
  }

  getPublic() {
    const all = this.getAll();
    const out = {};
    for (const k of PUBLIC_KEYS) out[k] = all[k];
    out.daily_cap = this.dailyCap();
    out.google_limit = (ACCOUNT_LIMITS[all.account_type] ?? ACCOUNT_LIMITS.personal).google;
    return out;
  }

  dailyCap() {
    return (ACCOUNT_LIMITS[this.get('account_type')] ?? ACCOUNT_LIMITS.personal).safe;
  }

  /** Günlük limit, seçili hesap türünün güvenli üst sınırını asla aşamaz. */
  effectiveDailyLimit() {
    const cap = this.dailyCap();
    const v = Number(this.get('daily_limit')) || cap;
    return Math.max(1, Math.min(v, cap));
  }
}

export function clampDelay(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 10;
  return Math.max(MIN_DELAY_SEC, Math.min(MAX_DELAY_SEC, n));
}
