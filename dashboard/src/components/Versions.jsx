import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useApi } from "../hooks/useApi.js";
import { Section } from "./pages/today/Section.jsx";
import {
  splitReleases,
  groupNotesByType,
  projectState,
  currentVersionLabel,
  formatReleaseDate,
  shortSha,
  versionAnchorId,
  issueUrl,
  EMPTY_PLACEHOLDER,
} from "../lib/versions-format.ts";

/**
 * Versions — the Today-page panel over `GET /api/versions` (issue #3681,
 * epic #3676 epsilon; wayfinder ticket #3660).
 *
 * One collapsible card per project: the current version, that release's notes
 * grouped by Conventional-Commits type, and an "older versions" expander over
 * the rest of `history[]`. Scales from one project to N by stacking cards, so
 * adding a Target to the roster needs no layout change here.
 *
 * Every real decision (the current-vs-older split that prevents rendering the
 * newest release twice, the three degraded states, the note ordering) lives in
 * `lib/versions-format.ts` and is unit-tested in `test/versions-format.test.mts`
 * — this file is deliberately a thin renderer, because the dashboard has no
 * component-test runner.
 *
 * Polls every 5 minutes: releases are cut at deploy time, so the 30s/60s
 * cadence the operator-attention sections use would be pure waste here.
 */

/** 5 minutes — releases move far slower than the other Today sections. */
const POLL_MS = 300_000;

/** One `type: description (#issue)` line. */
function NoteLine({ note, scope }) {
  const href = issueUrl(scope, note.issue);
  return (
    <li className="text-sm text-zinc-300 flex gap-2">
      <span className="text-zinc-600 select-none">·</span>
      <span className="min-w-0">
        {note.description}
        {href && (
          <>
            {" "}
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-400 hover:underline"
            >
              #{note.issue}
            </a>
          </>
        )}
      </span>
    </li>
  );
}

/** The notes of one release, grouped and headed by type. */
function NoteGroups({ notes, scope }) {
  const groups = groupNotesByType(notes);

  if (groups.length === 0) {
    return <p className="text-sm text-zinc-500 italic">No release notes in this version.</p>;
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.type}>
          <h4 className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
            {group.label}
            <span className="ml-2 text-zinc-600">{group.notes.length}</span>
          </h4>
          <ul className="space-y-1">
            {group.notes.map((note, i) => (
              <NoteLine key={`${note.raw}-${i}`} note={note} scope={scope} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** `Jul 29, 2026 · abcdef1` — when a release was cut and what it points at. */
function ReleaseMeta({ release }) {
  return (
    <span className="text-xs text-zinc-500">
      {formatReleaseDate(release.date)}
      <span className="mx-1 text-zinc-700">·</span>
      <code className="font-mono">{shortSha(release.sha)}</code>
    </span>
  );
}

/** The `<details>` expander over every release that is not the current one. */
function OlderVersions({ older, scope }) {
  if (older.length === 0) return null;

  return (
    <details className="mt-4 border-t border-zinc-700/50 pt-3">
      <summary className="cursor-pointer text-xs uppercase tracking-wide text-zinc-400 hover:text-zinc-200">
        Older versions
        <span className="ml-2 px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-300 normal-case">
          {older.length}
        </span>
      </summary>

      <div className="mt-3 space-y-4">
        {older.map((release) => (
          <div key={release.sha || release.version} className="pl-3 border-l border-zinc-700">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="font-mono text-sm text-zinc-200">{release.version}</span>
              <ReleaseMeta release={release} />
            </div>
            <NoteGroups notes={release.notes} scope={scope} />
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One project's card. Collapsible (`<details open>`) so an operator watching N
 * projects can fold the ones they aren't shipping today.
 */
function ProjectCard({ project }) {
  const state = projectState(project);
  const { current, older } = splitReleases(project);

  return (
    <details
      open
      id={versionAnchorId(project.scope)}
      className="bg-zinc-900/40 rounded-md border border-zinc-700/60 p-4 scroll-mt-6"
    >
      <summary className="cursor-pointer flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-zinc-100">{project.name}</span>
        <span
          className={`font-mono text-sm ${
            state === "ok" ? "text-emerald-300" : "text-zinc-500 italic"
          }`}
        >
          {currentVersionLabel(project)}
        </span>
      </summary>

      <div className="mt-3">
        {state === "error" && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-300 rounded-md p-3 text-sm">
            <div className="font-semibold mb-1">Couldn't read releases</div>
            <div className="font-mono break-all text-xs">{project.error || "unknown error"}</div>
          </div>
        )}

        {state === "empty" && (
          <p className="text-sm text-zinc-500 italic">
            {EMPTY_PLACEHOLDER} — this repository has never been tagged.
          </p>
        )}

        {state === "ok" && current && (
          <>
            <div className="mb-2">
              <ReleaseMeta release={current} />
            </div>
            <NoteGroups notes={current.notes} scope={project.scope} />
          </>
        )}

        <OlderVersions older={older} scope={project.scope} />
      </div>
    </details>
  );
}

export default function Versions() {
  const { data, error, loading } = useApi("/versions", { poll: POLL_MS });
  const { hash } = useLocation();
  const projects = data?.projects ?? [];

  // The footer badge links to `/#versions-<scope>`. React Router does not
  // scroll to a hash on its own, so the panel does it once the cards exist.
  useEffect(() => {
    if (!hash || projects.length === 0) return;
    const el = document.getElementById(hash.slice(1));
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [hash, projects.length]);

  return (
    <Section
      title="Versions"
      subtitle="Current release and recent notes per repository."
      count={projects.length}
      loading={loading}
      error={error}
      empty={!loading && !error && projects.length === 0}
      emptyMessage="No projects reporting versions."
    >
      <div className="space-y-3">
        {projects.map((project) => (
          <ProjectCard key={project.scope || project.name} project={project} />
        ))}
      </div>
    </Section>
  );
}
