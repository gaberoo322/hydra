import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CMD_TIMEOUT, runCmd } from "./cmd.ts";
import { parseTestCounts, parseFailingTests } from "./parser.ts";

/**
 * Options accepted by {@link groundProject}.
 *
 * Names the (small) option vocabulary the function actually consumes, so a
 * caller adding/renaming an option gets compile-time feedback instead of a
 * typo silently falling through to the default (`testCmdd` → `opts.testCmd`
 * miss → reverts to `"npm"` with no error).
 */
export interface GroundingOpts {
  /** Test command to run. Default: `"npm"`. */
  testCmd?: string;
  /** Arguments passed to {@link GroundingOpts.testCmd}. Default: `["test"]`. */
  testArgs?: string[];
  /**
   * Paths to focus the inspection on. Currently documented but UNREAD by the
   * implementation — declared so a future caller is not misled into thinking
   * it already does something.
   */
  focusPaths?: string[];
}

/**
 * Injectable dependency surface for {@link groundProject} (issue #2182).
 *
 * `groundProject` is the fan-out coordinator that spawns 11 subprocess calls
 * (`git`, `npm`, `grep`, `typecheck`) and reads two files (`package.json`,
 * `README.md`) to assemble a {@link GroundingReport}. Production callers pass
 * no `deps` and observe byte-identical behaviour — every field defaults to its
 * real implementation via the same `deps?.x ?? x` pattern the health fan-out
 * (`src/health/fan-out.ts`, issue #2089) uses.
 *
 * Tests inject stubs so the ASSEMBLY logic (the `appDir` subdirectory probe,
 * the `testParseStatus` classification, the `failingTests` join, the
 * `todoMarkers` cap-at-20, the `testReport.ran` 127-guard) is exercisable
 * without spawning a real process or needing a real git repo on disk.
 *
 * NOTE: grounding is READ-ONLY by contract — the injected primitives are the
 * inspection reads the function already makes; injecting them does NOT change
 * what (if anything) the function writes (it writes nothing).
 */
export interface GroundProjectDeps {
  /**
   * Command runner. Default: the real {@link runCmd} (spawns via
   * `execWithGroupCleanup`). Same `{ exitCode, stdout, stderr, durationMs }`
   * contract; never throws.
   */
  runCmd?: typeof runCmd;
  /**
   * Filesystem read for `package.json` / `README.md`. Default: the real
   * `node:fs/promises` `readFile`. The function only ever calls it with
   * `(path, "utf-8")` and relies on a rejected promise to signal "absent".
   */
  readFile?: typeof readFile;
}

/** Classification of how the test output was parsed. See issue #456. */
type TestParseStatus = "ok" | "unrecognised" | "errored" | "not-run";

/** Structured result of running the test command. */
interface GroundingTestReport {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: number;
  failed: number;
  total: number;
  parseStatus: TestParseStatus;
  recognised: boolean;
  durationMs: number;
}

