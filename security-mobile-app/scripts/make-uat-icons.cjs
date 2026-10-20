/**
 * Generates the S4 UAT launcher icons from the production artwork, so a UAT install can never be mistaken for
 * the real app on a Guard's home screen: the dark background becomes amber and the icon carries "UAT".
 *
 *   node scripts/make-uat-icons.cjs        (writes assets/uat/icon.png and assets/uat/adaptive-icon.png)
 *
 * The production assets are read, never written. Used only by app.config.js when APP_VARIANT=uat.
 */
const path = require('node:path');
const fs = require('node:fs');
const Jimp = require('jimp');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'uat');
const AMBER = { r: 0xb4, g: 0x53, b: 0x09 };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const font = await Jimp.loadFont(Jimp.FONT_SANS_128_WHITE);

  // iOS / legacy icon (opaque): dark background pixels become amber, the mark is kept, "UAT" across the foot.
  const icon = await Jimp.read(path.join(ROOT, 'assets', 'icon.png'));
  icon.scan(0, 0, icon.bitmap.width, icon.bitmap.height, function (x, y, idx) {
    const d = this.bitmap.data;
    const luminance = 0.2126 * d[idx] + 0.7152 * d[idx + 1] + 0.0722 * d[idx + 2];
    if (luminance < 48) { d[idx] = AMBER.r; d[idx + 1] = AMBER.g; d[idx + 2] = AMBER.b; }
  });
  const iconMark = icon.clone().scale(0.78);
  const iconOut = new Jimp(1024, 1024, Jimp.rgbaToInt(AMBER.r, AMBER.g, AMBER.b, 255));
  iconOut.composite(iconMark, (1024 - iconMark.bitmap.width) / 2, 0);
  iconOut.print(font, 0, 840, { text: 'UAT', alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 1024);
  // Opaque RGB, like the production icon: iOS rejects app icons with an alpha channel. Written through pngjs
  // because jimp 0.22's rgba(false) misaligns the channels.
  const { width, height, data } = iconOut.bitmap;
  fs.writeFileSync(path.join(OUT, 'icon.png'), PNG.sync.write({ width, height, data }, { colorType: 2, inputHasAlpha: true }));

  // Android adaptive foreground (transparent; amber background comes from app.config.js). Everything stays
  // inside the 66% safe zone so no launcher mask can crop the label.
  const fg = await Jimp.read(path.join(ROOT, 'assets', 'adaptive-icon.png'));
  // The artwork carries a dark texture behind the mark; it would show as a smudge on amber, so it is cleared.
  fg.scan(0, 0, fg.bitmap.width, fg.bitmap.height, function (x, y, idx) {
    const d = this.bitmap.data;
    if (0.2126 * d[idx] + 0.7152 * d[idx + 1] + 0.0722 * d[idx + 2] < 48) d[idx + 3] = 0;
  });
  const mark = fg.clone().scale(0.6);
  const fgOut = new Jimp(1024, 1024, 0x00000000);
  fgOut.composite(mark, (1024 - mark.bitmap.width) / 2, 120);
  fgOut.print(font, 0, 700, { text: 'UAT', alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER }, 1024);
  await fgOut.writeAsync(path.join(OUT, 'adaptive-icon.png'));

  console.log('wrote assets/uat/icon.png and assets/uat/adaptive-icon.png');
}

main().catch((error) => { console.error(error); process.exit(1); });
