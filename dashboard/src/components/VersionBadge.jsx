import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import {
  badgeVersionLabel,
  projectState,
  versionAnchorHref,
} from "../lib/versions-format.ts";

/**
 * VersionBadge — the always-on strip showing each project's current version
 * (issue #3681, epic #3676 epsilon; wayfinder ticket #3660).
 *
 * Rendered by `Sidebar.jsx`, in the slot below `<nav>` — the sidebar is
 * already the app's always-on global chrome on every route, so mounting here
 * needs no change to `Layout.jsx`'s scroll container. The approved
 * design-concept artifact for #3681 evaluated and explicitly REJECTED the
 * alternative (a new `<footer>` in `Layout.jsx`): that restructures `<main>`
 * into a column, which changes the scroll container for EVERY route — a
 * large blast radius for a version chip. `<nav>` is `flex-1`, so this
 * component renders in the natural bottom slot it leaves below itself.
 *
 * The sidebar is a fixed w-56 column, so chips stack VERTICALLY — one line
 * per project, name truncated — rather than wrapping horizontally.
 *
 * Clicking a chip navigates to `/#versions`, which the Today-page `Versions`
 * panel scrolls to.
 *
 * Renders nothing at all while loading or when the read fails outright: a
 * permanently-visible chrome element must never turn into an error banner
 * stapled to the bottom of every page. A per-project degraded state is
 * different — that renders as `—` (via `badgeVersionLabel`), because knowing
 * that one repo's version is unreadable IS the signal.
 *
 * Shares `lib/versions-format.ts` with the panel so the two can never disagree
 * about what "current" means.
 */

/** 5 minutes — same cadence as the panel; releases are cut at deploy time. */
const POLL_MS = 300_000;

export default function VersionBadge() {
  const { data, error } = useApi("/versions", { poll: POLL_MS });

  const projects = data?.projects ?? [];
  // Silent when there is nothing trustworthy to say — see the note above.
  if (error || projects.length === 0) return null;

  return (
    <div className="border-t border-zinc-800 px-4 py-2">
      <span className="text-[10px] uppercase tracking-wider text-zinc-600">Versions</span>
      <div className="mt-1 space-y-0.5">
        {projects.map((project) => {
          const ok = projectState(project) === "ok";
          return (
            <Link
              key={`${project.scope}:${project.name}`}
              to={versionAnchorHref()}
              title={
                ok
                  ? `${project.name} — jump to release notes`
                  : `${project.name} — no readable release; jump to details`
              }
              className="group flex items-baseline justify-between gap-1.5 text-xs hover:underline"
            >
              <span className="text-zinc-500 group-hover:text-zinc-300 truncate">
                {project.name}
              </span>
              <span className={`font-mono shrink-0 ${ok ? "text-emerald-400" : "text-zinc-600"}`}>
                {badgeVersionLabel(project)}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
