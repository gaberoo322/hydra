import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../hooks/useApi.js";
import { views } from "virtual:hydra-docs";
import { REPO_URL } from "../pages/docs/build-info.js";

/**
 * ActionAffordance — ONE component, keyed by the registry Action's `kind`
 * (issue #4628, ADR-0034 §8.3; design-concept ff6f2e7a). The feed (and later
 * the /work controls) never hand-rolls a button per action again: the body is
 * a single `switch (action.kind)` with one literal case per ActionKind, so
 * assertion (c) (test/operator-actions-affordance.test.mts) can prove every
 * schema kind renders — a kind added to the schema without a case reddens
 * there, and the `default:` arm renders a visible unknown-kind marker rather
 * than a silent blank (fail loud).
 *
 * Per kind:
 *   - in-dashboard    fires the write route through the module's own
 *                     apiFetch, body from the closed IN_DASHBOARD_BODY map
 *                     (a route with no entry renders DISABLED with the
 *                     reason — never a guessed body). confirmTier picks the
 *                     interaction: `confirm-first` arms then confirms;
 *                     `immediate-undo` fires through a ~5 s client-side
 *                     cancel window (no undo/inverse route exists in the
 *                     registry vocabulary, so the undo IS the delay).
 *   - terminal-skill  the resolved command, mono, + Copy
 *                     (navigator.clipboard; a rejected clipboard says so).
 *                     Nothing executes from the browser (ADR-0012).
 *   - config-env      project · file, mono, + Copy (the path) + View file.
 *                     The dashboard never writes tracked config (§9.1).
 *   - credential / research-beyond-autonomy / vision-decision — the three
 *     ADR-0005 closed-escalation kinds: a kind-labelled instruction + the
 *     entry's doc link. NO button, NO control — these are operator-only by
 *     definition.
 *
 * Verified result (ADR-0034 §7, INV-10): after firing, the component awaits
 * BOTH the request and the caller's `onFired()` (feed refresh) before
 * rendering anything, and then renders only what was verified — the accepted
 * route line, never the consequence prose as an accomplished fact. Failure
 * renders ✗ inline and persistently.
 */

/** The undo window for immediate-tier actions (and the feed's dismiss). */
const UNDO_WINDOW_MS = 5000;

/**
 * The closed request-body map for every in-dashboard route the registry can
 * serve (INV-9). Keys are `METHOD /route` with `:param` marking one
 * server-resolved segment — the composer resolves `{number}`-style templates
 * server-side, so the component only ever matches the RESOLVED route and
 * never substitutes placeholders itself. A registry route with no key here
 * renders its affordance disabled with the reason, rather than firing a
 * guessed body. Kept in lockstep with the registry by
 * test/operator-actions-affordance.test.mts.
 */
const IN_DASHBOARD_BODY = {
  "POST /autopilot/paused": { paused: false },
  "POST /scheduler/start": {},
  "POST /design-concepts/:anchor/approve": { by: "operator:dashboard" },
};

/** Exact key first; then `:param` segment patterns (`:x` matches one
 * non-empty resolved segment). Returns undefined when nothing matches —
 * the caller renders the disabled state. */
function bodyFor(method, route) {
  const exact = IN_DASHBOARD_BODY[`${method} ${route}`];
  if (exact !== undefined) return exact;
  const segments = route.split("/");
  for (const [key, body] of Object.entries(IN_DASHBOARD_BODY)) {
    const space = key.indexOf(" ");
    if (key.slice(0, space) !== method) continue;
    const pattern = key.slice(space + 1);
    const patternSegments = pattern.split("/");
    if (patternSegments.length !== segments.length) continue;
    const matches = patternSegments.every(
      (p, i) => (p.startsWith(":") ? segments[i]?.length > 0 : p === segments[i]),
    );
    if (matches) return body;
  }
  return undefined;
}

/**
 * docs/ path → in-app /docs route, from the build-time docs manifest — the
 * same `virtual:hydra-docs` views the /docs shell renders from, so the link
 * can never drift from the built tree. A docs/ path with no built view (or a
 * non-path doc reference like "ADR-0005") returns undefined and renders as
 * plain text.
 */
const DOC_HREF = new Map(
  views.flatMap((v) => v.sources.map((s) => [s.path, v.key ? `/docs/${v.key}` : "/docs"])),
);

function docHref(doc) {
  return typeof doc === "string" && doc.startsWith("docs/") ? DOC_HREF.get(doc) : undefined;
}

