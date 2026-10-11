/**
 * turn-snapshot/github-port.ts — `TurnSnapshotGithub`, the narrow typed `gh`
 * port the Turn Snapshot collectors read through (ADR-0043 Decision 1).
 *
 * ONE typed method per read a collector needs — never a generic
 * `gh(args) → stdout` adapter (rejected by Decision 1: it pins fakes to CLI
 * argument strings). Tests hand collectors a fake port returning typed
 * fixtures; production uses {@link createTurnSnapshotGithub}, which rides the
 * exec seam's `runExec` (src/github/exec.ts; not `ghExec`, see the transport) and resolves the repo
 * through src/github/repo.ts — no repo literal lives in this module.
 *
 * Byte-identical on the wire (Decision 4): each method issues EXACTLY the
 * `gh` call `collect-state.sh` issued before the slice moved (GraphQL
 * `gh pr list` stays GraphQL — moving reads to REST is a separate,
 * behaviour-changing ticket), and returns the read the way the bash saw it:
 * stdout with trailing newlines stripped (`$(...)`), a failed call collapsed
 * to an empty read (the `2>/dev/null || true` degrade).
 */

import { ghBin, runExec } from "../../github/exec.ts";
import { resolveOrchestratorRepo } from "../../github/repo.ts";
import { ORCH_BOARD_LABELS } from "../../board-labels.ts";
import { pyJsonLoads } from "./py-compat.ts";

/** The `--json` field list of the ONE open-PR read the in-flight sets and the PR-gate classifier share. */
export const PR_GATE_PR_FIELDS = "number,headRefName,body,mergeStateStatus,statusCheckRollup,createdAt,updatedAt,isDraft,labels";

/** The `--json` field list of the ready-for-agent issue read the grill picks and Candidate Exclusions share (slice 3). */
export const READY_FOR_AGENT_ISSUE_FIELDS = "number,updatedAt,body,labels,title";

/** The branch whose protection defines the required status contexts. */
export const PROTECTED_BRANCH = "master";

/**
 * A JSON read as the collector sees it: parsed data, an EMPTY read (the call
 * failed or printed nothing — distinguishable from a healthy `[]`, the #4130
 * discipline), or an unparseable payload carrying Python's decode error text.
 */
export type GhJsonRead =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "empty" }
  | { readonly kind: "unparseable"; readonly error: string };

/** The #4812 re-poll read plus the first line of `gh`'s stderr (quoted in the FAILED note). */
export interface MergeStateRepollRead {
  readonly read: GhJsonRead;
  readonly stderrHead: string;
}

export type WorkflowRunEvent = "push" | "pull_request";

