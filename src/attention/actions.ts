/**
 * Operator-action resolution (ADR-0034 §8.2): registry lookup plus server-side
 * `{repo}` / `{number}` / `{kind}` template substitution. Extracted from
 * src/attention.ts (issue #5615); re-exported there.
 */

import { REGISTRY } from "../operator-actions/registry.ts";
import type { Action, OperatorActionEntry, Variant } from "../schemas/operator-actions.ts";

/** Per-item template context (ADR-0034 §8.2 BUCKET_CONTEXT). */
export type ActionContext = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

function substitute(template: string, context: ActionContext): string {
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(context, name) ? String(context[name]) : match,
  );
}

function resolveTemplates(action: Action, context: ActionContext): Action {
  if (action.kind === "terminal-skill") {
    return { ...action, command: substitute(action.command, context) };
  }
  if (action.kind === "in-dashboard") {
    return { ...action, route: substitute(action.route, context) };
  }
  return { ...action };
}

function hasPlaceholder(action: Action): boolean {
  const field =
    action.kind === "terminal-skill"
      ? action.command
      : action.kind === "in-dashboard"
        ? action.route
        : "";
  return /\{[a-zA-Z0-9_]+\}/.test(field);
}

/**
 * Resolve the registry entry for `(key, variant)` — falling back to the
 * default (variant-less) entry — with `{repo}` / `{number}` / `{kind}`
 * substituted in `recommended` and both `alternatives` (ADR-0034 §8.2).
 * Returns null when no entry exists or a placeholder stays unresolved.
 */
export function resolveAction(
  key: string,
  variant: Variant | undefined,
  context: ActionContext,
  registry: readonly OperatorActionEntry[] = REGISTRY,
): OperatorActionEntry | null {
  const entry =
    (variant !== undefined
      ? registry.find((e) => e.key === key && e.variant === variant)
      : undefined) ?? registry.find((e) => e.key === key && e.variant === undefined);
  if (!entry) return null;
  const recommended = resolveTemplates(entry.recommended, context);
  const alternatives: [Action, Action] = [
    resolveTemplates(entry.alternatives[0], context),
    resolveTemplates(entry.alternatives[1], context),
  ];
  if ([recommended, alternatives[0], alternatives[1]].some(hasPlaceholder)) return null;
  return { ...entry, recommended, alternatives };
}
