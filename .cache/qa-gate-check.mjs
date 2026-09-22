import { decideReviewAdmission } from '../scripts/ci/qa-verdict.ts';
import { readFileSync } from 'node:fs';

const checks = JSON.parse(readFileSync('/tmp/checks.json', 'utf8'));
const d = decideReviewAdmission({
  checks,
  mergeStateStatus: 'UNSTABLE',
  tier: 3,
});
console.log(JSON.stringify(d));
