/**
 * Fake `scripts/lifecycle.ts` for the recover-stale.sh suites (issue #5318).
 *
 * recover-stale.sh writes issue state only through the lifecycle seam CLI
 * (`advance <n> <to> --from <state>`, `claim-show`, `release`). The suites inject
 * this stub through HYDRA_RECOVER_STALE_LIFECYCLE_CLI so no real GitHub/Redis is
 * touched. It reproduces the one seam behaviour the script relies on — the
 * compare-and-set `--from` precondition (refused `from-mismatch` unless the
 * issue's live state labels are EXACTLY `[from]`) — reading each fake issue's
 * `labels` from the suite's issues file, and records every accepted move into the
 * suite's edits file in `gh issue edit` argv shape so the existing assertions on
 * `--remove-label` / `--add-label` keep reading the same record.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HELPER = `#!/usr/bin/env python3
import json, os, sys

ISSUES = os.environ["LCS_ISSUES"]
EDITS = os.environ["LCS_EDITS"]
CLAIMS = os.environ["LCS_CLAIMS"]
RELEASES = os.environ["LCS_RELEASES"]
DEFAULT_LABEL = os.environ["LCS_DEFAULT_LABEL"]
REPO = os.environ.get("HYDRA_AUTOPILOT_REPO", "gaberoo322/hydra")
STATES = set("needs-triage needs-info needs-research hitl-grill needs-tickets ready-for-agent blocked in-progress needs-dev-resume needs-qa qa-passed ready-for-human parked".split())


def flag(argv, name):
    for i, tok in enumerate(argv):
        if tok == name and i + 1 < len(argv):
            return argv[i + 1]
    return None


def main():
    argv = sys.argv[1:]
    verb = argv[0]
    if verb == "advance":
        n, to = int(argv[1]), argv[2]
        frm = flag(argv, "--from")
        issues = {i["number"]: i for i in json.load(open(ISSUES))}
        hit = issues.get(n)
        if hit is None:
            print(json.dumps({"ok": False, "code": "fetch-failed"}))
            sys.exit(1)
        labels = hit.get("labels", [DEFAULT_LABEL])
        live = [l for l in labels if l in STATES]
        if frm is not None and live != [frm]:
            print(json.dumps({"ok": False, "issue": n, "code": "from-mismatch"}))
            sys.exit(1)
        with open(EDITS, "a") as f:
            f.write(json.dumps([str(n), "--repo", REPO, "--remove-label", frm, "--add-label", to] + argv[3:]) + "\\n")
        print(json.dumps({"ok": True, "issue": n, "from": frm, "to": to}))
        return
    if verb == "claim-show":
        n = argv[1]
        claims = json.load(open(CLAIMS))
        print(json.dumps({"claim": claims.get(n)}))
        return
    if verb == "release":
        with open(RELEASES, "a") as f:
            f.write(json.dumps(argv[1:]) + "\\n")
        print(json.dumps({"ok": True}))
        return
    sys.stderr.write("lifecycle stub: unsupported " + repr(argv) + "\\n")
    sys.exit(2)


main()
`;

export interface LifecycleStubOptions {
  /** Labels an issue carries when its fake record has no `labels` field. */
  defaultLabel: string;
  /** Held claims by issue number (string key): `{dispatchId, openedAt (epoch ms)}`. */
  claims?: Record<string, { dispatchId: string; class?: string; run?: string; openedAt: number }>;
}

export interface LifecycleStub {
  /** Value for HYDRA_RECOVER_STALE_LIFECYCLE_CLI. */
  cli: string;
  /** Env the stub reads (merge into the script's env alongside the CLI). */
  env: Record<string, string>;
  releasesFile: string;
}

export function writeLifecycleStub(
  dir: string,
  issuesFile: string,
  editsFile: string,
  opts: LifecycleStubOptions,
): LifecycleStub {
  const script = join(dir, "lifecycle-stub.py");
  const claimsFile = join(dir, "lifecycle-claims.json");
  const releasesFile = join(dir, "lifecycle-releases.jsonl");
  writeFileSync(script, HELPER);
  chmodSync(script, 0o755);
  writeFileSync(claimsFile, JSON.stringify(opts.claims ?? {}));
  writeFileSync(releasesFile, "");
  return {
    cli: `python3 ${script}`,
    env: {
      LCS_ISSUES: issuesFile,
      LCS_EDITS: editsFile,
      LCS_CLAIMS: claimsFile,
      LCS_RELEASES: releasesFile,
      LCS_DEFAULT_LABEL: opts.defaultLabel,
    },
    releasesFile,
  };
}
