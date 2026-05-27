import ClassSprite from "./ClassSprite.jsx";

/**
 * HabitatZone — single class slot in the habitat grid. Title + sprite +
 * status indicator. Slice 3 of /now-pixel (#642, #645).
 *
 * `placeholder` short-circuits the sprite render entirely; used for the
 * `design_concept_target` "Phase D placeholder" tile.
 */
export default function HabitatZone({
  className,
  status,
  signalSeed = null,
  placeholder = null,
  animation = null,
}) {
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
        <ClassSprite
          className={className}
          status={status}
          signalSeed={signalSeed}
          animation={animation}
        />
      )}
      <div
        className="text-[10px] uppercase tracking-wide text-zinc-500 truncate max-w-[80px]"
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