/**
 * useDelayedCommit — the ~5 s cancel window behind every immediate-tier
 * action AND the feed's typed dismiss (INV-7/INV-14: no undo/inverse route
 * exists in the registry vocabulary, so "immediate, with undo" is a delayed
 * commit — Undo cancels before ANY request is sent; expiry fires it).
 *
 * `start(label, fire)` captures the exact closure that was clicked, so the
 * timer can never fire a stale item/reason after a re-render. Exported for
 * AttentionFeed's dismiss, which shares the window but not the renderer.
 */
export function useDelayedCommit(delayMs = UNDO_WINDOW_MS) {
  const [pending, setPending] = useState(null);
  const timer = useRef(null);
  // The fire closure of the commit currently inside its window — kept so a
  // replacement or an unmount can FLUSH it instead of silently dropping an
  // operator action the toast promised (fail loud: never a lost commit).
  const firePending = useRef(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const fire = firePending.current;
    firePending.current = null;
    if (fire) fire();
  }, []);

  const start = useCallback(
    (label, fire) => {
      // A second click inside the window commits the first immediately —
      // only Undo cancels.
      flush();
      setPending({ label });
      firePending.current = fire;
      timer.current = setTimeout(() => {
        timer.current = null;
        firePending.current = null;
        setPending(null);
        fire();
      }, delayMs);
    },
    [delayMs, flush],
  );

  const undo = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    firePending.current = null;
    setPending(null);
  }, []);

  // A pending window never silently outlives its component (a feed row
  // unmounts on refresh/poll or navigation): the unmount COMMITS the pending
  // action — the operator clicked it and only Undo may cancel it.
  useEffect(() => flush, [flush]);

  return { pending, start, undo };
}

/** The one toast shape: `<label> in 5s · Undo`. Rendered by whoever owns the
 * window (an affordance instance or the feed's dismiss row). */
