/**
 * BattleCard — single Pokemon-style battle card for one in-flight subagent.
 *
 * Slice D of /now-observability (epic #667, issue #672). Replaces the
 * one-sprite-per-row strip with a 220x150-ish card per dispatch: sprite +
 * class label + HP/EXP (HP/EXP wiring tracks slice 6's stat derivation —
 * the values are passed in from BattleCardRow so this component stays a
 * pure presenter), current-activity line, three tool-call counters,
 * pulsing yellow dot when a permission-wait is open, and a PR link once
 * one is available.
 *
 * All logic lives in battle-card-state.ts; this file is a pure binder.
 */

export const CARD_WIDTH = 220;
const CARD_HEIGHT = 150;

const SPRITE_PREFIX = "/sprites/pokemon/";

function CounterPill({ icon, count, label }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-mono text-zinc-300"
      title={label}
      data-testid={`counter-${label}`}
    >
      <span aria-hidden>{icon}</span>
      <span>{count}</span>
    </span>
  );
}

function PermissionWaitDot() {
  return (
    <span
      className="inline-block rounded-full"
      data-testid="permission-wait-dot"
      style={{
        width: 8,
        height: 8,
        background: "#facc15", // amber-400
        animation: "battlecard-pulse 1.2s ease-in-out infinite",
        boxShadow: "0 0 6px rgba(250, 204, 21, 0.8)",
      }}
      aria-label="awaiting operator permission"
      title="awaiting operator permission"
    />
  );
}

/**
 * Props:
 *   row             — BattleCardRow shape from battle-card-state.ts
 *   isHovered       — boolean from NowPixel's shared hoveredSubagentId
 *   onHover         — (id|null) => void; mirrors HabitatGrid's contract
 *   onOpenPokedex   — (taskId) => void; clicking the card opens the modal
 */
export default function BattleCard({
  row,
  isHovered = false,
  onHover = () => {},
  onOpenPokedex = () => {},
}) {
  const {
    id,
    classLabel,
    spriteFile,
    counters,
    currentActivity,
    permissionWaitOpen,
    prRef,
    tooltip,
  } = row;

  return (
    <button
      type="button"
      data-testid="battle-card"
      data-task-id={id}
      title={tooltip}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onClick={() => onOpenPokedex(id)}
      className="flex flex-col items-stretch rounded border border-zinc-800 bg-zinc-900 text-left p-2 cursor-pointer"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        flexShrink: 0,
        transform: isHovered ? "scale(1.03)" : "scale(1)",
        transition: "transform 150ms",
        boxShadow: isHovered
          ? "0 0 0 1px rgba(250, 204, 21, 0.6), 0 4px 12px rgba(0,0,0,0.5)"
          : "none",
      }}
    >
      <header className="flex items-center gap-2 mb-1 min-w-0">
        <img
          src={`${SPRITE_PREFIX}${spriteFile}`}
          alt={classLabel}
          width={32}
          height={32}
          style={{ imageRendering: "pixelated" }}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-[10px] uppercase tracking-wide text-zinc-300 truncate font-mono"
            data-testid="battle-card-class"
          >
            {classLabel}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[9px] text-zinc-500 font-mono">HP</span>
            <div
              style={{
                flex: 1,
                height: 4,
                background: "#27272a",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  background: "#22c55e",
                }}
              />
            </div>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[9px] text-zinc-500 font-mono">EXP</span>
            <div
              style={{
                flex: 1,
                height: 3,
                background: "#27272a",
                borderRadius: 2,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "0%",
                  height: "100%",
                  background: "#3b82f6",
                }}
              />
            </div>
          </div>
        </div>
        {permissionWaitOpen && <PermissionWaitDot />}
      </header>

      <div
        className="text-[10px] text-zinc-400 truncate font-mono mb-1"
        data-testid="battle-card-activity"
        style={{ minHeight: 12 }}
      >
        {currentActivity || <span className="text-zinc-600 italic">idle</span>}
      </div>

      <div className="flex items-center gap-2" data-testid="battle-card-counters">
        <CounterPill icon="✎" count={counters.writes} label="writes" />
        <CounterPill icon="⚙" count={counters.milestones} label="milestones" />
        <CounterPill icon="📖" count={counters.reads} label="reads" />
      </div>

      <div className="flex-1" />

      {prRef && (
        <a
          data-testid="battle-card-pr-link"
          href={prRef.startsWith("http") ? prRef : `https://github.com/${prRef.replace(/^#/, "")}`}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] text-sky-400 font-mono truncate hover:underline"
          title={prRef}
        >
          {prRef}
        </a>
      )}
    </button>
  );
}

/**
 * Keyframes for the permission-wait dot pulse. The component injects them
 * inline once via the document-level <style> sweep below — Tailwind v4 in
 * this project does not auto-generate keyframes, and we want the pulse to
 * be visible during a Vite-only dev session too.
 *
 * Idempotent: every mount re-runs ensureStyles, but the function bails when
 * the style tag is already in the DOM.
 */
const PULSE_KEYFRAMES = `@keyframes battlecard-pulse {
  0%, 100% { transform: scale(1); opacity: 0.85; }
  50%      { transform: scale(1.3); opacity: 1; }
}`;

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById("battlecard-pulse-keyframes")) return;
  const tag = document.createElement("style");
  tag.id = "battlecard-pulse-keyframes";
  tag.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(tag);
}

ensureStyles();
