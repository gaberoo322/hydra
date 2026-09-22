import { readFileSync } from "node:fs";
import { classifyVerdict, renderChecksBlock } from "../scripts/ci/qa-verdict.ts";

const checks = JSON.parse(readFileSync(".cache/checks.json", "utf-8"));
const r = classifyVerdict("PASS", checks);
console.log(JSON.stringify({ verdict: r.verdict, reason: r.reason }, null, 2));
console.log("---CHECKS BLOCK---");
console.log(renderChecksBlock(r));
