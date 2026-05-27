import ClassSprite from "./ClassSprite.jsx";
import SubagentSprite from "./SubagentSprite.jsx";
import CooldownClock from "./CooldownClock.jsx";
import { SIGNAL_CLASSES } from "./sprite-map.ts";

/**
 * HabitatZone — single class slot in the habitat grid.
 *
 * Slice 6 of /now-pixel (#642, #648) — adds subagent + cooldown overlays.
 *
 * Pipeline classes: render the parent ClassSprite plus, when `subagent`
 * is non-null, a SubagentSprite next to it. The 3-cap + overflow badge
 * is reserved for future ad-hoc multi-occupancy; today's pipeline model
 * is 1 slot = 1 subagent so the cap never triggers.
 *
 * Signal classes: render the parent ClassSprite plus a CooldownClock
 * overlay when the class is in cooldown. health has cooldown 0 so the
 * overlay is suppressed.
 */
const SIGNAL_SET = new Set(SIGNAL_CLASSES);

export default function HabitatZone({
  className,
  status,
  signalSeed = null,
  placeholder = null,
  animation = null,
  subagent = null,
  cooldown = null,
  hardMax = 800_000,
  hoveredSubagentId = null,
  onSubagentHover = () => {},
}) {
  const isSignal = SIGNAL_SET.has(className);
  return (
    <div
      className="flex flex-col items-center gap-1 p-2 rounded border border-zinc-800 bg-zinc-900"
      data-testid={`zone-${className}`}
      data-status={placeholder ? "placeholder" : status}
    >
      {placeholder ? (
        <div
          style={{
            width: 64,
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px dashed #444",
            color: "#666",
            fontSize: 10,
            textAlign: "center",
            padding: 4,
            boxSizing: "border-box",
          }}
        >
          {placeholder}
        </div>
      ) : (
        <div
          className="flex items-end gap-1"
          style={{ position: "relative", minHeight: 64 }}
        >
          <ClassSprite
            className={className}
            status={status}
            signalSeed={signalSeed}
            animation={animation}
          />
          {!isSignal && subagent && (
            <SubagentSprite
              parentClass={className}
              taskId={subagent.task_id}
              tokens={Number(subagent.partial_tokens ?? 0)}
              hardMax={hardMax}
              hoveredId={hoveredSubagentId}
              onHover={onSubagentHover}
            />
          )}
          {isSignal && status === "sleeping" && cooldown && (
            <CooldownClock
              secondsRemaining={cooldown.secondsRemaining}
              ready={cooldown.ready}
              totalSeconds={cooldown.totalSeconds}
            />
          )}
        </div>
      )}
      <div
        className="text-[10px] uppercase tracking-wide text-zinc-500 truncate max-w-[120px]"
        style={{ fontFamily: "monospace" }}
        title={className}
      >
        {className}
      </div>
      {!placeholder && (
        <div
          className="text-[9px] uppercase tracking-wide"
          style={{
            color: status === "active" ? "#7dd3fc" : "#444",
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}
