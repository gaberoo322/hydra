import { Router } from "express";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { getAggregateStats } from "../metrics.ts";
import { getStatus as getSchedulerStatus } from "../scheduler.ts";
import { _admin as backlogAdmin } from "../backlog.ts";
const { getBacklogCounts } = backlogAdmin;
import {
  listLen, getWorkQueueLen,
} from "../redis-adapter.ts";
import { redisKeys } from "../redis-keys.ts";
import { getTargetWorkspace } from "../target-config.ts";

const HYDRA_ROOT = process.env.HYDRA_ROOT || resolve(process.env.HOME, "hydra");
const CONFIG_PATH = process.env.HYDRA_CONFIG_PATH || resolve(HYDRA_ROOT, "config");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChecklistItem {
  id: string;
  category: "system-health" | "backlog-hygiene" | "strategic-review" | "target-project";
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  action: {
    type: "skill" | "link" | "dashboard";
    label: string;
    target: string;  // skill name, URL, or dashboard path
  };
}

// ---------------------------------------------------------------------------
// Checklist item generators — each checks one condition
// ---------------------------------------------------------------------------

async function checkSchedulerHealth(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    const status = await getSchedulerStatus();
    if (!status.running) {
      items.push({
        id: "scheduler-stopped",
        category: "system-health",
        severity: "critical",
        title: "Scheduler is stopped",
        description: "No cycles are running. The system is idle.",
        action: { type: "dashboard", label: "Start scheduler", target: "/" },
      });
    }
  } catch { /* intentional: scheduler status unavailable, skip */ }
  return items;
}

async function checkMergeRate(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    const stats = await getAggregateStats(20);
    if (stats.mergedRate < 30) {
      items.push({
        id: "low-merge-rate",
        category: "system-health",
        severity: "warning",
        title: `Merge rate is ${stats.mergedRate}% (last 20 cycles)`,
        description: "Below 30% — cycles may be wasting compute on bad anchors or failing tasks.",
        action: { type: "dashboard", label: "View metrics", target: "/metrics" },
      });
    }
  } catch { /* intentional: metrics unavailable, skip */ }
  return items;
}

async function checkBacklogHygiene(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    const counts = await getBacklogCounts();
    const triageCount = counts.triage || 0;
    const blockedCount = counts.blocked || 0;
    const inProgressCount = counts.inProgress || 0;

    if (triageCount > 5) {
      items.push({
        id: "triage-pileup",
        category: "backlog-hygiene",
        severity: triageCount > 15 ? "warning" : "info",
        title: `${triageCount} items in triage need routing`,
        description: "Research auto-queued items accumulate in triage. Route them to queued or dismiss.",
        action: { type: "skill", label: "Run /hydra-target-review", target: "/hydra-target-review" },
      });
    }

    if (blockedCount > 0) {
      items.push({
        id: "blocked-items",
        category: "backlog-hygiene",
        severity: "warning",
        title: `${blockedCount} blocked item${blockedCount > 1 ? "s" : ""} in backlog`,
        description: "Blocked items may have stale blockers that can be cleared.",
        action: { type: "dashboard", label: "View backlog", target: "/backlog" },
      });
    }

    if (inProgressCount > 3) {
      items.push({
        id: "wip-overload",
        category: "backlog-hygiene",
        severity: "info",
        title: `${inProgressCount} items in progress (WIP limit concern)`,
        description: "High WIP count may indicate stale in-progress items that should be requeued.",
        action: { type: "dashboard", label: "View backlog", target: "/backlog" },
      });
    }
  } catch { /* intentional: backlog unavailable, skip */ }
  return items;
}

