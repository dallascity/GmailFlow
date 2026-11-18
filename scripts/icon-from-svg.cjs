// Uygulama ikonunu build/gmailflow.svg dosyasından üretir.
// Kullanım: npm run icon   (Electron'un tarayıcı motoruyla her boyut ayrı ayrı vektörden çizilir)
//   → build/icon.png (512×512), build/icon.ico (16–256 px, PNG gömülü),
//     renderer/src/assets/logo.png (uygulama içi logo ve sekme ikonu, kırpılmış 256 px)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const SRC = path.join(root, 'build', 'gmailflow.svg');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(SRC, 'utf8');
    if (/<script|<foreignObject|href\s*=\s*["']https?:/i.test(svg)) throw new Error('SVG betik veya dış kaynak içeremez');
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
    await win.loadURL('data:text/html,<!doctype html><html><body></body></html>');
    const sizes = [...ICO_SIZES, 512];
    const dataUrls = await win.webContents.executeJavaScript(`(async () => {
      const svg = ${JSON.stringify(svg)};
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      // Görünen içeriğin sınırlarını bul (SVG'deki boş kenarlar küçük boyutlarda ikonu küçültür)
      const W = img.naturalWidth || 512, H = img.naturalHeight || 512, R = 1024;
      const probe = document.createElement('canvas');
      probe.width = probe.height = R;
      const pctx = probe.getContext('2d');
      pctx.drawImage(img, 0, 0, R, R);
      const px = pctx.getImageData(0, 0, R, R).data;
      let x0 = R, y0 = R, x1 = 0, y1 = 0;
      for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
        if (px[(y * R + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      }
      // Kare, ortalanmış, %4 kenar payı; SVG koordinatlarına çevir
      const side = Math.min(R, Math.max(x1 - x0, y1 - y0) * 1.08);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const sx = Math.max(0, Math.min(R - side, cx - side / 2)) * (W / R);
      const sy = Math.max(0, Math.min(R - side, cy - side / 2)) * (H / R);
      const sw = side * (W / R), sh = side * (H / R);
      return ${JSON.stringify(sizes)}.map((s) => {
        const c = document.createElement('canvas');
        c.width = c.height = s;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, s, s);
        return c.toDataURL('image/png');
      });
    })()`);
    const pngs = dataUrls.map((u, i) => ({ size: sizes[i], data: Buffer.from(u.split(',')[1], 'base64') }));
    fs.writeFileSync(path.join(root, 'build', 'icon.png'), pngs.at(-1).data);
    fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs.filter((p) => ICO_SIZES.includes(p.size))));
    const assets = path.join(root, 'renderer', 'src', 'assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'logo.png'), pngs.find((p) => p.size === 256).data);
    console.log(`ikonlar üretildi: build/icon.png (512), build/icon.ico (${ICO_SIZES.join(', ')}), renderer/src/assets/logo.png`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
