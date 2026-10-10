#!/usr/bin/env node
/**
 * Pack a decide() capture directory (see capture/sitecustomize.py) into the
 * committed plan-parity corpus: one JSON object per line, sorted by content
 * hash, gzip'd with a zero mtime so a regeneration over the same inputs is
 * byte-identical (ADR-0043 slice 6, issue #4934).
 *
 *   node test/fixtures/turn-snapshot-parity/pack-corpus.mjs <capture-dir>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: pack-corpus.mjs <capture-dir>");
  process.exit(2);
}
const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
const lines = names.map((n) => readFileSync(join(dir, n), "utf-8").trim());
const out = join(import.meta.dirname, "decide-inputs.jsonl.gz");
writeFileSync(out, gzipSync(`${lines.join("\n")}\n`, { level: 9 }));
console.log(`packed ${lines.length} decide() inputs into ${out}`);
