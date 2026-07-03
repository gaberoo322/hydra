import { useMemo, useState } from "react";
import controlPlane from "../data/control-plane.json";
import "./OrchestratorMap.css";

/**
 * OrchestratorMap — a drift-free reference-architecture screen for the
 * Orchestrator control plane (epic #2607, this component = #2609).
 *
 * The whole map is derived from `src/data/control-plane.json`, which is
 * GENERATED at build time from repo source (classes.json, the autopilot
 * playbook, triage-labels.md) by `dashboard/scripts/parse-control-plane.mjs`.
 * There are deliberately NO hardcoded class / label / skill lists in this
 * file — that is the whole point of the census (it cannot silently drift the
 * way the skills mirror did in PR #2551). If you find yourself typing a class
 * or label name here, stop: it belongs in the census, not the renderer.
 *
 * Shape: a single left→right lifecycle SPINE (the issue label lifecycle,
 * derived from the census `edges`), with three independently-toggleable
 * overlay LAYERS hanging off it:
 *   - classes+cooldowns  (the autopilot dispatch taxonomy)
 *   - labels             (every label's meaning + who applies it)
 *   - skill edges        (which skill each class invokes)
 * plus an off-by-default "other pieces" annotation layer for the pieces that
 * don't sit on the spine (Redis state, event bus, OpenViking, tiers /
 * Verifier-Core, holdback, CI gate).
 *
 * Rendered as hand-rolled SVG + CSS — no new dashboard dependency (ADR-0005 /
 * allow-scripts posture). Every node deep-links to its authoritative source
 * via a GitHub blob URL built from the census `sourcePath`.
 *
 * NOTE: wiring this into the Explore page is issue #2610 (out of scope here);
 * this file only exports the self-contained component.
 */

const BLOB_BASE = "https://github.com/gaberoo322/hydra/blob/master/";

/** Build a GitHub blob deep-link from a repo-relative census sourcePath. */
function blobUrl(sourcePath) {
  if (!sourcePath) return null;
  return BLOB_BASE + String(sourcePath).replace(/^\/+/, "");
}

/** Human-readable cooldown, e.g. 900 -> "15m", 604800 -> "7d", 0 -> "0". */
function formatCooldown(seconds) {
  if (seconds == null) return "pipeline"; // pipeline slots have no cooldown
  if (seconds === 0) return "0";
  const units = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  for (const [suffix, size] of units) {
    if (seconds % size === 0 && seconds >= size) return `${seconds / size}${suffix}`;
  }
  return `${seconds}s`;
}

/**
 * Order the spine from the census edges: start at the label that is never a
 * `to` target on the main path (the entry), then walk the primary chain. We
 * treat the linear backbone as the sequence of labels reachable by following
 * the first outgoing edge from each node until we hit a terminal (`close`).
 * Branch targets (blocked / needs-info / ready-for-human) fall off the spine
 * and are surfaced by the labels layer, not the backbone.
 */
function deriveSpine(labels, edges) {
  const labelNames = new Set(labels.map((l) => l.name));
  const froms = new Set(edges.map((e) => e.from));
  const tos = new Set(edges.map((e) => e.to));

  // Spine entry = a `from` that is never a `to` (has no inbound edge).
  const entries = [...froms].filter((f) => !tos.has(f));
  const start = entries[0] ?? edges[0]?.from;
  if (!start) return [];

  // Adjacency: primary next-hop per node (first edge wins for the backbone).
  const nextHop = new Map();
  for (const e of edges) {
    if (!nextHop.has(e.from)) nextHop.set(e.from, e.to);
  }

  const spine = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur)) {
    spine.push(cur);
    seen.add(cur);
    cur = nextHop.get(cur);
  }
  // The terminal node (e.g. `close`) may not be a declared label; that's fine
  // — it is still a real lifecycle step, so keep it on the spine.
  return spine.map((name) => ({
    name,
    label: labels.find((l) => l.name === name) ?? null,
    inLabels: labelNames.has(name),
  }));
}

/**
 * Non-spine branch edges (e.g. ready-for-agent -> blocked). Surfaced as short
 * stubs beneath the spine node they branch from.
 */
