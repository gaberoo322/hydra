/**
 * Fake `scripts/lifecycle.ts` CLI for the shell/Python callers that moved onto
 * the lifecycle seam (issue #5318): recover-stale.sh (via `HYDRA_LIFECYCLE_BIN`)
 * and reap_stall.py (via `HYDRA_AUTOPILOT_LIFECYCLE_CLI`).
 *
 * It models only what those callers depend on, never the real seam:
 *   advance <n> <to> --from <state> [--evidence k=v] [--actor a]
 *       exit 0 and append `[n, "--remove-label", from, "--add-label", to]` to the
 *       edits file when the issue's live state labels are EXACTLY [from]
 *       (the seam's compare-and-set); exit 1 `from-mismatch` otherwise, and exit
 *       1 `refused-by-fake` for any issue in `refuse`.
 *   claim-show <n>   -> {"claim": <issue.claim | null>}
 *   release <n> --dispatch D [--outcome O]  -> {"ok":true}, exit 1 for `refuseRelease`
 * Every invocation is appended to `calls.jsonl` as its argv array.
 *
 * The issue table is the caller's `issues.json` (an array of `{number, labels?,
 * claim?}`); `labels` unset means "still in the state the call names as --from".
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_LABELS = [
  "needs-triage", "needs-info", "needs-research", "hitl-grill", "needs-tickets",
  "ready-for-agent", "blocked", "in-progress", "needs-dev-resume", "needs-qa",
  "qa-passed", "ready-for-human", "parked",
];

export interface FakeLifecycleOpts {
  /** Issues for which `advance` exits 1 (a seam refusal). */
  refuse?: number[];
  /** Issues for which `release` exits 1. */
  refuseRelease?: number[];
}

export interface FakeLifecycleCli {
  /** Absolute path of the executable stub (one argv token, no spaces). */
  bin: string;
  callsFile: string;
  /** Every invocation's argv, oldest first. */
  readCalls(): string[][];
}

export function writeFakeLifecycleCli(
  dir: string,
  issuesFile: string,
  editsFile: string,
  opts: FakeLifecycleOpts = {},
): FakeLifecycleCli {
  const callsFile = join(dir, "lifecycle-calls.jsonl");
  const pyPath = join(dir, "fake-lifecycle.py");
  const bin = join(dir, "fake-lifecycle");
  writeFileSync(callsFile, "");
  writeFileSync(
    pyPath,
    `#!/usr/bin/env python3
import json, sys
ISSUES = ${JSON.stringify(issuesFile)}
EDITS = ${JSON.stringify(editsFile)}
CALLS = ${JSON.stringify(callsFile)}
STATES = set(${JSON.stringify(STATE_LABELS)})
REFUSE = set(${JSON.stringify(opts.refuse ?? [])})
REFUSE_RELEASE = set(${JSON.stringify(opts.refuseRelease ?? [])})

argv = sys.argv[1:]
with open(CALLS, "a", encoding="utf-8") as f:
    f.write(json.dumps(argv) + "\\n")

def flag(name):
    for i, t in enumerate(argv):
        if t == name and i + 1 < len(argv):
            return argv[i + 1]
    return None

verb = argv[0] if argv else ""
issue = int(argv[1]) if len(argv) > 1 and argv[1].isdigit() else None
with open(ISSUES, "r", encoding="utf-8") as f:
    table = {i["number"]: i for i in json.load(f)}
row = table.get(issue)

if verb == "claim-show":
    if row is None:
        print(json.dumps({"ok": False, "error": "no-such-issue"})); sys.exit(1)
    print(json.dumps({"claim": row.get("claim")})); sys.exit(0)

if verb == "release":
    if issue in REFUSE_RELEASE:
        print(json.dumps({"ok": False, "code": "claim-owner-mismatch"})); sys.exit(1)
    print(json.dumps({"ok": True, "prior": row.get("claim") if row else None})); sys.exit(0)

if verb == "advance":
    to, frm = argv[2], flag("--from")
    if row is None:
        print(json.dumps({"ok": False, "code": "fetch-failed"})); sys.exit(1)
    live = [l for l in row.get("labels", [frm]) if l in STATES]
    if frm is not None and live != [frm]:
        print(json.dumps({"ok": False, "code": "from-mismatch"})); sys.exit(1)
    if issue in REFUSE:
        print(json.dumps({"ok": False, "code": "refused-by-fake"})); sys.exit(1)
    with open(EDITS, "a", encoding="utf-8") as f:
        f.write(json.dumps([str(issue), "--remove-label", frm, "--add-label", to]) + "\\n")
    print(json.dumps({"ok": True, "from": frm, "to": to})); sys.exit(0)

sys.exit(2)
`,
  );
  writeFileSync(bin, `#!/usr/bin/env bash\nexec python3 ${JSON.stringify(pyPath)} "$@"\n`);
  chmodSync(bin, 0o755);
  chmodSync(pyPath, 0o755);
  return {
    bin,
    callsFile,
    readCalls() {
      return readFileSync(callsFile, "utf-8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as string[]);
    },
  };
}
