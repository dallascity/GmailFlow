// Renderer'a yalnızca gereken, dar bir köprü açılır (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

const config = ipcRenderer.sendSync('gf:config');

contextBridge.exposeInMainWorld('gmailflow', {
  desktop: true,
  apiKey: config.apiKey,
  dataDir: config.dataDir,
  version: config.version,
  openDataDir: () => ipcRenderer.invoke('gf:open-data-dir'),
  openExternal: (url) => ipcRenderer.invoke('gf:open-external', url),
});
