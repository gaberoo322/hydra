/**
 * Request-body schema for the VLM claude-cli shim (issue #3542, epic #3541).
 *
 * The shim exposes an OpenAI-compatible `POST /vlm/v1/chat/completions` route
 * that OpenViking's VLM client calls for image captioning (its `vlm.api_base`
 * points at `http://host.docker.internal:4000/vlm/v1`). Per the **Schemas**
 * Seam every HTTP body validates through a `src/schemas/*` zod schema before
 * the handler touches it; on failure the route returns
 * 400 `{ code: "schema-validation-failed", issues }`.
 *
 * The body mirrors the subset of the OpenAI chat-completions contract the VLM
 * client sends: `messages[]`, where each message's `content` is EITHER a plain
 * string OR an array of typed parts. An image part is
 * `{ type: "image_url", image_url: { url } }` where `url` is a
 * `data:image/*;base64,<...>` data-URI or an `http(s)` URL; a text part is
 * `{ type: "text", text }`. `model` is optional (the shim defaults it).
 *
 * Non-strict object schemas (unknown keys ignored) so forward-compatible OpenAI
 * fields (temperature, max_tokens, stream, …) pass through without tripping
 * validation — the shim simply ignores what it does not consume.
 */
import { z } from "zod";

/** A text content-part: `{ type: "text", text }`. */
export const VlmTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * An image content-part: `{ type: "image_url", image_url: { url } }`.
 * `url` is a `data:` URI (base64-embedded bytes) or an `http(s)` URL.
 */
export const VlmImagePartSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string().min(1),
    // OpenAI's optional detail hint ("low" | "high" | "auto"); accepted and ignored.
    detail: z.string().optional(),
  }),
});

/** A single content-part is either a text part or an image_url part. */
export const VlmContentPartSchema = z.union([VlmTextPartSchema, VlmImagePartSchema]);

/**
 * A chat message. `content` is either a plain string (text-only) or an array
 * of typed parts (the multimodal form the VLM client uses for images).
 */
export const VlmMessageSchema = z.object({
  role: z.string().min(1),
  content: z.union([z.string(), z.array(VlmContentPartSchema)]),
});

/**
 * `POST /vlm/v1/chat/completions` body. `messages` is a non-empty array;
 * `model` is optional (the shim resolves a default). Unknown top-level keys
 * (temperature, stream, …) are ignored.
 */
export const VlmChatCompletionRequestSchema = z.object({
  messages: z.array(VlmMessageSchema).min(1),
  model: z.string().optional(),
});

export type VlmTextPart = z.infer<typeof VlmTextPartSchema>;
export type VlmImagePart = z.infer<typeof VlmImagePartSchema>;
export type VlmContentPart = z.infer<typeof VlmContentPartSchema>;
export type VlmMessage = z.infer<typeof VlmMessageSchema>;
export type VlmChatCompletionRequest = z.infer<typeof VlmChatCompletionRequestSchema>;
