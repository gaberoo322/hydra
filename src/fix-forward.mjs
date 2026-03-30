import { EventBus, STREAMS } from "./event-bus.mjs";

const MAX_RETRIES = 3;

// Track retry counts: taskId -> count
const retryCounts = new Map();

/**
 * Handle a pipeline failure by creating a fix task.
 * Routes the fix back to the agent that can address it.
 *
 * Failure types:
 * - review:failed → Builder should fix the code issues
 * - test:failed   → Builder should fix the test failures
 * - deploy:failed → DevOps should fix the deployment issue
 */
async function handleFailure(event, eventBus) {
  const taskId = event.payload?.taskId;
  if (!taskId) return;

  const retryKey = `${taskId}-fix`;
  const retries = retryCounts.get(retryKey) || 0;

  if (retries >= MAX_RETRIES) {
    console.log(`[FixForward] Task ${taskId} shelved after ${MAX_RETRIES} fix attempts`);
    await eventBus.publish(STREAMS.NOTIFICATIONS, {
      type: "task:shelved",
      source: "fix-forward",
      correlationId: event.correlationId,
      payload: {
        taskId,
        reason: `Exceeded ${MAX_RETRIES} fix attempts`,
        lastFailure: event.type,
        issues: event.payload?.issues,
      },
    });
    retryCounts.delete(retryKey);
    return;
  }

  retryCounts.set(retryKey, retries + 1);

  // Determine fix routing
  let fixType, fixDescription, targetStream;

  switch (event.type) {
    case "review:failed":
      fixType = "build";
      fixDescription = buildFixDescription("code review", event);
      targetStream = STREAMS.TASKS;
      break;

    case "test:failed":
      fixType = "build";
      fixDescription = buildFixDescription("test", event);
      targetStream = STREAMS.TASKS;
      break;

    case "deploy:failed":
      fixType = "build";
      fixDescription = buildFixDescription("deployment", event);
      targetStream = STREAMS.TASKS;
      break;

    default:
      console.log(`[FixForward] Unknown failure type: ${event.type}`);
      return;
  }

  const fixTaskId = `${taskId}-fix-${retries + 1}`;
  console.log(`[FixForward] Creating fix task ${fixTaskId} (attempt ${retries + 1}/${MAX_RETRIES})`);

  await eventBus.publish(targetStream, {
    type: "task:created",
    source: "fix-forward",
    correlationId: event.correlationId,
    payload: {
      taskId: fixTaskId,
      taskType: fixType,
      title: `Fix: ${event.payload?.summary || event.type}`,
      description: fixDescription,
      priority: 1,
      acceptanceCriteria: ["All previously failing checks now pass"],
      isFixTask: true,
      originalTaskId: taskId,
      fixAttempt: retries + 1,
    },
  });

  await eventBus.publish(STREAMS.NOTIFICATIONS, {
    type: "fix:created",
    source: "fix-forward",
    correlationId: event.correlationId,
    payload: {
      fixTaskId,
      originalTaskId: taskId,
      failureType: event.type,
      attempt: retries + 1,
      maxAttempts: MAX_RETRIES,
    },
  });
}

function buildFixDescription(failureSource, event) {
  const issues = event.payload?.issues || [];
  const summary = event.payload?.summary || "Unknown failure";

  const parts = [
    `The ${failureSource} step failed. Fix the issues identified below.`,
    "",
    `## Failure Summary`,
    summary,
    "",
  ];

  if (issues.length > 0) {
    parts.push("## Issues to Fix");
    for (const issue of issues) {
      if (typeof issue === "string") {
        parts.push(`- ${issue}`);
      } else {
        parts.push(`- **${issue.severity || "issue"}**: ${issue.description || JSON.stringify(issue)}`);
        if (issue.suggestion) parts.push(`  Fix: ${issue.suggestion}`);
      }
    }
  }

  parts.push("", "## Instructions", "Fix the identified issues and resubmit. This is a fix task — focus narrowly on the reported problems.");

  return parts.join("\n");
}

export { handleFailure, MAX_RETRIES };
