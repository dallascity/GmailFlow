import { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog, nativeTheme, Notification } from 'electron';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

// Kullanıcı verileri: %APPDATA%\GmailFlow (güncelleme / yeniden kurulumda korunur)
app.setName('GmailFlow');
app.setAppUserModelId('com.gmailflow.app');
if (process.env.GMAILFLOW_DATA_DIR) app.setPath('userData', path.resolve(process.env.GMAILFLOW_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow = null;
  let server = null;
  let origin = null;
  const apiKey = crypto.randomBytes(32).toString('hex');

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  async function startServer() {
    const { buildApp } = await import('../server/app.js');
    const { FileSecretStore } = await import('../server/lib/secret-store.js');
    const dataDir = app.getPath('userData');
    const cipher = (await safeStorage.isAsyncEncryptionAvailable())
      ? {
          encrypt: (s) => safeStorage.encryptStringAsync(s),
          decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result,
        }
      : null;
    const port = Number(process.env.GMAILFLOW_PORT ?? 0);
    const fastify = await buildApp({
      dataDir,
      secretStore: await FileSecretStore.open(path.join(dataDir, 'secrets.json'), cipher),
      apiKey,
      staticDir: isDev ? null : path.join(__dirname, '..', 'dist-renderer'),
      getPublicOrigin: () => origin,
      allowedHosts: () => (origin ? [new URL(origin).host, `localhost:${new URL(origin).port}`] : []),
      locale: app.getLocale(),
    });
    await fastify.listen({ host: '127.0.0.1', port });
    const actualPort = fastify.server.address().port;
    origin = `http://127.0.0.1:${actualPort}`;
    return { fastify, port: actualPort, dataDir };
  }

  function createWindow(port) {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1000,
      minHeight: 640,
      show: false,
      title: 'GmailFlow',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7fb',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    const appUrl = isDev ? process.env.VITE_DEV_SERVER_URL : `http://127.0.0.1:${port}/`;
    const appOrigin = new URL(appUrl).origin;

    // Dış bağlantılar (Google girişi, yardım linkleri) her zaman varsayılan tarayıcıda açılır.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (new URL(url).origin !== appOrigin) {
        e.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.loadURL(appUrl);
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      server = await startServer();
    } catch (err) {
      dialog.showErrorBox('GmailFlow', `Uygulama başlatılamadı / Failed to start:\n\n${err?.stack ?? err}`);
      app.exit(1);
      return;
    }

    ipcMain.on('gf:config', (e) => {
      e.returnValue = { apiKey, dataDir: server.dataDir, version: app.getVersion(), desktop: true };
    });
    ipcMain.handle('gf:open-data-dir', () => shell.openPath(server.dataDir));
    ipcMain.handle('gf:open-external', (_e, url) => {
      if (/^https:\/\//i.test(String(url))) return shell.openExternal(url);
      return false;
    });

    createWindow(server.port);
    setupMailNotifications(server.fastify.ctx);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(server.port);
    });
  });

  /** Yeni gelen postalar için Windows bildirimi; aynı anda çok posta gelirse tek özet bildirim. */
  function setupMailNotifications(ctx) {
    let buffer = [];
    let timer = null;
    const icon = path.join(__dirname, '..', 'build', 'icon.png');
    const tr = () => (ctx.settings.get('language') ?? (app.getLocale().startsWith('tr') ? 'tr' : 'en')) === 'tr';
    const openThread = (threadId) => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      const hash = threadId ? `#/mail/INBOX?thread=${threadId}` : '#/mail/INBOX';
      mainWindow.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    };
    const flush = () => {
      timer = null;
      const items = buffer;
      buffer = [];
      if (!items.length || !ctx.settings.get('mail_notifications') || !Notification.isSupported()) return;
      let n;
      if (items.length <= 3) {
        for (const m of items) {
          n = new Notification({ title: m.from?.name || m.from?.email || 'GmailFlow', body: m.subject || m.snippet || '', icon });
          n.on('click', () => openThread(m.threadId));
          n.show();
        }
      } else {
        n = new Notification({ title: 'GmailFlow', body: tr() ? `${items.length} yeni posta` : `${items.length} new messages`, icon });
        n.on('click', () => openThread(null));
        n.show();
      }
      if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
    };
    ctx.bus.on('event', (e) => {
      if (e.type !== 'mail:new') return;
      buffer.push(e.message);
      if (!timer) timer = setTimeout(flush, 1200);
    });
  }

  let quitting = false;
  app.on('before-quit', async (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    try {
      await server.fastify.close(); // aktif gönderim düzgünce durdurulur
    } finally {
      app.quit();
    }
  });

  app.on('window-all-closed', () => app.quit());
}