async function checkQueues(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    const workQueueLen = await getWorkQueueLen();
    const priorFailures = await listLen(redisKeys.anchorPriorFailures());
    const reframeLen = await listLen("hydra:anchors:reframe-queue");

    if (workQueueLen === 0) {
      items.push({
        id: "empty-work-queue",
        category: "system-health",
        severity: "info",
        title: "Work queue is empty",
        description: "The system will fall back to codebase-health or priorities doc. Consider running research or adding work.",
        action: { type: "skill", label: "Run /hydra-target-research", target: "/hydra-target-research" },
      });
    }

    if (priorFailures > 3) {
      items.push({
        id: "prior-failures",
        category: "system-health",
        severity: "warning",
        title: `${priorFailures} prior failure${priorFailures > 1 ? "s" : ""} awaiting retry`,
        description: "Failed tasks accumulating — they may need diagnosis or manual intervention.",
        action: { type: "skill", label: "Run /hydra-target-review", target: "/hydra-target-review" },
      });
    }

    if (reframeLen > 0) {
      items.push({
        id: "reframe-queue",
        category: "system-health",
        severity: "warning",
        title: `${reframeLen} item${reframeLen > 1 ? "s" : ""} in reframe queue`,
        description: "Tasks that failed 3+ times and need a fresh approach or operator diagnosis.",
        action: { type: "skill", label: "Run /hydra-target-review", target: "/hydra-target-review" },
      });
    }
  } catch { /* intentional: Redis unavailable, skip */ }
  return items;
}

async function checkGitHubIssues(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    const { stdout } = await execFileAsync("gh", [
      "issue", "list", "--repo", "gaberoo322/hydra",
      "--state", "open", "--json", "number,title,labels",
    ], { timeout: 10000 });
    const issues = JSON.parse(stdout);

    const readyForHuman = issues.filter((i: any) =>
      i.labels?.some((l: any) => l.name === "ready-for-human"),
    );
    const needsTriage = issues.filter((i: any) =>
      i.labels?.some((l: any) => l.name === "needs-triage"),
    );
    const readyForAgent = issues.filter((i: any) =>
      i.labels?.some((l: any) => l.name === "ready-for-agent"),
    );

    if (readyForHuman.length > 0) {
      items.push({
        id: "gh-ready-for-human",
        category: "strategic-review",
        severity: "warning",
        title: `${readyForHuman.length} GitHub issue${readyForHuman.length > 1 ? "s" : ""} need human decision`,
        description: readyForHuman.map((i: any) => `#${i.number}: ${i.title}`).join("; "),
        action: { type: "skill", label: "Run /hydra-review", target: "/hydra-review" },
      });
    }

    if (needsTriage.length > 0) {
      items.push({
        id: "gh-needs-triage",
        category: "strategic-review",
        severity: "info",
        title: `${needsTriage.length} GitHub issue${needsTriage.length > 1 ? "s" : ""} need triage`,
        description: needsTriage.map((i: any) => `#${i.number}: ${i.title}`).join("; "),
        action: { type: "skill", label: "Run /triage", target: "/triage" },
      });
    }

    if (readyForAgent.length > 0) {
      items.push({
        id: "gh-ready-for-agent",
        category: "strategic-review",
        severity: "info",
        title: `${readyForAgent.length} issue${readyForAgent.length > 1 ? "s" : ""} ready for agent pickup`,
        description: readyForAgent.map((i: any) => `#${i.number}: ${i.title}`).join("; "),
        action: { type: "skill", label: "Run /hydra-dev", target: "/hydra-dev" },
      });
    }
  } catch { /* intentional: gh CLI unavailable or timeout, skip */ }
  return items;
}

async function checkConfigStaleness(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const THREE_DAYS = 3 * ONE_DAY;

  const filesToCheck = [
    { path: resolve(CONFIG_PATH, "direction/priorities.md"), label: "priorities.md", threshold: THREE_DAYS },
    { path: resolve(CONFIG_PATH, "direction/vision.md"), label: "vision.md", threshold: 7 * ONE_DAY },
    { path: resolve(CONFIG_PATH, "feedback/to-planner.md"), label: "to-planner.md (feedback rules)", threshold: 7 * ONE_DAY },
  ];

  for (const file of filesToCheck) {
    try {
      const fileStat = await stat(file.path);
      const age = now - fileStat.mtimeMs;
      if (age > file.threshold) {
        const days = Math.floor(age / ONE_DAY);
        items.push({
          id: `stale-${file.label.replace(/[^a-z0-9]/gi, "-")}`,
          category: "strategic-review",
          severity: "info",
          title: `${file.label} last updated ${days} day${days > 1 ? "s" : ""} ago`,
          description: `Review and update if the system's direction has changed.`,
          action: { type: "dashboard", label: "View config", target: "/config" },
        });
      }
    } catch { /* intentional: file doesn't exist, skip */ }
  }
  return items;
}

