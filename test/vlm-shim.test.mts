/**
 * test/vlm-shim.test.mts — pin the VLM claude-cli shim (issue #3542, epic
 * #3541): the OpenAI-compatible POST /vlm/v1/chat/completions route that shells
 * `claude -p` for image understanding, replacing the local Ollama VLM in the
 * OpenViking knowledge plane.
 *
 * The tests drive the router's handler directly with an INJECTED spawn seam
 * (a fake child process that emits a canned `claude --output-format json`
 * envelope) — NO real `claude` process launches (acceptance criterion: no live
 * subscription call in CI). They assert the design-concept invariants:
 *
 *   - a data-URI image_url content-part → an OpenAI chat.completion envelope
 *     whose choices[0].message.content is the claude `.result` caption verbatim;
 *   - the image bytes decode to a temp file under os.tmpdir() (NEVER the repo
 *     tree) that `claude -p` is told to Read, and the temp file is unlinked in
 *     a finally on BOTH success and error paths;
 *   - the spawn is invoked with --allowedTools Read (INVERTING the betting
 *     fetcher's Read-disallowed posture) and --output-format json;
 *   - a body with no image_url part → 400 vlm-no-image;
 *   - a malformed body (no messages) → 400 schema-validation-failed;
 *   - a claude is_error envelope → 502 vlm-cli-error AND the temp file is still
 *     cleaned up.
 *
 * New top-level describe with its own (trivial) lifecycle — it touches no shared
 * Redis seam, so it never piggybacks a sibling suite's teardown.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

import { createVlmRouter } from "../src/api/vlm.ts";

/** A 1x1 transparent PNG as a base64 data URI. */
const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** Records of every claude spawn — args + the temp path referenced in the prompt. */
type SpawnRecord = {
  bin: string;
  args: string[];
  /** The `Read the image file at <path>` path pulled out of the -p prompt. */
  imagePath: string | undefined;
};

/**
 * Build a fake `spawn` that: (a) records the invocation, (b) verifies the temp
 * image file exists ON DISK at spawn time (so we can later assert it was
 * cleaned up), and (c) emits the given canned stdout envelope then closes with
 * `exitCode`. Returns [fakeSpawn, records].
 */
function makeFakeSpawn(
  stdout: string,
  exitCode: number,
): { spawnImpl: any; records: SpawnRecord[]; sawFileOnDisk: () => boolean } {
  const records: SpawnRecord[] = [];
  let fileExistedAtSpawn = false;

  const spawnImpl = (bin: string, args: string[]): any => {
    const promptIdx = args.indexOf("-p");
    const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";
    const match = /Read the image file at (\S+)/.exec(prompt);
    const imagePath = match ? match[1] : undefined;
    if (imagePath && existsSync(imagePath)) fileExistedAtSpawn = true;
    records.push({ bin, args, imagePath });

    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    // Emit the canned envelope then close on the next tick.
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", exitCode);
    });
    return child;
  };

  return { spawnImpl, records, sawFileOnDisk: () => fileExistedAtSpawn };
}

function findHandler(router: any, method: string, path: string): Function | null {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path) {
      if (layer.route.methods[method.toLowerCase()]) {
        const stack = layer.route.stack;
        return stack[stack.length - 1].handle;
      }
    }
  }
  return null;
}

function mockReq(body: unknown): any {
  return { method: "POST", url: "/v1/chat/completions", headers: {}, query: {}, params: {}, body };
}

function mockRes(): any {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: any) {
      res._body = body;
      return res;
    },
  };
  return res;
}

/** Drive the POST /v1/chat/completions handler once and return {res, records, sawFile}. */
async function invoke(
  body: unknown,
  stdout: string,
  exitCode: number,
): Promise<{ res: any; records: SpawnRecord[]; sawFile: boolean }> {
  const { spawnImpl, records, sawFileOnDisk } = makeFakeSpawn(stdout, exitCode);
  const router = createVlmRouter({ spawnImpl, requestTimeoutMs: 5_000 });
  const handler = findHandler(router, "POST", "/v1/chat/completions");
  assert.ok(handler, "POST /v1/chat/completions handler is mounted");
  const res = mockRes();
  await handler(mockReq(body), res);
  return { res, records, sawFile: sawFileOnDisk() };
}

