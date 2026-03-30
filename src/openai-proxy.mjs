#!/usr/bin/env node

/**
 * OpenAI API Proxy
 *
 * Bridges OpenViking (and other tools) to the Codex subscription:
 *
 * - /v1/embeddings → forwarded to api.openai.com with the Codex OAuth token
 *   (text-embedding-3-small is the only model the token grants access to)
 *
 * - /v1/chat/completions → routed through `codex exec` since the OAuth token
 *   lacks the model.request scope for chat endpoints. The proxy translates
 *   the OpenAI chat format into a codex exec call and returns a compatible
 *   response. Uses gpt-5.3-codex (fastest available Codex model).
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const PORT = parseInt(process.env.OPENAI_PROXY_PORT) || 4001;
const AUTH_FILE = resolve(process.env.HOME, ".codex", "auth.json");
const UPSTREAM = "https://api.openai.com";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_VLM_MODEL || "gpt-5.3-codex";

async function getAccessToken() {
  const raw = await readFile(AUTH_FILE, "utf-8");
  const auth = JSON.parse(raw);
  return auth.tokens?.access_token;
}

/**
 * Handle chat completions by routing through codex exec.
 */
function handleChatCompletions(reqBody) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = JSON.parse(reqBody);
    } catch {
      return reject(new Error("Invalid JSON body"));
    }

    // Build a single prompt from the messages array
    const prompt = parsed.messages
      .map((m) => {
        if (m.role === "system") return `[System]: ${m.content}`;
        if (m.role === "user") return m.content;
        return `[${m.role}]: ${m.content}`;
      })
      .join("\n\n");

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--full-auto",
      "--json",
      "--model", CODEX_MODEL,
      prompt,
    ];

    execFile(CODEX_BIN, args, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME },
    }, (err, stdout, stderr) => {
      // Extract the final message from JSON lines output
      let text = "";
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "item.completed" && evt.item?.text) {
            text = evt.item.text;
          }
        } catch {}
      }

      if (!text && err) {
        return reject(new Error(`codex exec failed: ${err.message}`));
      }

      // Return an OpenAI-compatible chat completion response
      resolve({
        id: `chatcmpl-codex-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: CODEX_MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: text || "(no output)" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    });
  });
}

/**
 * Forward embedding requests to OpenAI with the Codex OAuth token.
 */
async function handleEmbeddings(req, body) {
  const token = await getAccessToken();
  if (!token) throw new Error("No Codex access token. Run: codex login --device-auth");

  const upstream = await fetch(`${UPSTREAM}${req.url}`, {
    method: req.method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  return {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "application/json",
    body: Buffer.from(await upstream.arrayBuffer()),
  };
}

const server = createServer(async (req, res) => {
  // Collect request body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  try {
    if (req.url.startsWith("/v1/chat/completions")) {
      // Route through codex exec
      const result = await handleChatCompletions(body.toString());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));

    } else if (req.url.startsWith("/v1/embeddings")) {
      // Forward to OpenAI with Codex token
      const result = await handleEmbeddings(req, body);
      res.writeHead(result.status, { "Content-Type": result.contentType });
      res.end(result.body);

    } else {
      // Pass through other requests (may fail with scope errors)
      const token = await getAccessToken();
      const upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": req.headers["content-type"] || "application/json",
        },
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

server.listen(PORT, () => {
  console.log(`[OpenAI Proxy] Listening on http://localhost:${PORT}`);
  console.log(`[OpenAI Proxy] Embeddings → api.openai.com (Codex OAuth token)`);
  console.log(`[OpenAI Proxy] Chat completions → codex exec (${CODEX_MODEL})`);
});

process.on("SIGINT", () => { server.close(); process.exit(0); });
process.on("SIGTERM", () => { server.close(); process.exit(0); });