async function checkTargetProject(): Promise<ChecklistItem[]> {
  const items: ChecklistItem[] = [];
  try {
    // Check for recent merges in target project
    const { stdout } = await execFileAsync("git", [
      "log", "--oneline", "--since=24 hours ago",
    ], { cwd: getTargetWorkspace(), timeout: 5000 });

    const mergeCount = stdout.trim().split("\n").filter(Boolean).length;
    if (mergeCount === 0) {
      items.push({
        id: "target-no-recent-merges",
        category: "target-project",
        severity: "info",
        title: "No target project merges in the last 24h",
        description: "The target project hasn't had any merges. Check if cycles are producing work.",
        action: { type: "skill", label: "Run /hydra-digest", target: "/hydra-digest" },
      });
    }
  } catch { /* intentional: target project unavailable, skip */ }
  return items;
}

// ---------------------------------------------------------------------------
// Skill reference — static data about operator skills
// ---------------------------------------------------------------------------

const SKILL_REFERENCE = [
  {
    category: "Daily Operations",
    skills: [
      { name: "/hydra-digest", description: "Summary of recent activity — merges, failures, cost, test growth", when: "Start of day or after overnight run" },
      { name: "/hydra-review", description: "Review GitHub issues needing human decisions", when: "When ready-for-human issues accumulate" },
      { name: "/hydra-target-review", description: "Review target project backlog items needing attention", when: "When triage/blocked items accumulate" },
      { name: "/triage", description: "Triage GitHub issues through the state machine", when: "When needs-triage issues appear" },
    ],
  },
  {
    category: "Development",
    skills: [
      { name: "/hydra-dev", description: "Pick up a GitHub issue and implement it autonomously", when: "When ready-for-agent issues exist" },
      { name: "/hydra-target-build", description: "Run a full build cycle on the target project", when: "When you want to manually trigger a build" },
      { name: "/hydra-sweep", description: "Advance every issue on the board that can be progressed", when: "When multiple issues need advancement" },
      { name: "/hydra-target-sweep", description: "Process target project backlog autonomously", when: "When backlog triage/blocked lanes have items" },
    ],
  },
  {
    category: "Research & Strategy",
    skills: [
      { name: "/hydra-target-research", description: "Research opportunities for the target project", when: "When work queue is low or priorities need refresh" },
      { name: "/hydra-research", description: "Research improvements for the Hydra orchestrator itself", when: "When the orchestrator needs architectural improvements" },
      { name: "/hydra-architect", description: "Strategic architecture review of the Hydra system", when: "Periodic deep review of system design" },
    ],
  },
  {
    category: "Health & Diagnostics",
    skills: [
      { name: "/hydra-doctor", description: "Comprehensive health check with auto-fix", when: "When something seems off or after incidents" },
      { name: "/hydra-discover", description: "Deep discovery loop — finds improvement opportunities", when: "When you want to proactively find issues" },
      { name: "/hydra-target-discover", description: "Runtime diagnostics for the target project", when: "When checking target project production health" },
      { name: "/hydra-incident", description: "Automated incident response for regressions", when: "When tests collapse, services crash, or regressions appear" },
    ],
  },
  {
    category: "Autonomous (for /loop)",
    skills: [
      { name: "/hydra-autopilot", description: "Meta-orchestrator — picks the right skill automatically", when: "Overnight unattended operation: /loop 10m /hydra-autopilot" },
      { name: "/hydra-discover", description: "Continuous discovery loop", when: "Background discovery: /loop 15m /hydra-discover" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createChecklistRouter() {
  const router = Router();

  // GET /checklist — Aggregated operator checklist
  router.get("/checklist", async (_req, res) => {
    try {
      // Run all checks in parallel
      const results = await Promise.all([
        checkSchedulerHealth(),
        checkMergeRate(),
        checkBacklogHygiene(),
        checkQueues(),
        checkGitHubIssues(),
        checkConfigStaleness(),
        checkTargetProject(),
      ]);

      const items = results.flat();

      // Sort: critical first, then warning, then info
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      res.json({ items, skills: SKILL_REFERENCE, generatedAt: new Date().toISOString() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