function deriveBranches(spine, edges) {
  const onSpine = new Set(spine.map((s) => s.name));
  // The set of edges the backbone already consumed (first-hop per from).
  const backbone = new Set();
  const firstFrom = new Set();
  for (const e of edges) {
    if (!firstFrom.has(e.from)) {
      firstFrom.add(e.from);
      backbone.add(`${e.from}->${e.to}`);
    }
  }
  return edges
    .filter((e) => !backbone.has(`${e.from}->${e.to}`))
    .filter((e) => onSpine.has(e.from));
}

/**
 * The off-by-default "other pieces" — the control-plane parts that don't sit
 * on the issue lifecycle spine. These are architectural annotations, not
 * census rows, so they carry their own authoritative sourcePath. Kept short
 * and deep-linkable (a navigable index, not a poster).
 */
const OTHER_PIECES = [
  { name: "Redis state", sourcePath: "src/redis/", note: "typed accessors; state lives here" },
  { name: "Event bus", sourcePath: "src/scheduler/heartbeat.ts", note: "hydra:* streams" },
  { name: "OpenViking", sourcePath: "docs/reference.md", note: "semantic knowledge plane" },
  { name: "Tiers / Verifier-Core", sourcePath: "src/untouchable.ts", note: "T1→T4 blast radius" },
  { name: "Outcome Holdback", sourcePath: "src/anchor-selection/", note: "T2 post-merge gate" },
  { name: "CI merge gate", sourcePath: ".github/workflows/ci.yml", note: "the merge gate" },
];

const LAYERS = [
  { id: "classes", label: "Classes + cooldowns", defaultOn: true },
  { id: "labels", label: "Label states", defaultOn: true },
  { id: "skills", label: "Skill ⇄ class edges", defaultOn: true },
  { id: "other", label: "Other pieces", defaultOn: false },
];

/** A clickable node that opens its authoritative source in a new tab. */
function SourceLink({ sourcePath, className, title, children }) {
  const url = blobUrl(sourcePath);
  if (!url) return <span className={className}>{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title ?? `Open ${sourcePath} on GitHub`}
    >
      {children}
    </a>
  );
}

