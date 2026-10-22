import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, useApi } from "../hooks/useApi.js";
import { views } from "virtual:hydra-docs";
import { REPO_URL } from "../pages/docs/build-info.js";
import {
  UNDO_WINDOW_MS,
  createInFlightTracker,
  createUndoWindowRegistry,
  runTracked,
  triggerDisabled,
  undoWindowSeconds,
} from "../lib/delayed-commit.ts";
import { PRECONDITION_GLYPH, anyFailed, resolvePreconditions } from "../lib/preconditions.ts";

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
 *                     cancel window hosted at feed level (UndoWindowContext;
 *                     no undo/inverse route exists in the registry
 *                     vocabulary, so the undo IS the delay).
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
 * renders ✗ inline and persistently. A 200 result object is inspected
 * (issue #4629 INV-9): `ok === false` renders ✗ `<label> refused — <reason>:
 * <detail>` and never a ✓; a body carrying `verified` renders the OBSERVED
 * post-write state; anything else keeps the accepted line.
 *
 * Page controls (issue #4629, ADR-0034 §8.3; design-concept 821e48ed): the
 * /work and /health write controls render through {@link ControlAffordance},
 * which reads the `control:<page>/<name>` registry entry via
 * {@link useOperatorActions} and passes three optional props the feed never
 * sets:
 *   - `verdicts` — the page's `{ [check]: boolean }` table. When present the
 *     affordance renders the LIVE ✓/✗/☐ precondition checklist beside the
 *     button and the consequence under it (the feed renders its own
 *     unchecked list, so it passes none). Whether or not it is present, the
 *     trigger — arm, Confirm and immediate fire alike — is disabled while any
 *     line is ✗ (lib/preconditions.ts; prose lines never disable).
 *   - `context` — the closed `{number, label, paused, engaged}` the body
 *     builders read (a row's issue number, the relabel target, …).
 *   - `testId` — derives `<testId>-arm` / `-confirm-yes` / `-confirm-no`
 *     (confirm-first), `<testId>` (immediate), `<testId>-preconditions`,
 *     `<testId>-consequence` and `<testId>-result`.
 */

/**
 * The closed request-body map for every in-dashboard route the registry can
 * serve (INV-9). Keys are `METHOD /route` with `:param` marking one
 * server-resolved segment — the composer resolves `{number}`-style templates
 * server-side, so the component only ever matches the RESOLVED route and
 * never substitutes placeholders itself. A registry route with no key here
 * renders its affordance disabled with the reason, rather than firing a
 * guessed body. Kept in lockstep with the registry by
 * test/operator-actions-affordance.test.mts.
 *
 * A value is a static body or a builder `(context) => body` over the closed
 * context `{number, label, paused, engaged}` (issue #4629 INV-7) — page
 * controls pass the row/page facts as `context`; the registry itself never
 * carries a body field. With no context the paused builder yields exactly
 * the feed's `{paused: false}`.
 */
const IN_DASHBOARD_BODY = {
  "POST /autopilot/paused": (context) => ({ paused: context.paused ?? false }),
  "POST /scheduler/start": {},
  "POST /design-concepts/:anchor/approve": { by: "operator:dashboard" },
  "POST /autopilot/board/promote": (context) => ({ issue: context.number, confirm: true }),
  "POST /autopilot/board/relabel": (context) => ({ issue: context.number, label: context.label }),
  "POST /autopilot/board/close": (context) => ({ issue: context.number }),
  "POST /autopilot/board/reopen": (context) => ({ issue: context.number }),
  "POST /autopilot/emergency-brake": (context) =>
    context.engaged ? { engaged: true, engagedBy: "health-page" } : { engaged: false },
};

/** Resolve a map value: a builder is called with the (closed) context, a
 * static body is returned as-is. */
function resolveBody(body, context) {
  return typeof body === "function" ? body(context ?? {}) : body;
}

/** Exact key first; then `:param` segment patterns (`:x` matches one
 * non-empty resolved segment). Returns undefined when nothing matches —
 * the caller renders the disabled state. */
function bodyFor(method, route, context) {
  const exact = IN_DASHBOARD_BODY[`${method} ${route}`];
  if (exact !== undefined) return resolveBody(exact, context);
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
    if (matches) return resolveBody(body, context);
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
 * The feed-level undo-window host (QA round 4, PR #4976). Every
 * immediate-tier action AND the feed's typed dismiss arm their ~5 s
 * delayed-commit window (INV-7/INV-14: no undo/inverse route exists in the
 * registry vocabulary, so "immediate, with undo" is a delayed commit — Undo
 * cancels before ANY request is sent; expiry fires it) in ONE registry owned
 * by the host component (lib/delayed-commit.ts `createUndoWindowRegistry`),
 * never in the row that started it:
 *   - concurrent windows each get their own stacked toast + Undo;
 *   - a row unmounting on a poll refresh neither commits early nor loses
 *     Undo — only the HOST unmounting flushes (the operator clicked it and
 *     only Undo may cancel it).
 * `start(id, label, fire)` captures the exact closure that was clicked, so
 * expiry can never fire a stale item/reason after a re-render; a second
 * start on an id already pending is refused (one commit per window).
 *
 * The host ALSO owns the one in-flight tracker (QA round 6): a window drops
 * out of the registry the moment it expires, BEFORE its request settles, so
 * every trigger reads `inFlight.has(windowId)` from the host — never a
 * row-local flag — and `track(windowId, fn)` (lib `runTracked`) marks the id
 * for the request's whole lifetime. Rows sharing a window id, and a row
 * remounted mid-request, therefore stay disabled until the request settles.
 */
export const UndoWindowContext = createContext(null);

export function useUndoWindowHost(delayMs = UNDO_WINDOW_MS) {
  const [windows, setWindows] = useState([]);
  const [inFlight, setInFlight] = useState(() => new Set());
  const registry = useRef(null);
  if (registry.current === null) registry.current = createUndoWindowRegistry(setWindows, delayMs);
  const tracker = useRef(null);
  if (tracker.current === null) {
    const inFlightTracker = createInFlightTracker(setInFlight);
    tracker.current = { track: (id, fn) => runTracked(inFlightTracker, id, fn) };
  }
  useEffect(() => () => registry.current.flushAll(), []);
  return useMemo(
    () => ({
      windows,
      inFlight,
      start: registry.current.start,
      undo: registry.current.undo,
      track: tracker.current.track,
    }),
    [windows, inFlight],
  );
}

/** The one toast host: every pending window stacked bottom-right, each
 * `<label> · Undo` with its OWN Undo — no window can hide another's. */
export function UndoToastStack({ windows, onUndo }) {
  if (windows.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {windows.map((w) => (
        <div
          key={w.id}
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg border border-zinc-600 bg-zinc-900 px-4 py-2.5 text-xs text-zinc-200 shadow-lg"
        >
          <span>{w.label}</span>
          <button type="button" onClick={() => onUndo(w.id)} className="text-violet-300 underline hover:text-violet-200">
            Undo
          </button>
        </div>
      ))}
    </div>
  );
}

/** Tracks whether the component is still mounted, so a window that fires
 * after its row left the feed never sets state on the gone row. */
function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/** Copy-to-clipboard state for the Terminal/ConfigEnv affordances: `copied`
 * for 2 s, or `copyFailed` when the clipboard rejects. The reset timer is
 * cleared on unmount — never a setState on a gone component. */
function useCopy(text) {
  const [state, setState] = useState(null);
  const timer = useRef(null);
  const mounted = useMounted();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setState("copied");
      timer.current = setTimeout(() => setState(null), 2000);
    } catch (err) {
      /* intentional: the visible copy-failed line is the failure surface */
      if (mounted.current) setState("failed");
    }
  }, [text, mounted]);
  return { copy, copied: state === "copied", copyFailed: state === "failed" };
}

// ---------------------------------------------------------------------------
// in-dashboard
// ---------------------------------------------------------------------------

/**
 * The verified result line for one 2xx response (issue #4629 INV-9). The
 * board routes answer 200 with a result object: `ok === false` is a refusal
 * — rendered ✗ with its reason/detail, NEVER a ✓; a `verified` body renders
 * the observed post-write state; any other 2xx keeps the accepted line.
 * `reread === false` means the caller's re-read failed — the ✓ never claims
 * a re-read it did not get. The lifted object carries the response's
 * reason/detail/verified/issue so a page can keep its own result panel.
 */
function resultFromResponse(action, res, reread, context) {
  const base = {
    label: action.label,
    issue: res?.issue ?? context?.number,
    reason: res?.reason,
    detail: res?.detail,
    verified: res?.verified,
  };
  const stale = reread === false ? " · feed re-read FAILED — list may be stale" : "";
  if (res?.ok === false) {
    return {
      ...base,
      ok: false,
      text: `✗ ${action.label} refused — ${res.reason ?? "refused"}${res.detail ? `: ${res.detail}` : ""}`,
    };
  }
  if (res?.verified) {
    const labels = Array.isArray(res.verified.labels) ? res.verified.labels.join(", ") : "";
    return {
      ...base,
      ok: true,
      text: `✓ ${action.label} verified — state ${res.verified.state}, labels: ${labels || "none"}${stale}`,
    };
  }
  return reread === false
    ? {
        ...base,
        ok: true,
        text: `✓ ${action.method} ${action.route} accepted · feed re-read FAILED — list may be stale`,
      }
    : {
        ...base,
        ok: true,
        text: `✓ ${action.method} ${action.route} accepted · feed re-read`,
      };
}

function InDashboardAffordance({ action, onFired, onResult, verdicts, context, testId }) {
  const body = bodyFor(action.method, action.route, context);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const undoHost = useContext(UndoWindowContext);
  const mounted = useMounted();
  // One window per (route, row): page controls repeat a route per row, so the
  // row's issue number joins the id — two rows never share a window or an
  // in-flight flag. The feed passes no context, so its ids are unchanged.
  const windowId = `action:${action.method} ${action.route}${
    context?.number !== undefined && context?.number !== null ? `#${context.number}` : ""
  }`;
  // The live checklist (issue #4629 INV-4): prose ☐ never disables; a
  // {check} line is ✓ only on a literal-true verdict, ✗ otherwise (a missing
  // verdict fails closed). Any ✗ disables every trigger below.
  const lines = resolvePreconditions(action.preconditions, verdicts);
  const blocked = anyFailed(lines);
  const tid = (suffix) => (testId ? `${testId}${suffix}` : undefined);

  // Safe to run after this row has unmounted (the window lives at feed
  // level): the verified result is lifted through onResult, and row-local
  // state is only touched while the row is still mounted. With a host, the
  // request runs through the host's shared in-flight tracker under this
  // window id (QA round 6), so EVERY row bound to the id — siblings and
  // remounts alike — stays disabled until it settles.
  const fireRequest = useCallback(async () => {
    if (mounted.current) setBusy(true);
    try {
      // The route is fired exactly as served — templates were resolved
      // server-side by the composer; the body comes from the closed map,
      // built from the context captured with this exact closure.
      const res = await apiFetch(action.route, {
        method: action.method,
        body: JSON.stringify(bodyFor(action.method, action.route, context)),
      });
      // SERVER-CONFIRMED (ADR-0034 §7): the ✗/✓ line renders only after the
      // request AND the caller's feed refresh both settle.
      // onFired resolves `false` when the feed re-read FAILED — then the ✓
      // must not claim a re-read it never got.
      const reread = await onFired?.();
      const next = resultFromResponse(action, res, reread, context);
      if (mounted.current) setResult(next);
      onResult?.(next);
    } catch (err) {
      /* intentional: the persistent ✗ line below is the failure surface —
         surfaced inline, never a silent catch */
      const message = err?.message ?? String(err);
      const next = {
        ok: false,
        text: `✗ ${message}`,
        label: action.label,
        issue: context?.number,
        reason: "request-failed",
        detail: message,
      };
      if (mounted.current) setResult(next);
      onResult?.(next);
    } finally {
      if (mounted.current) {
        setBusy(false);
        setArmed(false);
      }
    }
  }, [action, context, onFired, onResult, mounted]);
  const track = undoHost?.track;
  const fire = useCallback(
    () => (track ? track(windowId, fireRequest) : fireRequest()),
    [track, windowId, fireRequest],
  );
  const inFlight = undoHost !== null && undoHost.inFlight.has(windowId);

  // No defined body for this route — or an immediate-tier action rendered
  // outside an undo-window host: disabled + the reason — never a guess, and
  // never an immediate fire without its Undo.
  const noHost = action.confirmTier !== "confirm-first" && undoHost === null;
  if (body === undefined || noHost) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          data-testid={tid("-disabled")}
          className="cursor-not-allowed rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 opacity-40"
        >
          {action.label}
        </button>
        <span className="text-[11px] text-zinc-500">
          {body === undefined
            ? `no request body defined for ${action.method} ${action.route}`
            : "no undo-window host — render inside UndoWindowContext"}
        </span>
      </span>
    );
  }

  const controls = (
    <span className="inline-flex flex-wrap items-center gap-2">
      {action.confirmTier === "confirm-first" ? (
        armed ? (
          <>
            <button
              type="button"
              data-testid={tid("-confirm-yes")}
              onClick={fire}
              disabled={busy || inFlight || blocked}
              className="rounded border border-emerald-500/60 px-2.5 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
            >
              {busy ? "…" : `Confirm ${action.label}?`}
            </button>
            <button
              type="button"
              data-testid={tid("-confirm-no")}
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
            data-testid={tid("-arm")}
            onClick={() => setArmed(true)}
            disabled={inFlight || blocked}
            className="rounded border border-emerald-500/45 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
          >
            {inFlight ? "…" : `${action.label}…`}
          </button>
        )
      ) : (
        <button
          type="button"
          data-testid={tid("")}
          onClick={() => undoHost.start(windowId, `Firing ${action.label} in ${undoWindowSeconds(UNDO_WINDOW_MS)}`, fire)}
          disabled={blocked || triggerDisabled(undoHost.inFlight.has(windowId), undoHost.windows, windowId)}
          className="rounded border border-emerald-500/45 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
        >
          {inFlight ? "…" : action.label}
        </button>
      )}
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
        {action.confirmTier === "confirm-first" ? "confirms first" : "immediate · undo"}
      </span>
      {result && (
        <span
          data-testid={tid("-result")}
          className={`break-all font-mono text-[11px] ${result.ok ? "text-emerald-300" : "text-red-300"}`}
        >
          {result.text}
        </span>
      )}
    </span>
  );

  // The feed renders its own unchecked precondition list + consequence, so
  // only a page control (verdicts supplied) gets the live checklist here.
  if (verdicts === undefined) return controls;

  return (
    <span className="inline-flex flex-col gap-1">
      {controls}
      {lines.length > 0 && (
        <ul data-testid={tid("-preconditions")} className="space-y-0.5 text-[11px]">
          {lines.map((line) => (
            <li
              key={line.text}
              data-state={line.state}
              className={
                line.state === "ok"
                  ? "text-emerald-300"
                  : line.state === "fail"
                    ? "text-rose-300"
                    : "text-zinc-500"
              }
            >
              {PRECONDITION_GLYPH[line.state]} {line.text}
            </li>
          ))}
        </ul>
      )}
      <span data-testid={tid("-consequence")} className="text-[11px] text-zinc-400">
        → {action.consequence}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// terminal-skill
// ---------------------------------------------------------------------------

function TerminalSkillAffordance({ action }) {
  const { copy, copied, copyFailed } = useCopy(action.command);

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
  const { copy, copied, copyFailed } = useCopy(action.file);

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

export function ActionAffordance({ action, doc, onFired, onResult, verdicts, context, testId }) {
  switch (action.kind) {
    case "in-dashboard":
      return (
        <InDashboardAffordance
          action={action}
          onFired={onFired}
          onResult={onResult}
          verdicts={verdicts}
          context={context}
          testId={testId}
        />
      );
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

// ---------------------------------------------------------------------------
// page controls — the registry read + the control:<page>/<name> wrapper
// (issue #4629, design-concept 821e48ed INV-1/INV-10)
// ---------------------------------------------------------------------------

/** The literal a page control renders, disabled, while the registry read is
 * loading or failed, or when its key has no entry — never a fallback label. */
const REGISTRY_UNAVAILABLE = "operator-action registry unavailable";

/**
 * The one registry read a page makes: GET /operator-actions, once, no poll
 * (the registry is a checked-in constant — it changes only on deploy),
 * indexed by key over the DEFAULT entries (no variant). `ready` is false
 * while loading, on a failed read, or on a payload without an entries list.
 */
export function useOperatorActions() {
  const { data, error, loading } = useApi("/operator-actions");
  return useMemo(() => {
    if (loading || error || !Array.isArray(data?.entries)) {
      return { ready: false, byKey: new Map() };
    }
    const byKey = new Map();
    for (const entry of data.entries) {
      if (entry?.variant === undefined && typeof entry?.key === "string") byKey.set(entry.key, entry);
    }
    return { ready: true, byKey };
  }, [data, error, loading]);
}

/**
 * One page control: the `controlKey` registry entry's RECOMMENDED action,
 * rendered through ActionAffordance with the page's live `verdicts`, the
 * body `context` and a `testId`. A registry that is not ready — or a key it
 * does not carry — renders the control DISABLED with
 * {@link REGISTRY_UNAVAILABLE} (fail loud): the page never hand-rolls a
 * label, precondition or consequence of its own.
 */
export function ControlAffordance({ registry, controlKey, verdicts, context, testId, onFired, onResult }) {
  const entry = registry.ready ? registry.byKey.get(controlKey) : undefined;
  if (entry === undefined) {
    return (
      <button
        type="button"
        disabled
        data-testid={testId ? `${testId}-unavailable` : undefined}
        title={controlKey}
        className="cursor-not-allowed rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-500 opacity-60"
      >
        {REGISTRY_UNAVAILABLE}
      </button>
    );
  }
  return (
    <ActionAffordance
      action={entry.recommended}
      doc={entry.doc}
      verdicts={verdicts ?? {}}
      context={context}
      testId={testId}
      onFired={onFired}
      onResult={onResult}
    />
  );
}