function imageBody(instruction?: string): unknown {
  const content: unknown[] = [{ type: "image_url", image_url: { url: PNG_DATA_URI } }];
  if (instruction) content.unshift({ type: "text", text: instruction });
  return { model: "sonnet", messages: [{ role: "user", content }] };
}

const OK_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "A tiny transparent placeholder image.",
  usage: { input_tokens: 10, output_tokens: 8 },
});

describe("vlm claude-cli shim (issue #3542)", () => {
  test("data-URI image → OpenAI chat.completion with the claude .result caption verbatim", async () => {
    const { res, records, sawFile } = await invoke(imageBody("Describe it"), OK_ENVELOPE, 0);

    assert.equal(res._status, 200);
    assert.equal(res._body.object, "chat.completion");
    assert.equal(res._body.model, "sonnet");
    assert.equal(res._body.choices[0].index, 0);
    assert.equal(res._body.choices[0].message.role, "assistant");
    // .result surfaced verbatim (free-text caption, NOT JSON-parsed).
    assert.equal(
      res._body.choices[0].message.content,
      "A tiny transparent placeholder image.",
    );
    assert.equal(res._body.choices[0].finish_reason, "stop");

    // Exactly one claude spawn, with the image-aware tool policy.
    assert.equal(records.length, 1);
    const { args } = records[0];
    assert.ok(args.includes("--output-format") && args.includes("json"));
    // INVERTS the betting fetcher: Read is ALLOWED so claude can load the image.
    const allowIdx = args.indexOf("--allowedTools");
    assert.ok(allowIdx >= 0 && args[allowIdx + 1] === "Read");
    assert.ok(!args.includes("--disallowedTools"));
    assert.ok(args.includes("--dangerously-skip-permissions"));

    // The temp file existed on disk at spawn time (so claude could Read it)...
    assert.ok(sawFile, "temp image file must exist on disk when claude is spawned");
    // ...under os.tmpdir(), never the repo tree...
    assert.ok(records[0].imagePath!.startsWith(tmpdir()));
    // ...and is unlinked after the request completes.
    assert.ok(
      !existsSync(records[0].imagePath!),
      "temp image file must be cleaned up after a successful request",
    );
  });

  test("default caption instruction when the body carries no text part", async () => {
    const { res, records } = await invoke(imageBody(), OK_ENVELOPE, 0);
    assert.equal(res._status, 200);
    const promptIdx = records[0].args.indexOf("-p");
    assert.match(records[0].args[promptIdx + 1], /Describe this image in detail\./);
  });

  test("body with no image_url content-part → 400 vlm-no-image", async () => {
    const body = { messages: [{ role: "user", content: "just text, no image" }] };
    const { res, records } = await invoke(body, OK_ENVELOPE, 0);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "vlm-no-image");
    // No claude spawned when there's nothing to caption.
    assert.equal(records.length, 0);
  });

  test("malformed body (no messages) → 400 schema-validation-failed", async () => {
    const { res, records } = await invoke({ model: "sonnet" }, OK_ENVELOPE, 0);
    assert.equal(res._status, 400);
    assert.equal(res._body.code, "schema-validation-failed");
    assert.ok(Array.isArray(res._body.issues));
    assert.equal(records.length, 0);
  });

  test("claude is_error envelope → 502 vlm-cli-error AND the temp file is still cleaned up", async () => {
    const errEnvelope = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "model sonnet may not exist",
    });
    const { res, records, sawFile } = await invoke(imageBody("Describe it"), errEnvelope, 1);

    assert.equal(res._status, 502);
    assert.equal(res._body.code, "vlm-cli-error");
    assert.match(res._body.message, /model sonnet may not exist/);

    // Temp file existed at spawn, and the finally cleaned it up on the error path.
    assert.ok(sawFile, "temp image file must exist on disk at spawn time");
    assert.ok(
      !existsSync(records[0].imagePath!),
      "temp image file must be cleaned up even on the claude-error path",
    );
  });

  test("non-JSON claude stdout with non-zero exit → 502 vlm-cli-error", async () => {
    const { res } = await invoke(imageBody("Describe it"), "garbage not json", 1);
    assert.equal(res._status, 502);
    assert.equal(res._body.code, "vlm-cli-error");
  });
});