export function OrchestratorMap() {
  // The census is a static build-time import, so these arrays are stable
  // for the lifetime of the module — read them once and memoize the derived
  // views off them.
  const classes = useMemo(() => controlPlane.classes ?? [], []);
  const labels = useMemo(() => controlPlane.labels ?? [], []);
  const edges = useMemo(() => controlPlane.edges ?? [], []);
  const skillEdges = useMemo(() => controlPlane.skillEdges ?? [], []);

  const spine = useMemo(() => deriveSpine(labels, edges), [labels, edges]);
  const branches = useMemo(() => deriveBranches(spine, edges), [spine, edges]);

  const [active, setActive] = useState(() => {
    const init = {};
    for (const l of LAYERS) init[l.id] = l.defaultOn;
    return init;
  });
  const toggle = (id) => setActive((a) => ({ ...a, [id]: !a[id] }));

  // Skill edges keyed by class name for the classes layer.
  const skillByClass = useMemo(() => {
    const m = new Map();
    for (const e of skillEdges) m.set(e.class, e);
    return m;
  }, [skillEdges]);

  const pipelineClasses = classes.filter((c) => c.kind === "pipeline");
  const signalClasses = classes.filter((c) => c.kind === "signal");

  return (
    <div className="omap" data-testid="orchestrator-map">
      <div className="omap-toolbar" role="group" aria-label="Map layers">
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={"omap-toggle" + (active[l.id] ? " is-on" : "")}
            aria-pressed={active[l.id]}
            onClick={() => toggle(l.id)}
          >
            <span className="omap-toggle-dot" aria-hidden="true" />
            {l.label}
          </button>
        ))}
      </div>

      {/* Lifecycle spine — always visible; it is the backbone of the map.
          The connecting rail + arrowheads are hand-rolled SVG drawn behind
          the clickable node boxes. */}
      <section className="omap-spine-wrap" aria-label="Issue lifecycle spine">
        <div className="omap-section-title">Lifecycle spine</div>
        <div className="omap-spine">
          <svg
            className="omap-spine-rail"
            aria-hidden="true"
            preserveAspectRatio="none"
            viewBox="0 0 100 10"
          >
            <defs>
              <marker
                id="omap-arrow"
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6 Z" className="omap-arrow-head" />
              </marker>
            </defs>
            <line
              x1="1"
              y1="5"
              x2="99"
              y2="5"
              className="omap-rail-line"
              markerEnd="url(#omap-arrow)"
            />
          </svg>
          <div className="omap-spine-nodes">
            {spine.map((node) => (
              <div className="omap-spine-node-wrap" key={node.name}>
                <SourceLink
                  sourcePath={
                    node.label?.sourcePath ?? "docs/agents/triage-labels.md"
                  }
                  className="omap-node omap-spine-node"
                  title={node.label?.meaning ?? node.name}
                >
                  <span className="omap-node-name">{node.name}</span>
                  {active.labels && node.label && (
                    <span className="omap-node-sub">{node.label.meaning}</span>
                  )}
                </SourceLink>
                {/* Branch stubs (blocked / needs-info / ready-for-human). */}
                {active.labels &&
                  branches
                    .filter((b) => b.from === node.name)
                    .map((b) => (
                      <SourceLink
                        key={b.from + "->" + b.to}
                        sourcePath={b.sourcePath}
                        className="omap-branch"
                        title={`${b.from} → ${b.to}`}
                      >
                        ↳ {b.to}
                      </SourceLink>
                    ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Classes + cooldowns overlay. */}
      {active.classes && (
        <section className="omap-layer" aria-label="Dispatch classes">
          <div className="omap-section-title">
            Dispatch classes{" "}
            <span className="omap-muted">
              ({pipelineClasses.length} pipeline · {signalClasses.length} signal)
            </span>
          </div>
          <div className="omap-class-grid">
            {classes.map((c) => (
              <SourceLink
                key={c.name}
                sourcePath={c.sourcePath}
                className={"omap-node omap-class omap-kind-" + c.kind}
                title={`${c.kind} · scope ${c.scope} · model ${c.model}`}
              >
                <span className="omap-node-name">{c.name}</span>
                <span className="omap-chips">
                  <span className={"omap-chip omap-scope-" + c.scope}>{c.scope}</span>
                  <span className="omap-chip omap-model">{c.model}</span>
                  <span className="omap-chip omap-cooldown">
                    {formatCooldown(c.cooldownSeconds)}
                  </span>
                </span>
                {active.skills && skillByClass.has(c.name) && (
                  <span className="omap-skill-edge">⇄ {skillByClass.get(c.name).skill}</span>
                )}
              </SourceLink>
            ))}
          </div>
        </section>
      )}

      {/* Skill ⇄ class edges as a standalone layer (also inlined above). */}
      {active.skills && (
        <section className="omap-layer" aria-label="Skill to class edges">
          <div className="omap-section-title">
            Skill ⇄ class edges <span className="omap-muted">({skillEdges.length})</span>
          </div>
          <div className="omap-skill-grid">
            {skillEdges.map((e) => (
              <SourceLink
                key={e.class}
                sourcePath={e.sourcePath}
                className="omap-node omap-skill-node"
                title={`${e.class} invokes ${e.skill}`}
              >
                <span className="omap-node-name">{e.skill}</span>
                <span className="omap-node-sub">{e.class}</span>
              </SourceLink>
            ))}
          </div>
        </section>
      )}

      {/* Off-by-default "other pieces" annotations. */}
      {active.other && (
        <section className="omap-layer" aria-label="Other control-plane pieces">
          <div className="omap-section-title">Other pieces</div>
          <div className="omap-other-grid">
            {OTHER_PIECES.map((p) => (
              <SourceLink
                key={p.name}
                sourcePath={p.sourcePath}
                className="omap-node omap-other-node"
                title={p.note}
              >
                <span className="omap-node-name">{p.name}</span>
                <span className="omap-node-sub">{p.note}</span>
              </SourceLink>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
