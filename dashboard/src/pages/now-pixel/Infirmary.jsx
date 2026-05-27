import { useApi } from "../../hooks/useApi.js";

/**
 * Infirmary — center column service-health card for /now-pixel.
 *
 * Slice 5 of /now-pixel (#642, #647). Reads /api/now/service-strip
 * every 15s (mirrors the existing ServiceStrip cadence) and renders the
 * 4 services as Pokemon-Center-styled HP bars.
 *
 * Failure presentation: red bar at 0% + a subtle infinite-pulse glow so
 * the operator sees a downed service from across the room.
 */
const SERVICE_ICONS = {
  orchestrator: "🏛️",
  redis: "💾",
  vikingdb: "📚",
  openviking: "🔎",
};

const STATUS_TO_HP = {
  ok: 100,
  degraded: 50,
  down: 0,
  // Unknown / missing → grey-bar, distinct from a real down.
  unknown: -1,
};

function hpPercent(status) {
  const v = STATUS_TO_HP[status];
  return typeof v === "number" ? v : -1;
}

function hpColor(hp, status) {
  if (status === "down" || hp === 0) return "#dc2626"; // red-600
  if (hp >= 100) return "#22c55e"; // green-500
  if (hp >= 50) return "#facc15"; // yellow-400
  return "#71717a"; // zinc-500 (unknown)
}

export default function Infirmary() {
  const { data, error } = useApi("/now/service-strip", { poll: 15_000 });
  const rows = data?.rows ?? [];

  return (
    <section
      className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
      data-testid="infirmary"
    >
      <header className="mb-2 text-center">
        <h2 className="text-[10px] uppercase tracking-wider text-zinc-500">
          Infirmary
        </h2>
        <div className="text-[9px] text-zinc-600">services</div>
      </header>
      {error ? (
        <p className="text-xs text-rose-400">Error: {error}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-zinc-500">loading…</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const hp = hpPercent(row.status);
            const filled = Math.max(0, hp);
            const color = hpColor(hp, row.status);
            const down = row.status === "down" || hp === 0;
            return (
              <li
                key={row.service}
                className="flex flex-col gap-0.5"
                data-service={row.service}
                data-status={row.status}
                title={`${row.service}: ${row.status}${row.latencyMs != null ? ` · ${row.latencyMs}ms` : ""}`}
              >
                <div className="flex items-center gap-1">
                  <span style={{ fontSize: 12 }}>
                    {SERVICE_ICONS[row.service] ?? "❓"}
                  </span>
                  <span className="text-[10px] uppercase text-zinc-300 truncate">
                    {row.service}
                  </span>
                </div>
                {/* HP bar */}
                <div
                  style={{
                    width: 96,
                    height: 6,
                    background: "#1f1f23",
                    borderRadius: 3,
                    overflow: "hidden",
                    position: "relative",
                  }}
                >
                  <div
                    className={down ? "service-hp-down" : ""}
                    style={{
                      width: hp < 0 ? "100%" : `${filled}%`,
                      height: "100%",
                      background: color,
                      transition: "width 200ms ease-out",
                    }}
                  />
                </div>
                <div
                  className="text-[9px] text-zinc-500 truncate"
                  style={{ minHeight: 11 }}
                >
                  {row.latencyMs != null ? `${row.latencyMs}ms` : row.status}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <style>{`
        @keyframes service-hp-down-kf {
          0%   { opacity: 1; }
          50%  { opacity: 0.4; }
          100% { opacity: 1; }
        }
        .service-hp-down {
          animation: service-hp-down-kf 800ms ease-in-out infinite;
        }
      `}</style>
    </section>
  );
}
