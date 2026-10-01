// Renders build/icon.svg to build/icon.png (512px, used by electron-builder for
// all platforms and by the BrowserWindow on Linux) and composes the NSIS
// installer sidebar build/installerSidebar.bmp (164x314, 24-bit as NSIS requires).
// Run with: npm run icon
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const buildDir = path.join(__dirname, '..', 'build');
const svg64 = fs.readFileSync(path.join(buildDir, 'icon.svg')).toString('base64');

// NSIS sidebars must be uncompressed 24-bit BMP; Chromium's canvas can't export
// that, so take the canvas RGBA pixels and write the BMP (bottom-up, BGR) here.
function writeBmp(file, rgba, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (height - 1 - y) * rowSize + x * 3;
      data[dst] = rgba[src + 2];
      data[dst + 1] = rgba[src + 1];
      data[dst + 2] = rgba[src];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM');
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10); // pixel data offset
  header.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(data.length, 34);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  const run = (js) => win.webContents.executeJavaScript(js);

  const loadIcon = `
    window.icon = new Image();
    new Promise((resolve, reject) => {
      icon.onload = () => resolve('ok');
      icon.onerror = () => reject(new Error('SVG failed to load'));
      icon.src = 'data:image/svg+xml;base64,${svg64}';
    })
  `;
  await run(loadIcon);

  const pngUrl = await run(`{
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    c.getContext('2d').drawImage(icon, 0, 0, 512, 512);
    c.toDataURL('image/png');
  }`);
  fs.writeFileSync(path.join(buildDir, 'icon.png'), Buffer.from(pngUrl.split(',')[1], 'base64'));
  console.log('wrote build/icon.png');

  const sidebar64 = await run(`{
    const W = 164, H = 314;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b3d6e');
    g.addColorStop(1, '#13151a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(icon, (W - 108) / 2, 64, 108, 108);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = '600 22px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Dev Box', W / 2, 212);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Microsoft Dev Box client', W / 2, 234);
    const d = ctx.getImageData(0, 0, W, H).data;
    let s = '';
    for (let i = 0; i < d.length; i += 8192) s += String.fromCharCode.apply(null, d.subarray(i, i + 8192));
    btoa(s);
  }`);
  writeBmp(path.join(buildDir, 'installerSidebar.bmp'), Buffer.from(sidebar64, 'base64'), 164, 314);
  console.log('wrote build/installerSidebar.bmp');
  app.quit();
});
