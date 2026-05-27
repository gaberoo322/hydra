import { subagentSpriteFile } from "./sprite-map.ts";
import { deriveHp } from "./derive-sprite-state.ts";
import HpBar from "./HpBar.jsx";

/**
 * SubagentSprite — single subagent occupying a pipeline class slot.
 *
 * Slice 6 of /now-pixel (#642, #648). Renders the pre-evolution sprite
 * if one exists (via sprite-map's EVOLUTION_CHAINS), else the parent
 * desaturated at 75% scale. HP bar from deriveHp(tokens, hardMax).
 *
 * Hover-link: when the operator hovers the in-zone copy, the same
 * subagent's mirror in ActiveDispatchesStrip gets highlighted (parent
 * lifts hoveredId state).
 */
export default function SubagentSprite({
  parentClass,
  taskId,
  tokens = 0,
  hardMax = 800_000, // default mirrors state.limits.subagent_hard_max_tokens
  hoveredId = null,
  onHover = () => {},
  size = 48,
}) {
  let info = null;
  let error = null;
  try {
    info = subagentSpriteFile(parentClass);
  } catch (err) {
    error = err.message;
  }
  if (error) return null;

  const hp = deriveHp(tokens, hardMax);
  const isHovered = hoveredId && hoveredId === taskId;

  return (
    <div
      className="flex flex-col items-center"
      data-testid="subagent-sprite"
      data-task-id={taskId}
      style={{
        cursor: "pointer",
        transition: "transform 150ms",
        transform: isHovered ? "scale(1.15)" : "scale(1)",
      }}
      onMouseEnter={() => onHover(taskId)}
      onMouseLeave={() => onHover(null)}
      title={`${parentClass} subagent · ${taskId?.slice(0, 8) ?? "?"}`}
    >
      <img
        src={`/sprites/pokemon/${info.spriteFile}`}
        alt={`${parentClass} subagent`}
        style={{
          width: size,
          height: size,
          imageRendering: "pixelated",
          filter: info.desaturate ? "saturate(0.6)" : "none",
          opacity: isHovered ? 1 : 0.95,
          transition: "filter 200ms, opacity 200ms",
        }}
      />
      <HpBar
        percent={hp.percent}
        color={hp.color}
        flashing={hp.flashing}
        width={size}
        height={3}
      />
    </div>
  );
}
