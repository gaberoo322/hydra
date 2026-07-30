import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import {
  badgeVersionLabel,
  projectState,
  versionAnchorHref,
} from "../lib/versions-format.ts";

/**
 * VersionBadge — the always-on footer strip showing each project's current
 * version (issue #3681, epic #3676 epsilon; wayfinder ticket #3660).
 *
 * Rendered by `Layout.jsx`, so it is visible on EVERY route, not just Today —
 * "what version is prod actually on?" is a question the operator asks while
 * looking at any page. Clicking a chip navigates to `/#versions-<scope>`, which
 * the Today-page `Versions` panel scrolls to.
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
    <footer className="sticky bottom-0 z-10 border-t border-zinc-800 bg-zinc-950/90 backdrop-blur px-6 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[10px] uppercase tracking-wider text-zinc-600">Versions</span>

        {projects.map((project) => {
          const ok = projectState(project) === "ok";
          return (
            <Link
              key={project.scope || project.name}
              to={versionAnchorHref(project.scope)}
              title={
                ok
                  ? `${project.name} — jump to release notes`
                  : `${project.name} — no readable release; jump to details`
              }
              className="group flex items-baseline gap-1.5 text-xs hover:underline"
            >
              <span className="text-zinc-500 group-hover:text-zinc-300">{project.name}</span>
              <span className={`font-mono ${ok ? "text-emerald-400" : "text-zinc-600"}`}>
                {badgeVersionLabel(project)}
              </span>
            </Link>
          );
        })}
      </div>
    </footer>
  );
}
