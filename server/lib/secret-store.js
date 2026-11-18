import fs from 'node:fs';
import path from 'node:path';

/**
 * Küçük bir anahtar/değer gizli bilgi deposu.
 *
 * Electron'da `cipher` olarak safeStorage'ın async API'si (Windows DPAPI) verilir; refresh token
 * ve client secret diskte şifreli durur. Değerler açılışta bir kez çözülüp bellekte tutulur,
 * böylece okuma senkron kalır; yazma işlemleri sıraya alınıp şifrelenerek diske yazılır.
 * Docker/dev ortamında cipher verilmezse değerler düz metin saklanır.
 *
 * cipher: { encrypt(string): Promise<Buffer>, decrypt(Buffer): Promise<string> }
 */
export class FileSecretStore {
  static async open(filePath, cipher = null) {
    const store = new FileSecretStore(filePath, cipher);
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      raw = {};
    }
    for (const [key, entry] of Object.entries(raw)) {
      try {
        if (entry.enc) {
          if (cipher) store.values.set(key, await cipher.decrypt(Buffer.from(entry.v, 'base64')));
        } else {
          store.values.set(key, entry.v);
        }
      } catch {
        // Başka bir Windows kullanıcısında/bilgisayarda şifre çözülemez → yok say.
      }
    }
    return store;
  }

  constructor(filePath, cipher = null) {
    this.filePath = filePath;
    this.cipher = cipher;
    this.values = new Map();
    this.writing = Promise.resolve();
  }

  get encrypted() {
    return Boolean(this.cipher);
  }

  get(key) {
    return this.values.get(key) ?? null;
  }

  set(key, value) {
    if (value == null) return this.delete(key);
    this.values.set(key, String(value));
    this.#scheduleFlush();
  }

  delete(key) {
    this.values.delete(key);
    this.#scheduleFlush();
  }

  /** Bekleyen yazmaların bitmesini bekler (kapanışta). */
  flushed() {
    return this.writing;
  }

  #scheduleFlush() {
    const snapshot = new Map(this.values);
    this.writing = this.writing
      .then(async () => {
        const out = {};
        for (const [k, v] of snapshot) {
          out[k] = this.cipher ? { enc: true, v: (await this.cipher.encrypt(v)).toString('base64') } : { enc: false, v };
        }
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, this.filePath);
      })
      .catch((err) => console.error('[secret-store] yazılamadı:', err));
  }
}

/** Testler için bellek içi depo. */
export class MemorySecretStore {
  constructor() {
    this.map = new Map();
  }
  get encrypted() {
    return false;
  }
  get(k) {
    return this.map.get(k) ?? null;
  }
  set(k, v) {
    if (v == null) this.map.delete(k);
    else this.map.set(k, String(v));
  }
  delete(k) {
    this.map.delete(k);
  }
  flushed() {
    return Promise.resolve();
  }
}
