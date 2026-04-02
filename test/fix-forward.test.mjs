import test from "node:test";
import assert from "node:assert/strict";

import { handleFailure } from "../src/fix-forward.mjs";
import { STREAMS } from "../src/event-bus.mjs";

function createEventBusRecorder() {
  const published = [];

  return {
    published,
    async publish(stream, event) {
      published.push({ stream, event });
    },
  };
}

test("deploy failures create builder fix tasks with deployment-stage wording", async () => {
  const eventBus = createEventBusRecorder();

  await handleFailure(
    {
      type: "deploy:failed",
      source: "devops",
      correlationId: "cycle-2026-03-31-21",
      payload: {
        taskId: "task-123",
        summary: "Processed tester pass event. No devops remediation required from this event.",
        issues: [],
      },
    },
    eventBus
  );

  assert.equal(eventBus.published.length, 2);

  const taskEvent = eventBus.published.find(({ stream }) => stream === STREAMS.TASKS)?.event;
  assert.ok(taskEvent);
  assert.equal(taskEvent.type, "task:created");
  assert.equal(taskEvent.payload.taskType, "build");
  assert.equal(taskEvent.payload.originalTaskId, "task-123");
  assert.match(taskEvent.payload.description, /^The deployment-stage step failed\./);
  assert.match(taskEvent.payload.description, /No devops remediation required from this event\./);
});

test("fix attempts are counted against the original task id", async () => {
  const eventBus = createEventBusRecorder();

  await handleFailure(
    {
      type: "test:failed",
      source: "tester",
      correlationId: "cycle-1",
      payload: {
        taskId: "task-456-fix-1",
        originalTaskId: "task-456",
        summary: "Regression failed",
      },
    },
    eventBus
  );

  const taskEvent = eventBus.published.find(({ stream }) => stream === STREAMS.TASKS)?.event;
  assert.ok(taskEvent);
  assert.equal(taskEvent.payload.fixAttempt, 1);
  assert.equal(taskEvent.payload.originalTaskId, "task-456");
  assert.equal(taskEvent.payload.taskId, "task-456-fix-1-fix-1");
});
