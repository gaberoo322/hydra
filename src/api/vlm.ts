import { Router } from "express";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logger } from "../logger.ts";
import {
  VlmChatCompletionRequestSchema,
  type VlmContentPart,
  type VlmMessage,
} from "../schemas/vlm.ts";

/**
 * VLM claude-cli shim — an OpenAI-compatible `/vlm/v1/chat/completions` route
 * that shells `claude -p` for image understanding (issue #3542, epic #3541,
 * ADR-0005 subscription-backed path). It replaces the local Ollama VLM in the
 * OpenViking knowledge plane: OpenViking's `vlm.api_base` points at
 * `http://host.docker.internal:4000/vlm/v1`, so this MUST mount at app-root
 * `/vlm` (see api.ts), NOT under the `/api` Router.
 *
 * Design (design-concept issue-3542, "approved"):
 *   - HOST-SIDE ONLY. `claude -p` needs the host's ambient `~/.claude/` OAuth
 *     login (ZERO metered API spend, no ANTHROPIC_API_KEY — the SAME
 *     subscription-backed path hydra-autopilot and the betting paper-LLM
 *     fetcher use). The prebuilt OV container cannot reach that login, so the
 *     route runs in the port-4000 Orchestrator service and OV reaches it via
 *     its already-wired `host.docker.internal:host-gateway` extra_host.
 *   - IMAGE HANDLING. `claude -p` takes no raw image on the prompt line. An
 *     OpenAI `image_url` content-part (a `data:` URI or an http(s) URL) decodes
 *     to a temp file under `os.tmpdir()` (NEVER the repo/git tree); the prompt
 *     asks the model to `Read` that path, with `--allowedTools Read` so it can
 *     load the file. This INVERTS the betting fetcher's blanket
 *     `--disallowedTools` (which disallows Read) — the port is structural
 *     (spawn/envelope/timeout), the tool policy is opposite.
 *   - OUTPUT. `claude --output-format json` returns an envelope whose `.result`
 *     is the free-text caption. Unlike the betting fetcher, the shim does NOT
 *     `parseFirstJsonObject` the result — a VLM caption is free text — it
 *     re-wraps `.result` verbatim as an OpenAI `chat.completion` envelope's
 *     `choices[0].message.content`.
 *   - TIMEOUT. Raised well above the betting text-fetcher's 120s default: VLM
 *     image understanding with a Read-tool round-trip is slower and OV indexing
 *     is a latency-tolerant background workload. Bounded (SIGKILL on deadline),
 *     never an unbounded hang.
 *   - CI SAFETY. The spawn is injected via `spawnImpl` so the unit test drives
 *     a mocked envelope; no live `claude` process launches in CI.
 */

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_MODEL = "sonnet";
/**
 * Per-call deadline. Strictly greater than the betting text-fetcher's 120s
 * default (design-concept invariant): VLM image understanding via a Read-tool
 * round-trip is slower, and OpenViking indexing is a latency-tolerant
 * background workload — but still bounded so the route can never hang forever.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Prompt used when the VLM client sends only an image with no accompanying
 * text instruction. OpenViking's VLM captioning calls carry no user prompt, so
 * this default drives a plain describe-the-image caption.
 */
const DEFAULT_CAPTION_INSTRUCTION = "Describe this image in detail.";

type SpawnFn = typeof spawn;

export interface VlmRouterDeps {
  /** Path or bare name of the `claude` binary. Defaults to `claude` (PATH-resolved). */
  claudeBinPath?: string;
  /** Overrides `--model`. Defaults to the request's `model`, else `sonnet`. */
  model?: string;
  /** Per-call wall-clock deadline in ms. Defaults to 300_000. Non-positive/invalid → default. */
  requestTimeoutMs?: number;
  /**
   * Injectable spawn for tests — production defaults to node:child_process
   * spawn. Tests MUST inject this so no real `claude` CLI launches
   * (acceptance criterion: no live subscription call in CI).
   */
  spawnImpl?: SpawnFn;
}

type ClaudeCliEnvelope = {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  usage?: unknown;
  total_cost_usd?: unknown;
  duration_ms?: unknown;
};