/** The reads the inflight-PR + PR-gate collectors need — one method each. */
export interface TurnSnapshotGithub {
  /** Open PRs with {@link PR_GATE_PR_FIELDS} (`gh pr list --state open --limit N --json …`). */
  listOpenPrs(limit: number): Promise<GhJsonRead>;
  /** The conditional UNKNOWN re-poll (`gh pr list --state open --limit N --json number,mergeStateStatus`). */
  listOpenPrMergeStates(limit: number): Promise<MergeStateRepollRead>;
  /** The newest workflow run's `created_at` for one event, or `null` on an empty/failed read. */
  latestWorkflowRunCreatedAt(event: WorkflowRunEvent): Promise<string | null>;
  /** Branch protection's required status contexts (`.contexts`) for {@link PROTECTED_BRANCH}. */
  requiredStatusContexts(): Promise<GhJsonRead>;
  /** Open issue numbers carrying `label` (`[{"number": N}, …]`). */
  openIssueNumbersByLabel(label: string, limit: number): Promise<GhJsonRead>;
  /** Open issues with {@link ORCH_BOARD_ROW_FIELDS} — the degraded board-state read (ADR-0043 slice 2). */
  listOpenIssueBoardRows(limit: number): Promise<GhJsonRead>;
  /** Open issues with `number,labels` — the untriaged-orphan backstop read (ADR-0043 slice 2). */
  listOpenIssueLabelRows(limit: number): Promise<GhJsonRead>;
  // --- slice 3 (#4931): grill/dev-ready picks, Candidate Exclusions, active dev_orch ---
  /** Open `ready-for-agent` issues with {@link READY_FOR_AGENT_ISSUE_FIELDS} — the grill-candidate AND Candidate Exclusion pool. */
  listReadyForAgentIssues(limit: number): Promise<GhJsonRead>;
  /** Open issues matching a `--search` string (`--json number`) — the ONE batched strict-blocker openness lookup. */
  searchOpenIssueNumbers(search: string, limit: number): Promise<GhJsonRead>;
  /** The newest MERGED PRs (`--json number,title,body`) — the shipped-work pin refusal (#4690). */
  listMergedPrs(limit: number): Promise<GhJsonRead>;
  /** Open PRs (`--json updatedAt,headRefName,labels`, gh's default page size) — the active dev_orch count (#412). */
  listOpenPrHeads(): Promise<GhJsonRead>;
  // --- slice 5B (#4933): raw `--json` payloads; the old `--jq` folds live in TS now ---
  /** Open issues carrying `label`, `--json number` (the enhancement / hitl-grill depth reads). */
  openIssuesWithLabel(label: string, limit: number): Promise<GhJsonRead>;
  /** Open issues carrying `label`, `--json number,labels` (the wayfinder map list). */
  openIssueLabelsWithLabel(label: string, limit: number): Promise<GhJsonRead>;
  /** Open issues carrying `label`, `--json number,assignees` (the needs-tickets lane). */
  openIssueAssigneesWithLabel(label: string, limit: number): Promise<GhJsonRead>;
  /** One wayfinder map's sub-issues (state, labels, assignee count, blockers) — native GraphQL. */
  wayfinderMapSubIssues(mapNumber: string): Promise<GhJsonRead>;
  // ---- Target-board family (ADR-0043 slice 4, #4932) — issued against the
  // port's repo, which the CLI builds per realm (the Target repo via
  // src/target-config.ts). REST `gh api` where the bash used REST
  // (ADR-0031 Decision 6); the two `gh issue list` reads stay as they were
  // (the board fallback reuses slice 2's {@link listOpenIssueLabelRows}).
  /** The same read projected by gh's `--jq` to `[{number, labels: [name…]}]` — the scan-board signals. */
  listOpenIssueLabelNames(limit: number): Promise<GhJsonRead>;
  /** Open PRs over REST (`gh api repos/R/pulls?state=open&per_page=N`). */
  listOpenPullsRest(limit: number): Promise<GhJsonRead>;
  /** Open issues carrying `label` over REST (`gh api repos/R/issues?labels=L&state=open&per_page=N`; PRs included). */
  listOpenIssuesByLabelRest(label: string, limit: number): Promise<GhJsonRead>;
  /** Repo-wide issue/PR comments, newest first, reduced to `{body, created_at, author_association}` for bodies containing `QA-Verdict:` (#4796 PASS-at-head skip). */
  listQaVerdictCommentsRest(limit: number): Promise<GhJsonRead>;
}

/**
 * The wayfinder frontier query (docs/agents/issue-tracker.md), whitespace and
 * all as collect-state.sh sent it; the repository is filled in from the
 * resolved repo handle, never a literal.
 */
export function wayfinderFrontierQuery(repo: string): string {
  const [owner, name] = repo.split("/");
  return `query($n:Int!){
      repository(owner:"${owner}", name:"${name}"){ issue(number:$n){
        subIssues(first:100){ nodes { number state
          labels(first:20){nodes{ name }}
          assignees(first:1){totalCount}
          blockedBy(first:20){nodes{ number state }} } } } } }`;
}

/** The `--json` field list of the degraded orch board read — exactly what `deriveBoardState` buckets on. */
export const ORCH_BOARD_ROW_FIELDS = "number,labels,updatedAt";

/** The raw `gh` invocation the production port is built on (injectable for argv tests). */
export type GhTransport = (
  args: string[],
) => Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stderr: string }>;

/** Per-call timeout: the open-PR GraphQL read carries every PR body, so allow more than the 15s seam default. */
const GH_TIMEOUT_MS = 60_000;

/**
 * The default transport: the exec seam's `runExec`, deliberately NOT `ghExec`.
 * `ghExec` arms/clears the shared gh rate-limit gate in Redis on every call; a
 * successful per-turn GraphQL read would clear a REST backoff the service armed
 * and reset its ladder. The bash collectors this replaces never touched the gate,
 * so the read-only Turn Snapshot port stays out of it too (PR #4940 review).
 */
export const ghExecTransport: GhTransport = async (args) => {
  const raw = await runExec(ghBin(), args, { timeout: GH_TIMEOUT_MS });
  if (raw.exitCode === 0 && !raw.timedOut && !raw.spawnErrorCode) {
    return { ok: true, stdout: raw.stdout, stderr: raw.stderr };
  }
  return { ok: false, stderr: raw.stderr };
};

/** `$(...)` semantics: strip every trailing newline. */
function shellCapture(stdout: string): string {
  return stdout.replace(/\n+$/, "");
}

function jsonRead(stdout: string): GhJsonRead {
  if (stdout === "") return { kind: "empty" };
  const parsed = pyJsonLoads(stdout);
  return "error" in parsed ? { kind: "unparseable", error: parsed.error } : { kind: "ok", data: parsed.value };
}