/** Structured result of running the typecheck command. */
interface GroundingTypecheckReport {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Structured evidence about the project produced by {@link groundProject}.
 *
 * A 1:1 transcription of the object the function returns — every field name
 * and runtime type is preserved so the `GET /grounding/latest` wire-format is
 * byte-identical.
 */
export interface GroundingReport {
  branch: string;
  headCommit: string;
  recentCommits: string[];
  dirtyFiles: string[];
  fileTree: string;
  fileCount: number;
  testReport: GroundingTestReport;
  typecheckReport: GroundingTypecheckReport;
  failingTests: ReturnType<typeof parseFailingTests>;
  recentDiffs: string;
  todoMarkers: string[];
  readme: string;
  packageJson: string;
  timestamp: number;
  groundingDurationMs: number;
}

/**
 * Deep repo inspection. Returns structured evidence about the project.
 *
 * @param projectDir - Path to the target project
 * @param opts - See {@link GroundingOpts}
 * @param deps - Injectable subprocess/filesystem primitives (see
 *   {@link GroundProjectDeps}). Production callers omit this and get the real
 *   `runCmd` / `readFile`; tests inject stubs to exercise the assembly logic
 *   without spawning processes (issue #2182).
 * @returns A {@link GroundingReport}
 */
export async function groundProject(
  projectDir: string,
  opts: GroundingOpts = {},
  deps: GroundProjectDeps = {},
): Promise<GroundingReport> {
  const runCmdImpl = deps.runCmd ?? runCmd;
  const readFileImpl = deps.readFile ?? readFile;
  const timestamp = Date.now();
  const testCmd = opts.testCmd || "npm";
  const testArgs = opts.testArgs || ["test"];

  // Grounding is READ-ONLY. Workspace cleanup (checkout main, discard
  // tracked changes, delete stale feature branches) now lives in
  // prepare-workspace.mjs — the control loop calls it explicitly BEFORE
  // grounding so "reading the truth" can never mutate that truth.

  // Detect app directory — some projects have code in a subdirectory (e.g., web/)
  let appDir = projectDir;
  try {
    await readFileImpl(join(projectDir, "package.json"), "utf-8");
  } catch { /* intentional: no package.json at root — probe subdirs */
    for (const sub of ["web", "app", "packages/app"]) {
      try {
        await readFileImpl(join(projectDir, sub, "package.json"), "utf-8");
        appDir = join(projectDir, sub);
        break;
      } catch { /* intentional: sub-dir does not have package.json, try next */ }
    }
  }

  // Run all inspections in parallel
  const [
    branchResult,
    headResult,
    logResult,
    statusResult,
    lsFilesResult,
    diffStatResult,
    testResult,
    tscResult,
    pkgResult,
    todoResult,
    readmeContent,
  ] = await Promise.all([
    // Git state (always from project root)
    runCmdImpl("git", ["branch", "--show-current"], { cwd: projectDir, timeout: 5000 }),
    runCmdImpl("git", ["log", "--oneline", "-1"], { cwd: projectDir, timeout: 5000 }),
    runCmdImpl("git", ["log", "--oneline", "-20"], { cwd: projectDir, timeout: 5000 }),
    runCmdImpl("git", ["status", "--short"], { cwd: projectDir, timeout: 5000 }),
    runCmdImpl("git", ["ls-files"], { cwd: projectDir, timeout: 10000 }),
    runCmdImpl("git", ["diff", "--stat", "HEAD~3"], { cwd: projectDir, timeout: 10000 }).catch(() => ({
      exitCode: 1, stdout: "", stderr: "not enough history", durationMs: 0,
    })),
    // Tests (from app directory where package.json lives)
    runCmdImpl(testCmd, testArgs, { cwd: appDir, timeout: CMD_TIMEOUT }),
    // Typecheck (from app directory — use project's own script if available)
    runCmdImpl("npm", ["run", "typecheck"], { cwd: appDir, timeout: 60_000 }),
    // Package.json
    readFileImpl(join(appDir, "package.json"), "utf-8").catch(() => "{}"),
    // TODO/FIXME markers — cheap signal for known gaps (exclude build artifacts)
    runCmdImpl("grep", ["-rn", "--include=*.ts", "--include=*.tsx", "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist", "--exclude-dir=.turbo", "-E", "TODO|FIXME|HACK|XXX", "."], { cwd: projectDir, timeout: 10000 }),
    // README for project context
    readFileImpl(join(projectDir, "README.md"), "utf-8").catch(() =>
      readFileImpl(join(appDir, "README.md"), "utf-8").catch(() => "")
    ),
  ]);

  const testCounts = parseTestCounts(testResult.stdout, testResult.stderr);
  const failingTests = parseFailingTests(testResult.stdout, testResult.stderr);

  // Classify the parse result so consumers can distinguish "ran 0 tests" from
  // "we ran tests but couldn't read the result" (silent-no-op). See issue #456.
  // - "ok":           parser matched a known summary pattern.
  // - "unrecognised": test command exited 0 but no known summary line appeared
  //                   (silent-no-op shape — informational consumers should warn).
  // - "errored":      test command exited non-zero. Standard failure mode; the
  //                   exitCode + stderr already carry the signal.
  // - "not-run":      test command was not found (exitCode 127).
  let testParseStatus: "ok" | "unrecognised" | "errored" | "not-run";
  if (testResult.exitCode === 127) {
    testParseStatus = "not-run";
  } else if (testResult.exitCode !== 0) {
    testParseStatus = "errored";
  } else if (!testCounts.recognised) {
    testParseStatus = "unrecognised";
  } else {
    testParseStatus = "ok";
  }

  return {
    branch: branchResult.stdout.trim(),
    headCommit: headResult.stdout.trim(),
    recentCommits: logResult.stdout.trim().split("\n").filter(Boolean),
    dirtyFiles: statusResult.stdout.trim().split("\n").filter(Boolean),
    fileTree: lsFilesResult.stdout.trim(),
    fileCount: lsFilesResult.stdout.trim().split("\n").filter(Boolean).length,

    testReport: {
      ran: testResult.exitCode !== 127, // 127 = command not found
      exitCode: testResult.exitCode,
      stdout: testResult.stdout,
      stderr: testResult.stderr,
      passed: testCounts.passed,
      failed: testCounts.failed,
      total: testCounts.total,
      // testParseStatus distinguishes recognised output from silent-no-op runs.
      // A 0-exit command whose output matched no vitest/jest summary pattern
      // is `unrecognised` — consumers should render this as a warning rather
      // than "0 tests ran". See issue #456 (post-PR-400 reframe).
      parseStatus: testParseStatus,
      recognised: testCounts.recognised,
      durationMs: testResult.durationMs,
    },

    typecheckReport: {
      ran: tscResult.exitCode !== 127,
      exitCode: tscResult.exitCode,
      stdout: tscResult.stdout,
      stderr: tscResult.stderr,
      durationMs: tscResult.durationMs,
    },

    failingTests,

    recentDiffs: diffStatResult.stdout,

    // TODO/FIXME markers — known gaps and tech debt
    todoMarkers: todoResult.exitCode === 0
      ? todoResult.stdout.trim().split("\n").filter(Boolean).slice(0, 20)
      : [],

    // README summary
    readme: typeof readmeContent === "string" ? readmeContent.slice(0, 2000) : "",

    packageJson: pkgResult,

    timestamp,
    groundingDurationMs: Date.now() - timestamp,
  };
}
