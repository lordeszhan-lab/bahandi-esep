/**
 * Generate on-brand PWA icons — Prompt 23.1.
 *
 * Renders a geometric "E" mark (green ground, white glyph) to PNG via sharp.
 * The glyph is built from rounded rectangles so output is deterministic and
 * never depends on system fonts / librsvg text shaping. Produces:
 *   - icon-192.png           (any)
 *   - icon-512.png           (any)
 *   - icon-512-maskable.png  (maskable — glyph kept inside the 80% safe zone)
 *   - apple-touch-icon.png   (180×180, full-bleed; iOS applies its own mask)
 *
 * Run: npx tsx scripts/generate-pwa-icons.ts
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.join(process.cwd(), "public", "icons");
const GREEN = "#16A34A";
const WHITE = "#FFFFFF";

type Box = [x0: number, y0: number, x1: number, y1: number];

/** Four rounded rects that read as a clean institutional "E". */
function eGlyph(box: Box, t: number, r: number): string {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const midY = Math.round(y0 + h / 2 - t / 2);
  const midW = Math.round(w * 0.72);
  const bottomY = y1 - t;
  return [
    `<rect x="${x0}" y="${y0}" width="${t}" height="${h}" rx="${r}" fill="${WHITE}"/>`,
    `<rect x="${x0}" y="${y0}" width="${w}" height="${t}" rx="${r}" fill="${WHITE}"/>`,
    `<rect x="${x0}" y="${midY}" width="${midW}" height="${t}" rx="${r}" fill="${WHITE}"/>`,
    `<rect x="${x0}" y="${bottomY}" width="${w}" height="${t}" rx="${r}" fill="${WHITE}"/>`,
  ].join("\n  ");
}

function svgFor(size: number, maskable: boolean): string {
  const box: Box = maskable
    ? [Math.round(size * 0.34), Math.round(size * 0.32), Math.round(size * 0.66), Math.round(size * 0.68)]
    : [Math.round(size * 0.30), Math.round(size * 0.27), Math.round(size * 0.72), Math.round(size * 0.73)];
  const t = Math.round(size * (maskable ? 0.085 : 0.1));
  const r = Math.round(size * (maskable ? 0.018 : 0.022));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `\n  <rect width="${size}" height="${size}" fill="${GREEN}"/>` +
    `\n  ${eGlyph(box, t, r)}` +
    `\n</svg>`
  );
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const jobs: Array<{ name: string; size: number; maskable: boolean }> = [
    { name: "icon-192.png", size: 192, maskable: false },
    { name: "icon-512.png", size: 512, maskable: false },
    { name: "icon-512-maskable.png", size: 512, maskable: true },
    { name: "apple-touch-icon.png", size: 180, maskable: false },
  ];
  for (const job of jobs) {
    const info = await sharp(Buffer.from(svgFor(job.size, job.maskable)))
      .png()
      .toFile(path.join(OUT_DIR, job.name));
    console.log(`  + ${job.name.padEnd(24)} ${info.width}x${info.height}`);
  }
  console.log("PWA icons generated → public/icons/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
