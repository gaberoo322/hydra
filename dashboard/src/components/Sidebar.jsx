import { NavLink } from "react-router-dom";

// Dashboard v2 atomic swap (issue #621 / PRD #615). Sidebar is four flat
// items. /now-pixel epic (#642) slice 7 PR2 (#649) flipped Now to the
// pixel habitat; the temporary "Pixel View" link from PR1 was removed
// because /now IS pixel now. /now-classic remains reachable by direct
// URL through 2026-06-10 as a fallback.
const NAV_ITEMS = [
  { to: "/", label: "Today", end: true, icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { to: "/now", label: "Now", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { to: "/outcomes", label: "Outcomes", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
  { to: "/explore", label: "Explore", icon: "M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" },
];

export default function Sidebar({ connected }) {
  return (
    <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-lg font-bold text-white tracking-tight">Hydra</h1>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-400" : "bg-red-400"}`} />
          <span className="text-xs text-zinc-400">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </div>
      <nav className="flex-1 py-2 overflow-y-auto">
        {NAV_ITEMS.map(({ to, label, icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-zinc-800 text-white border-r-2 border-emerald-400"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`
            }
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
            </svg>
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
