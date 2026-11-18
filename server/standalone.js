// Geliştirme girişi (Docker veya tarayıcı modu). Electron olmadan API'yi çalıştırır.
import path from 'node:path';
import { buildApp } from './app.js';
import { FileSecretStore } from './lib/secret-store.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.GMAILFLOW_DATA_DIR ?? '.devdata');
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;

console.warn('[gmailflow] Geliştirme modu: gizli bilgiler şifrelenmeden saklanır →', path.join(dataDir, 'secrets.json'));

const app = await buildApp({
  dataDir,
  secretStore: await FileSecretStore.open(path.join(dataDir, 'secrets.json')),
  getPublicOrigin: () => publicOrigin,
  locale: process.env.GMAILFLOW_LOCALE ?? 'tr',
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

await app.listen({ host, port });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
