/**
 * Generate Expo icon / adaptive-icon / splash from assets/branding/s4-logo-full.png
 * Run from security-mobile-app: node scripts/build-s4-assets.cjs
 */
const path = require('node:path');
const Jimp = require('jimp');

const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'assets', 'branding', 's4-logo-full.png');

async function main() {
  const logo = await Jimp.read(srcPath);
  const W = logo.bitmap.width;
  const H = logo.bitmap.height;

  const side = Math.min(W, Math.round(H * 0.46));
  const x = Math.floor((W - side) / 2);
  const icon = logo.clone().crop(x, 0, side, side).resize(1024, 1024);
  await icon.writeAsync(path.join(root, 'assets', 'icon.png'));
  await icon.clone().writeAsync(path.join(root, 'assets', 'adaptive-icon.png'));

  const sw = 1284;
  const sh = 2778;
  const bg = new Jimp(sw, sh, 0x000000ff);
  const scale = Math.min((sw * 0.9) / W, (sh * 0.58) / H);
  const tw = Math.round(W * scale);
  const th = Math.round(H * scale);
  const scaled = logo.clone().resize(tw, th);
  const px = Math.floor((sw - tw) / 2);
  const py = Math.floor((sh - th) / 2);
  bg.composite(scaled, px, py);
  await bg.writeAsync(path.join(root, 'assets', 'splash.png'));

  console.log('Wrote assets/icon.png, assets/adaptive-icon.png, assets/splash.png');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