export function DelayedCommitToast({ pending, onUndo }) {
  if (!pending) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2.5 text-xs text-zinc-200 shadow-lg"
    >
      <span>{pending.label}</span>
      <button type="button" onClick={onUndo} className="text-violet-300 underline hover:text-violet-200">
        Undo
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// in-dashboard
// ---------------------------------------------------------------------------

function InDashboardAffordance({ action, onFired, onResult }) {
  const body = bodyFor(action.method, action.route);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const undoWindow = useDelayedCommit();

  const fire = useCallback(async () => {
    setBusy(true);
    try {
      // The route is fired exactly as served — templates were resolved
      // server-side by the composer; the body comes from the closed map.
      await apiFetch(action.route, {
        method: action.method,
        body: JSON.stringify(bodyFor(action.method, action.route)),
      });
      // SERVER-CONFIRMED (ADR-0034 §7): the ✗/✓ line renders only after the
      // request AND the caller's feed refresh both settle.
      // onFired resolves `false` when the feed re-read FAILED — then the ✓
      // must not claim a re-read it never got.
      const reread = await onFired?.();
      const next =
        reread === false
          ? {
              ok: true,
              text: `✓ ${action.method} ${action.route} accepted · feed re-read FAILED — list may be stale`,
            }
          : {
              ok: true,
              text: `✓ ${action.method} ${action.route} accepted · feed re-read`,
            };
      setResult(next);
      onResult?.(next);
    } catch (err) {
      /* intentional: the persistent ✗ line below is the failure surface —
         surfaced inline, never a silent catch */
      const next = { ok: false, text: `✗ ${err?.message ?? String(err)}` };
      setResult(next);
      onResult?.(next);
    } finally {
      setBusy(false);
      setArmed(false);
    }
  }, [action.method, action.route, onFired, onResult]);

  // No defined body for this route: disabled + the reason — never a guess.
  if (body === undefined) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 opacity-40"
        >
          {action.label}
        </button>
        <span className="text-[11px] text-zinc-500">
          no request body defined for {action.method} {action.route}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {action.confirmTier === "confirm-first" ? (
        armed ? (
          <>
            <button
              type="button"
              onClick={fire}
              disabled={busy}
              className="rounded border border-emerald-500/60 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              {busy ? "…" : `Confirm ${action.label}?`}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="rounded border border-zinc-600 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-100"
            >
              Cancel
            </button>
            {/* The consequence is restated at the moment of commitment. */}
            <span className="text-[11px] text-zinc-500">{action.consequence}</span>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setArmed(true)}
            className="rounded border border-emerald-500/45 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10"
          >
            {action.label}…
          </button>
        )
      ) : (
        <button
          type="button"
          onClick={() => undoWindow.start(`Firing ${action.label} in 5s`, fire)}
          disabled={busy || Boolean(undoWindow.pending)}
          className="rounded border border-emerald-500/45 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {busy ? "…" : action.label}
        </button>
      )}
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
        {action.confirmTier === "confirm-first" ? "confirms first" : "immediate · undo"}
      </span>
      {result && (
        <span
          className={`break-all font-mono text-[11px] ${result.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {result.text}
        </span>
      )}
      <DelayedCommitToast pending={undoWindow.pending} onUndo={undoWindow.undo} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// terminal-skill
// ---------------------------------------------------------------------------

function TerminalSkillAffordance({ action }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(action.command);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      /* intentional: the visible copy-failed line is the failure surface */
      setCopied(false);
      setCopyFailed(true);
    }
  }, [action.command]);

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <code className="overflow-x-auto whitespace-nowrap rounded border border-zinc-700 bg-zinc-950/60 px-2 py-0.5 font-mono text-xs text-zinc-300">
        {action.command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="rounded border border-sky-500/40 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-500/10"
      >
        Copy
      </button>
      {copied && <span className="text-[11px] text-emerald-300">copied</span>}
      {copyFailed && <span className="text-[11px] text-red-300">copy failed — select the text</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// config-env
// ---------------------------------------------------------------------------

function ConfigEnvAffordance({ action }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(action.file);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      /* intentional: the visible copy-failed line is the failure surface */
      setCopied(false);
      setCopyFailed(true);
    }
  }, [action.file]);

  // View file links to the GitHub blob on master ONLY for a repo-relative
  // path; a home-dir/absolute path is a local file the repo does not carry.
  // The schema has no line field — none is rendered or invented (§9.1: the
  // dashboard never writes the file either).
  const repoRelative =
    !action.file.startsWith("/") && !action.file.startsWith("~");

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-zinc-400">
        {action.project} · <span className="text-zinc-300">{action.file}</span>
      </span>
      <button
        type="button"
        onClick={copy}
        className="rounded border border-sky-500/40 px-2 py-0.5 text-xs text-sky-300 hover:bg-sky-500/10"
      >
        Copy
      </button>
      {repoRelative ? (
        <a
          href={`${REPO_URL}/blob/master/${action.file}`}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-300 hover:border-zinc-400 hover:text-zinc-100"
        >
          View file ↗
        </a>
      ) : (
        <span className="text-[11px] text-zinc-500">outside the repo — open locally</span>
      )}
      {copied && <span className="text-[11px] text-emerald-300">copied</span>}
      {copyFailed && <span className="text-[11px] text-red-300">copy failed — select the text</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// the three ADR-0005 closed-escalation kinds — instruction + doc link, no control
// ---------------------------------------------------------------------------

const ESCALATION_KIND_LABEL = {
  credential: "credential",
  "research-beyond-autonomy": "research beyond autonomy",
  "vision-decision": "vision decision",
};

function EscalationAffordance({ action, doc }) {
  const href = docHref(doc);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="rounded border border-rose-400/35 bg-rose-400/10 px-1.5 py-0.5 text-[11px] text-rose-300">
        {ESCALATION_KIND_LABEL[action.kind] ?? action.kind}
      </span>
      <span className="text-xs text-zinc-200">{action.label}</span>
      <span className="text-[11px] text-zinc-500">→ {action.consequence}</span>
      {href ? (
        <a href={href} className="text-[11px] text-zinc-400 underline hover:text-violet-300">
          {doc}
        </a>
      ) : (
        <span className="text-[11px] text-zinc-500">{doc}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// the one export the feed renders — assertion (c)'s subject
// ---------------------------------------------------------------------------

export function ActionAffordance({ action, doc, onFired, onResult }) {
  switch (action.kind) {
    case "in-dashboard":
      return <InDashboardAffordance action={action} onFired={onFired} onResult={onResult} />;
    case "terminal-skill":
      return <TerminalSkillAffordance action={action} />;
    case "config-env":
      return <ConfigEnvAffordance action={action} />;
    case "credential":
    case "research-beyond-autonomy":
    case "vision-decision":
      return <EscalationAffordance action={action} doc={doc} />;
    default:
      // Fail loud: an unknown kind renders a visible marker, never a blank.
      return (
        <span className="font-mono text-xs text-red-400">
          unknown action kind {String(action?.kind)}
        </span>
      );
  }
}
