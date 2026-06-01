// Generates PWA PNG icons from an inline SVG using sharp.
// Run with: npm run icons
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../public/icons/", import.meta.url));

function svg(size, maskable) {
  const pad = maskable ? size * 0.14 : 0; // safe zone for maskable icons
  const r = (size - pad * 2) / 2;
  const cx = size / 2;
  const cy = size / 2;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0e1424"/>
      <stop offset="1" stop-color="#0b0f19"/>
    </linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3ddc97"/>
      <stop offset="1" stop-color="#2bb3ff"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="url(#bg)"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.5}" fill="none" stroke="url(#g)" stroke-width="${size * 0.045}"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.28}" fill="url(#g)"/>
  <path d="M ${cx - r * 0.74} ${cy} a ${r * 0.74} ${r * 0.74} 0 0 1 ${r * 1.48} 0"
        fill="none" stroke="url(#g)" stroke-width="${size * 0.03}" stroke-linecap="round" opacity="0.55"/>
</svg>`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const jobs = [
    { name: "icon-192.png", size: 192, maskable: false },
    { name: "icon-512.png", size: 512, maskable: false },
    { name: "icon-maskable-512.png", size: 512, maskable: true },
  ];
  for (const j of jobs) {
    await sharp(Buffer.from(svg(j.size, j.maskable)))
      .png()
      .toFile(join(OUT, j.name));
    console.log("wrote", j.name);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