export interface TurnSnapshotGithubOptions {
  /** Override the transport (tests record argv through this). Defaults to {@link ghExecTransport}. */
  transport?: GhTransport;
  /** Override the repo handle. Defaults to `resolveOrchestratorRepo()`. */
  repo?: string;
}

/** The production port over the GitHub CLI Adapter. */
export function createTurnSnapshotGithub(opts: TurnSnapshotGithubOptions = {}): TurnSnapshotGithub {
  const run = opts.transport ?? ghExecTransport;
  const repo = opts.repo ?? resolveOrchestratorRepo();

  const read = async (args: string[]): Promise<string> => {
    const res = await run(args);
    return res.ok ? shellCapture(res.stdout) : "";
  };

  return {
    async listOpenPrs(limit) {
      return jsonRead(
        await read(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", PR_GATE_PR_FIELDS]),
      );
    },
    async listOpenPrMergeStates(limit) {
      const res = await run(["pr", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,mergeStateStatus"]);
      const stderrHead = (res.stderr.split("\n")[0] ?? "").replace(/\r$/, "");
      return { read: jsonRead(res.ok ? shellCapture(res.stdout) : ""), stderrHead };
    },
    async latestWorkflowRunCreatedAt(event) {
      const out = await read([
        "api",
        `repos/${repo}/actions/runs?event=${event}&per_page=1`,
        "--jq",
        ".workflow_runs[0].created_at // empty",
      ]);
      return out === "" ? null : out;
    },
    async requiredStatusContexts() {
      return jsonRead(
        await read(["api", `repos/${repo}/branches/${PROTECTED_BRANCH}/protection/required_status_checks`, "--jq", ".contexts"]),
      );
    },
    async openIssueNumbersByLabel(label, limit) {
      return jsonRead(
        await read(["issue", "list", "--repo", repo, "--label", label, "--state", "open", "--limit", String(limit), "--json", "number", "--jq", "."]),
      );
    },
    async listOpenIssueBoardRows(limit) {
      return jsonRead(
        await read(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", ORCH_BOARD_ROW_FIELDS]),
      );
    },
    async listOpenIssueLabelRows(limit) {
      return jsonRead(await read(["issue", "list", "--repo", repo, "--state", "open", "--limit", String(limit), "--json", "number,labels"]));
    },
    async listReadyForAgentIssues(limit) {
      return jsonRead(
        await read(["issue", "list", "--repo", repo, "--state", "open", "--label", ORCH_BOARD_LABELS.ready_for_agent, "--limit", String(limit), "--json", READY_FOR_AGENT_ISSUE_FIELDS]),
      );
    },
    async searchOpenIssueNumbers(search, limit) {
      return jsonRead(await read(["issue", "list", "--repo", repo, "--state", "open", "--search", search, "--limit", String(limit), "--json", "number"]));
    },
    async listMergedPrs(limit) {
      return jsonRead(await read(["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json", "number,title,body"]));
    },
    async listOpenPrHeads() {
      return jsonRead(await read(["pr", "list", "--repo", repo, "--state", "open", "--json", "updatedAt,headRefName,labels"]));
    },
    async openIssuesWithLabel(label, limit) {
      return jsonRead(await read(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", String(limit), "--json", "number"]));
    },
    async openIssueLabelsWithLabel(label, limit) {
      return jsonRead(await read(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", String(limit), "--json", "number,labels"]));
    },
    async openIssueAssigneesWithLabel(label, limit) {
      return jsonRead(await read(["issue", "list", "--repo", repo, "--state", "open", "--label", label, "--limit", String(limit), "--json", "number,assignees"]));
    },
    async wayfinderMapSubIssues(mapNumber) {
      return jsonRead(await read(["api", "graphql", "-F", `n=${mapNumber}`, "-f", `query=${wayfinderFrontierQuery(repo)}`]));
    },
    async listOpenIssueLabelNames(limit) {
      return jsonRead(
        await read([
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--limit",
          String(limit),
          "--json",
          "number,labels",
          "--jq",
          "[ .[] | { number: .number, labels: (.labels | map(.name)) } ]",
        ]),
      );
    },
    async listOpenPullsRest(limit) {
      return jsonRead(await read(["api", `repos/${repo}/pulls?state=open&per_page=${limit}`]));
    },
    async listOpenIssuesByLabelRest(label, limit) {
      return jsonRead(await read(["api", `repos/${repo}/issues?labels=${label}&state=open&per_page=${limit}`]));
    },
    async listQaVerdictCommentsRest(limit) {
      return jsonRead(
        await read([
          "api",
          `repos/${repo}/issues/comments?sort=created&direction=desc&per_page=${limit}`,
          "--jq",
          '[.[] | select((.body // "") | contains("QA-Verdict:")) | {body, created_at, author_association}]',
        ]),
      );
    },
  };
}
