#!/usr/bin/env node
/**
 * build-spritesheet.js — compose per-frame PNGs into a horizontal-strip
 * sprite-sheet plus a JSON manifest.
 *
 * Usage:
 *   node dashboard/scripts/build-spritesheet.js \
 *     --in <dir> --out <file.png> --manifest <file.json> [--bg <hex>]
 *
 * Reads every *.png in --in, sorts ASCENDING by basename, and stacks the
 * frames left-to-right into a single PNG. Output canvas height is the max
 * input height; each frame is left-aligned with transparent (or --bg)
 * padding below if shorter.
 *
 * Deterministic: same input dir + same flags → byte-equal output PNG and
 * manifest. Drives the golden test in test/build-spritesheet.test.mts.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

function parseArgs(argv) {
  const args = { in: "", out: "", manifest: "", bg: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--bg") args.bg = argv[++i];
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  for (const k of ["in", "out", "manifest"]) {
    if (!args[k]) {
      process.stderr.write(`build-spritesheet: missing required --${k}\n`);
      printUsage();
      process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  process.stderr.write(
    "Usage: build-spritesheet --in <dir> --out <file.png> --manifest <file.json> [--bg <hex>]\n",
  );
}

/** Parse #RGB / #RRGGBB / #RRGGBBAA into [r,g,b,a]. Empty string → transparent. */
function parseBg(hex) {
  if (!hex) return [0, 0, 0, 0];
  const h = hex.replace(/^#/, "");
  const norm =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("") + "ff"
      : h.length === 6
        ? h + "ff"
        : h.length === 8
          ? h
          : null;
  if (!norm) throw new Error(`build-spritesheet: invalid --bg "${hex}"`);
  const n = parseInt(norm, 16);
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

async function listFrames(inDir) {
  const all = await fs.readdir(inDir);
  return all.filter((f) => f.toLowerCase().endsWith(".png")).sort();
}

async function decodePng(filePath) {
  const buf = await fs.readFile(filePath);
  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(buf, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function blitInto(dst, dstW, src, dstX, dstY) {
  const sw = src.width;
  const sh = src.height;
  for (let y = 0; y < sh; y++) {
    const srcRow = y * sw * 4;
    const dstRow = (dstY + y) * dstW * 4 + dstX * 4;
    src.data.copy(dst, dstRow, srcRow, srcRow + sw * 4);
  }
}

function fillBg(buf, w, h, rgba) {
  if (rgba[3] === 0) return; // transparent is the default zero-init
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = rgba[0];
    buf[i * 4 + 1] = rgba[1];
    buf[i * 4 + 2] = rgba[2];
    buf[i * 4 + 3] = rgba[3];
  }
}

function encodePng(buf, w, h) {
  const png = new PNG({ width: w, height: h });
  buf.copy(png.data);
  // PNG.pack() with deflateLevel=9 + deflateStrategy=3 is deterministic
  // across pngjs versions; the test pins the lockfile so output bytes are
  // stable.
  return new Promise((resolve, reject) => {
    const chunks = [];
    png
      .pack()
      .on("data", (c) => chunks.push(c))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

export async function buildSpritesheet({ inDir, outPng, outManifest, bg = "" }) {
  const frames = await listFrames(inDir);
  if (frames.length === 0) {
    throw new Error(`build-spritesheet: no PNGs found in ${inDir}`);
  }
  const decoded = [];
  for (const f of frames) {
    decoded.push({ name: f, png: await decodePng(path.join(inDir, f)) });
  }
  const totalW = decoded.reduce((s, d) => s + d.png.width, 0);
  const totalH = decoded.reduce((m, d) => Math.max(m, d.png.height), 0);
  const bgRgba = parseBg(bg);

  const buf = Buffer.alloc(totalW * totalH * 4);
  fillBg(buf, totalW, totalH, bgRgba);
  let x = 0;
  const manifestFrames = [];
  for (const { name, png } of decoded) {
    blitInto(buf, totalW, png, x, 0);
    manifestFrames.push({ name, x, y: 0, w: png.width, h: png.height });
    x += png.width;
  }

  const png = await encodePng(buf, totalW, totalH);
  await fs.mkdir(path.dirname(outPng), { recursive: true });
  await fs.writeFile(outPng, png);

  const manifest = {
    width: totalW,
    height: totalH,
    frameCount: decoded.length,
    background: bgRgba,
    frames: manifestFrames,
  };
  await fs.mkdir(path.dirname(outManifest), { recursive: true });
  // Trailing newline keeps editors + diffs happy. JSON.stringify with 2-space
  // indent is stable across Node versions.
  await fs.writeFile(outManifest, JSON.stringify(manifest, null, 2) + "\n");

  return manifest;
}

const invokedDirectly =
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  buildSpritesheet({
    inDir: args.in,
    outPng: args.out,
    outManifest: args.manifest,
    bg: args.bg,
  }).then(
    (m) => {
      process.stdout.write(
        `build-spritesheet: ${m.frameCount} frames → ${m.width}x${m.height}\n`,
      );
    },
    (err) => {
      process.stderr.write(`build-spritesheet: ${err.message}\n`);
      process.exit(1);
    },
  );
}
