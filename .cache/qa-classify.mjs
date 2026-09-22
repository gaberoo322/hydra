import { classifyVerdict, renderChecksBlock } from '../scripts/ci/qa-verdict.ts';
import { readFileSync } from 'node:fs';

const checks = JSON.parse(readFileSync('/tmp/checks.json', 'utf8'));
const r = classifyVerdict('FAIL', checks);
console.log(JSON.stringify({ verdict: r.verdict, reason: r.reason, checks: renderChecksBlock(r) }, null, 2));
