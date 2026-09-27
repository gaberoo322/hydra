import { NavLink } from "react-router-dom";
import VersionBadge from "./VersionBadge.jsx";

// Dashboard v2 atomic swap (issue #621 / PRD #615). Sidebar is flat items.
// /now-pixel epic (#642) slice 7 PR2 (#649) flipped Now to the
// pixel habitat; the temporary "Pixel View" link from PR1 was removed
// because /now IS pixel now. The deprecated /now-classic fallback was
// retired on 2026-06-10 (issue #664). Dashboard v3 (#4008) added Health —
// the phone-grade is-it-on-fire surface (ADR-0034). Slice eta (#4012,
// ADR-0034 §3) dropped the Outcomes and Explore nav entries — their pages
// are retired; Now stays (it still resolves to the Console).
//
// docs-epic slice 4 (#4590, ADR-0034 §1 as amended by #4587): the sidebar
// has exactly TWO groups, both exported data arrays so the pages-inventory
// extractor (#4595) can scan them. Group 1 is the journey pages in the §1
// table order (Today, Health, Work, Runs, Builder), with the existing Now
// entry appended unchanged — /now's ADR status is an open operator question.
// Group 2 is the visually separated reference group, holding only Docs.
export const JOURNEY_NAV = [
  { to: "/", label: "Today", end: true, icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  // Dashboard v3 slice gamma (#4008, ADR-0034): the phone-grade /health
  // surface — is it on fire, or burning money.
  { to: "/health", label: "Health", icon: "M3 12h4l3 8 4-16 3 8h4" },
  { to: "/work", label: "Work", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
  { to: "/runs", label: "Runs", icon: "M4 6h16M4 12h16M4 18h7" },
  { to: "/builder", label: "Builder", icon: "M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" },
  { to: "/now", label: "Now", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
];

export const REFERENCE_NAV = [
  { to: "/docs", label: "Docs", icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" },
];

function NavItem({ to, label, icon, end }) {
  return (
    <NavLink
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
  );
}

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
      <nav className="flex-1 py-2 overflow-y-auto flex flex-col">
        <div data-testid="nav-journey">
          {JOURNEY_NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </div>
        {/* Reference group — visually separated from the journey pages by a
            border-top divider (ADR-0034 §1 as amended by #4587). */}
        <div data-testid="nav-reference" className="mt-auto border-t border-zinc-800 pt-2">
          {REFERENCE_NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </div>
      </nav>
      <VersionBadge />
    </aside>
  );
}
