/**
 * Generate the Expo launcher assets from the approved S4 brand masters.
 * Run from security-mobile-app: node scripts/build-s4-assets.cjs
 *
 * Sources (copied verbatim from the approved S4 brand pack, 03_App):
 *   assets/branding/s4-app-icon-1024.png   opaque 1024 master  -> app icon, iOS icon, web favicon
 *   assets/branding/s4-app-glyph-1024.png  transparent glyph   -> Android adaptive foreground, splash
 *
 * The artwork is never redrawn, recoloured or distorted here: it is only scaled proportionally and
 * centred.
 *
 * Two brand-pack properties drive the composition:
 *
 * 1. Safe zone. Android masks an adaptive icon to a circle whose diameter is 66% of the canvas, so the
 *    symbol is scaled until its bounding box fits inside that circle. The symbol is tall (it spans 75%
 *    of the glyph canvas) and would otherwise be clipped top and bottom by round launcher masks.
 *
 * 2. Background matching. The transparent glyph retains a small amount of dark background from the
 *    original artwork around the upper-right of the symbol. Composited on the approved icon background
 *    (BRAND_BACKGROUND, sampled from the opaque master) it is indistinguishable — the residue measures
 *    #031218 against a #05161c backdrop. It is visible on any other colour, which is why the generated
 *    splash uses the same backdrop and why app.json sets the adaptive icon background to match.
 */
const path = require('node:path');
const fs = require('node:fs');
const Jimp = require('jimp');

const root = path.join(__dirname, '..');
const brandingDir = path.join(root, 'assets', 'branding');
const assetsDir = path.join(root, 'assets');

const ICON_MASTER = path.join(brandingDir, 's4-app-icon-1024.png');
const GLYPH_MASTER = path.join(brandingDir, 's4-app-glyph-1024.png');

/** Background of the approved opaque app icon. Keep app.json in step with this value. */
const BRAND_BACKGROUND = 0x05161cff;

/** Android adaptive icons are masked to a circle of this fraction of the canvas. */
const ADAPTIVE_SAFE_FRACTION = 0.66;

const SPLASH_WIDTH = 1284;
const SPLASH_HEIGHT = 2778;
/** Symbol height on the splash, as a fraction of splash height. Deliberately restrained. */
const SPLASH_SYMBOL_HEIGHT = 0.2;

/** Bounding box of the drawn symbol, ignoring the faint dark residue around it. */
function symbolBounds(image) {
  const { width, height, data } = image.bitmap;
  const box = { x1: width, y1: height, x2: 0, y2: 0 };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      // The symbol is teal/lime; the residue is near-black. Ignore anything that dark.
      if (Math.max(data[i], data[i + 1], data[i + 2]) <= 90) continue;
      if (x < box.x1) box.x1 = x;
      if (x > box.x2) box.x2 = x;
      if (y < box.y1) box.y1 = y;
      if (y > box.y2) box.y2 = y;
    }
  }
  return { ...box, width: box.x2 - box.x1, height: box.y2 - box.y1 };
}

/** Scale `glyph` by `scale` and place it so the symbol's centre lands on the canvas centre. */
function centreSymbol(canvas, glyph, bounds, scale) {
  const scaled = glyph.clone().resize(Math.round(glyph.bitmap.width * scale), Math.round(glyph.bitmap.height * scale));
  const symbolCentreX = (bounds.x1 + bounds.x2) / 2 * scale;
  const symbolCentreY = (bounds.y1 + bounds.y2) / 2 * scale;
  canvas.composite(
    scaled,
    Math.round(canvas.bitmap.width / 2 - symbolCentreX),
    Math.round(canvas.bitmap.height / 2 - symbolCentreY),
  );
  return scaled;
}

async function main() {
  for (const file of [ICON_MASTER, GLYPH_MASTER]) {
    if (!fs.existsSync(file)) throw new Error(`Approved brand master missing: ${path.relative(root, file)}`);
  }

  // ── App icon / iOS icon: the approved opaque master, copied byte for byte ────────────────────────
  // Copied rather than re-encoded so the shipped icon is exactly the approved artwork, and so it keeps
  // the master's opaque colour type: an iOS app icon must carry no alpha channel.
  const icon = await Jimp.read(ICON_MASTER);
  if (icon.bitmap.width !== 1024 || icon.bitmap.height !== 1024) {
    throw new Error(`Expected a 1024x1024 icon master, got ${icon.bitmap.width}x${icon.bitmap.height}`);
  }
  const iconIsOpaque = icon.bitmap.data.every((value, index) => index % 4 !== 3 || value === 255);
  if (!iconIsOpaque) throw new Error('The icon master must be fully opaque (iOS rejects app icons with transparency).');
  fs.copyFileSync(ICON_MASTER, path.join(assetsDir, 'icon.png'));

  // Web favicon: the same opaque artwork at favicon size, so browser chrome never shows through.
  await icon.clone().resize(192, 192).writeAsync(path.join(assetsDir, 'favicon.png'));

  // ── Android adaptive foreground: symbol scaled inside the circular safe zone ─────────────────────
  const glyph = await Jimp.read(GLYPH_MASTER);
  const bounds = symbolBounds(glyph);
  const size = glyph.bitmap.width;
  const symbolRadius = Math.hypot(bounds.width, bounds.height) / 2;
  const safeRadius = (size * ADAPTIVE_SAFE_FRACTION) / 2;
  const adaptiveScale = Math.min(1, (safeRadius / symbolRadius) * 0.98); // 2% margin inside the mask
  const adaptive = new Jimp(size, size, 0x00000000);
  centreSymbol(adaptive, glyph, bounds, adaptiveScale);
  await adaptive.writeAsync(path.join(assetsDir, 'adaptive-icon.png'));

  // ── Splash: symbol centred on the approved icon backdrop ────────────────────────────────────────
  const splash = new Jimp(SPLASH_WIDTH, SPLASH_HEIGHT, BRAND_BACKGROUND);
  const splashScale = (SPLASH_HEIGHT * SPLASH_SYMBOL_HEIGHT) / bounds.height;
  centreSymbol(splash, glyph, bounds, splashScale);
  // Launch screens are opaque; drop the fractional alpha left by compositing.
  for (let i = 3; i < splash.bitmap.data.length; i += 4) splash.bitmap.data[i] = 255;
  await splash.writeAsync(path.join(assetsDir, 'splash.png'));

  const pct = (value) => `${Math.round(value * 100)}%`;
  console.log(JSON.stringify({
    event: 's4_brand_assets_generated',
    icon: '1024x1024 opaque (approved master, unmodified)',
    favicon: '192x192 opaque',
    adaptiveIcon: `symbol at ${pct(adaptiveScale * bounds.height / size)} of canvas height, inside the ${pct(ADAPTIVE_SAFE_FRACTION)} safe circle`,
    splash: `${SPLASH_WIDTH}x${SPLASH_HEIGHT}, symbol at ${pct(SPLASH_SYMBOL_HEIGHT)} of height`,
    background: `#${BRAND_BACKGROUND.toString(16).padStart(8, '0').slice(0, 6)}`,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