type ClaudeCliRun = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function resolveTimeoutMs(raw: number | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Run `claude` and resolve on close REGARDLESS of exit code — ported verbatim
 * from the betting fetcher's `runClaude`. The CLI reports model/auth/quota
 * failures as an `is_error` envelope on STDOUT while exiting 1, and that
 * envelope's `.result` carries the human message; rejecting on `code !== 0`
 * before parsing would swallow it. stdin is ignored so the CLI never blocks
 * waiting on it; a timeout SIGKILLs the child and rejects.
 */
function runClaude(
  spawnImpl: SpawnFn,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ClaudeCliRun> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnImpl(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(
        new Error(
          `claude-cli spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* intentional: child may already be gone; the timeout error is what matters */
        }
        reject(new Error(`claude-cli timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(
          new Error(
            `claude-cli spawn failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
    child.on("close", (code) => {
      finish(() => {
        resolve({ code, stdout, stderr });
      });
    });
  });
}

/** Flatten a message's `content` into its text parts, joined. */
function messageText(message: VlmMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<VlmContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Collect every image content-part URL across all messages. */
function collectImageUrls(messages: VlmMessage[]): string[] {
  const urls: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image_url") urls.push(part.image_url.url);
    }
  }
  return urls;
}

/** Collect every text instruction across all messages, joined. */
function collectText(messages: VlmMessage[]): string {
  return messages
    .map((message) => messageText(message))
    .filter((text) => text.length > 0)
    .join("\n\n")
    .trim();
}

const DATA_URI_RE = /^data:(?<mime>[^;,]+)?(?<base64>;base64)?,(?<data>.*)$/s;

/** Map an image MIME type to a file extension for the temp file. */
function extensionForMime(mime: string | undefined): string {
  switch ((mime ?? "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/**
 * Decode a `data:` URI into raw bytes + extension. Returns null for a non-data
 * URL (e.g. an http(s) URL, which is handed to the model as-is). Base64 and
 * URL-encoded (percent) data URIs are both handled.
 */
function decodeDataUri(url: string): { bytes: Buffer; ext: string } | null {
  const match = DATA_URI_RE.exec(url);
  if (!match || !match.groups) return null;
  const { mime, base64, data } = match.groups;
  const bytes = base64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");
  return { bytes, ext: extensionForMime(mime) };
}

/**
 * Materialize the first image reference for `claude -p`. A `data:` URI decodes
 * to a temp file under `os.tmpdir()` (NEVER the repo tree) and the returned
 * `cleanup` unlinks the temp dir; an http(s) URL is passed through as-is with a
 * no-op cleanup (the model fetches it via the Read/WebFetch path — but the shim
 * only allows Read, so a remote URL is best-effort). Returns the on-disk path
 * or URL the prompt should reference, plus the cleanup to run in a `finally`.
 */
async function materializeImage(
  url: string,
): Promise<{ reference: string; cleanup: () => Promise<void> }> {
  const decoded = decodeDataUri(url);
  if (!decoded) {
    // Non-data URL: hand it to the model verbatim, nothing to clean up.
    return { reference: url, cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "hydra-vlm-"));
  const file = join(dir, `image-${randomBytes(6).toString("hex")}.${decoded.ext}`);
  await writeFile(file, decoded.bytes);
  return {
    reference: file,
    cleanup: async () => {
      // rm the whole temp dir; recursive+force so a partially-written file or
      // an already-removed dir cannot throw out of the finally.
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * OpenAI `chat.completion` envelope wrapping a claude `.result` caption. The
 * VLM caption is free text, so `.result` is surfaced verbatim as
 * `choices[0].message.content` (NOT parsed into a JSON object).
 */
function buildChatCompletion(model: string, content: string): unknown {
  return {
    id: `chatcmpl-vlm-${randomBytes(8).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

/**
 * VLM shim router. Mounts at app-root `/vlm` (see api.ts) so
 * `/vlm/v1/chat/completions` resolves for OpenViking's
 * `vlm.api_base=http://host.docker.internal:4000/vlm/v1`.
 */
export function createVlmRouter(deps: VlmRouterDeps = {}): Router {
  const router = Router();
  const claudeBinPath = deps.claudeBinPath?.trim() || DEFAULT_CLAUDE_BIN;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const requestTimeoutMs = resolveTimeoutMs(deps.requestTimeoutMs);

  router.post("/v1/chat/completions", async (req, res) => {
    const parsed = VlmChatCompletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ code: "schema-validation-failed", issues: parsed.error.issues });
    }

    const { messages } = parsed.data;
    const model = deps.model?.trim() || parsed.data.model?.trim() || DEFAULT_MODEL;

    const imageUrls = collectImageUrls(messages);
    const instruction = collectText(messages) || DEFAULT_CAPTION_INSTRUCTION;

    // No image → nothing for the VLM to caption. Reject rather than shelling a
    // pointless text-only claude call through the image path.
    if (imageUrls.length === 0) {
      return res.status(400).json({
        code: "vlm-no-image",
        message: "VLM shim requires at least one image_url content-part",
      });
    }

    // Materialize the first image; the shim captions one image per call (the
    // OpenViking VLM client sends one image per document). Any additional
    // images are ignored — a caption over the primary image is the contract.
    let materialized: { reference: string; cleanup: () => Promise<void> } | undefined;
    try {
      materialized = await materializeImage(imageUrls[0]);
      const prompt = `Read the image file at ${materialized.reference} and then respond to this request: ${instruction}`;

      const args = [
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--dangerously-skip-permissions",
        // INVERTS the betting fetcher's blanket --disallowedTools: the shim
        // must ALLOW Read so `claude -p` can load the image off disk. Only Read
        // is allowed — no Bash/Write/etc.
        "--allowedTools",
        "Read",
      ];

      const { code, stdout, stderr } = await runClaude(
        spawnImpl,
        claudeBinPath,
        args,
        requestTimeoutMs,
      );

      let envelope: ClaudeCliEnvelope | undefined;
      try {
        envelope = JSON.parse(stdout.trim()) as ClaudeCliEnvelope;
      } catch {
        if (code !== 0) {
          logger.error(
            { code, stderr: stderr.trim().slice(0, 500) },
            "vlm-shim: claude-cli exited non-zero with non-JSON stdout",
          );
          return res.status(502).json({
            code: "vlm-cli-error",
            message: `claude-cli exited ${code ?? "null"}: ${stderr.trim().slice(0, 500)}`,
          });
        }
        logger.error({}, "vlm-shim: claude-cli returned a non-JSON envelope");
        return res
          .status(502)
          .json({ code: "vlm-cli-error", message: "claude-cli returned a non-JSON envelope" });
      }

      const resultText = typeof envelope.result === "string" ? envelope.result.trim() : "";
      if (envelope.is_error === true || code !== 0) {
        const subtype = typeof envelope.subtype === "string" ? envelope.subtype : "error";
        const detail = resultText || stderr.trim() || `exit ${code ?? "null"}`;
        logger.error(
          { subtype, detail: detail.slice(0, 500) },
          "vlm-shim: claude-cli reported an error envelope",
        );
        return res.status(502).json({
          code: "vlm-cli-error",
          message: `claude-cli reported an error (${subtype}): ${detail.slice(0, 500)}`,
        });
      }

      if (resultText.length === 0) {
        logger.error({}, "vlm-shim: claude-cli envelope missing result text");
        return res
          .status(502)
          .json({ code: "vlm-cli-error", message: "claude-cli envelope missing result text" });
      }

      return res.status(200).json(buildChatCompletion(model, resultText));
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "vlm-shim: request failed",
      );
      return res.status(502).json({
        code: "vlm-cli-error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Unlink the temp image on BOTH success and error paths — a failed
      // claude call must never leak image bytes on disk.
      if (materialized) {
        try {
          await materialized.cleanup();
        } catch (cleanupError) {
          logger.error(
            { err: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
            "vlm-shim: temp image cleanup failed",
          );
        }
      }
    }
  });

  return router;
}
