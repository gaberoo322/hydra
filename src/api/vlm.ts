import { Router } from "express";
import { randomBytes } from "node:crypto";

import { defaultClaudeSpawn } from "../claude-cli/exec.ts";

import { logger } from "../logger.ts";
import { VlmChatCompletionRequestSchema } from "../schemas/vlm.ts";
import {
  collectImageUrls,
  collectText,
  materializeImage,
  resolveTimeoutMs,
  runClaude,
  type ClaudeCliEnvelope,
  type MaterializedImage,
  type SpawnFn,
} from "../vlm/index.ts";

/**
 * VLM claude-cli shim — an OpenAI-compatible `/vlm/v1/chat/completions` route
 * that shells `claude -p` for image understanding (issue #3542, epic #3541,
 * ADR-0005 subscription-backed path). It replaces the local Ollama VLM in the
 * OpenViking knowledge plane: OpenViking's `vlm.api_base` points at
 * `http://host.docker.internal:4000/vlm/v1`, so this MUST mount at app-root
 * `/vlm` (see api.ts), NOT under the `/api` Router.
 *
 * This module is the THIN HTTP ADAPTER (issue #3633): schema validation, the
 * image/text path split, the OpenAI-envelope response, and the 400/502 error
 * mapping. It
 * composes two focused leaves under `src/vlm/`: image-materializer.ts (the pure
 * content-part collection + data-URI decode + temp-file cluster) and
 * claude-cli-runner.ts (the runClaude spawn/SIGKILL-timeout logic with the
 * spawnImpl CI-safety seam). See src/vlm/index.ts.
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
 *     never an unbounded hang. The deadline (DEFAULT_REQUEST_TIMEOUT_MS) and the
 *     runClaude seam now live in src/vlm/claude-cli-runner.ts.
 *   - CI SAFETY. The spawn is injected via `spawnImpl` so the unit test drives
 *     a mocked envelope; no live `claude` process launches in CI.
 */

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_MODEL = "sonnet";

/**
 * Prompt used when the VLM client sends only an image with no accompanying
 * text instruction. OpenViking's VLM captioning calls carry no user prompt, so
 * this default drives a plain describe-the-image caption.
 */
const DEFAULT_CAPTION_INSTRUCTION = "Describe this image in detail.";

/**
 * Prompt used when a TEXT-ONLY request carries no instruction of its own.
 * OpenViking's summary generation always sends the document text, so this is
 * defensive.
 */
const DEFAULT_TEXT_INSTRUCTION = "Summarize the following content.";

/**
 * Tool policy for the TEXT-ONLY path (issue #3746).
 *
 * A text summarization has no file to read and no side effects, so every tool
 * is denied — this also trims the tool schemas out of the loaded system prompt,
 * cutting per-call subscription-token overhead. Mirrors the betting
 * claude-cli-fetcher's `DISALLOWED_TOOLS`, the established precedent for a
 * pure text→text `claude -p` call in this codebase.
 *
 * `--disallowedTools` accepts a single space-joined argument.
 */
const TEXT_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
].join(" ");

/**
 * Agentic-turn ceiling for the TEXT-ONLY path. Deliberately > 1.
 *
 * `--disallowedTools` DENIES rather than hides the tools, so a stray tool
 * attempt — which the model makes stochastically even under a plain
 * summarize-this prompt — consumes a turn on the denial. At `--max-turns 1`
 * that exhausts the budget before any answer exists and the CLI exits
 * `error_max_turns`. The betting fetcher measured exactly this: ~24% of calls
 * lost (6/25) until issue #678 raised its ceiling to 4. Reusing that proven
 * value rather than re-deriving it.
 */
const TEXT_MAX_TURNS = 4;

export interface VlmRouterDeps {
  /** Path or bare name of the `claude` binary. Defaults to `claude` (PATH-resolved). */
  claudeBinPath?: string;
  /** Overrides `--model`. Defaults to the request's `model`, else `sonnet`. */
  model?: string;
  /** Per-call wall-clock deadline in ms. Defaults to 300_000. Non-positive/invalid → default. */
  requestTimeoutMs?: number;
  /**
   * Injectable spawn for tests — production defaults to `defaultClaudeSpawn`
   * from the Claude CLI Adapter (`src/claude-cli/exec.ts`), which owns the one
   * `node:child_process` import for the `claude` binary (issue #3703). Tests
   * MUST inject this so no real `claude` CLI launches (acceptance criterion: no
   * live subscription call in CI).
   */
  spawnImpl?: SpawnFn;
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
  const spawnImpl = deps.spawnImpl ?? defaultClaudeSpawn;
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
    const hasImage = imageUrls.length > 0;
    const instruction =
      collectText(messages) ||
      (hasImage ? DEFAULT_CAPTION_INSTRUCTION : DEFAULT_TEXT_INSTRUCTION);

    // TEXT-ONLY vs IMAGE (issue #3746). OpenViking points ONE `vlm.api_base` at
    // this shim and drives BOTH paths through it: image captioning AND document
    // summary generation, which sends no image at all. The shim originally 400'd
    // the no-image case as "nothing to caption", which is right for a pure VLM
    // but wrong for OV's actual client — every text summary failed
    // `vlm-no-image`, leaving the OV skill catalog partial. The no-image case is
    // a plain text completion, not an error.
    let materialized: MaterializedImage | undefined;
    try {
      let prompt: string;
      let toolArgs: string[];
      let maxTurns: string;

      if (hasImage) {
        // Materialize the first image; the shim captions one image per call (the
        // OpenViking VLM client sends one image per document). Any additional
        // images are ignored — a caption over the primary image is the contract.
        materialized = await materializeImage(imageUrls[0]);
        prompt = `Read the image file at ${materialized.reference} and then respond to this request: ${instruction}`;
        // INVERTS the betting fetcher's blanket --disallowedTools: the shim
        // must ALLOW Read so `claude -p` can load the image off disk. Only Read
        // is allowed — no Bash/Write/etc.
        toolArgs = ["--allowedTools", "Read"];
        maxTurns = "1";
      } else {
        // No image: pass the instruction straight through. Nothing is read off
        // disk, so every tool is denied and the turn ceiling is raised — see
        // TEXT_DISALLOWED_TOOLS / TEXT_MAX_TURNS for why > 1 is load-bearing.
        prompt = instruction;
        toolArgs = ["--disallowedTools", TEXT_DISALLOWED_TOOLS];
        maxTurns = String(TEXT_MAX_TURNS);
      }

      const args = [
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--max-turns",
        maxTurns,
        "--dangerously-skip-permissions",
        // Load NO MCP servers (issue #3746 incident). `--strict-mcp-config`
        // means "only use servers from --mcp-config"; passing no --mcp-config
        // therefore yields an empty set.
        //
        // Without this, EVERY shim call inherits the host's ambient `~/.claude`
        // MCP config and spawns those servers (sentry, context7) before the
        // prompt even runs — and they are NOT reaped when `claude -p` exits.
        // On 2026-07-28 that leaked 184 orphaned mcp-server processes burning
        // 8.4 cores and 68% of RAM (load average 211), which starved the CI
        // pool. A summarize-this-document call has no use for them, and the
        // tool policy above already denies every tool, so an MCP server could
        // not be invoked even if it loaded.
        "--strict-mcp-config",
        ...toolArgs,
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
