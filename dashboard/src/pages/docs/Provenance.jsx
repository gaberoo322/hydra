import { Link } from "react-router-dom";
import { BUILD_SHA, BUILD_TIME, REPO_URL } from "./build-info.js";

// Provenance line (#4590, ADR-0034 §10 trust rule 1). The build's own commit
// and build time are Vite `define` constants (dashboard/vite.config.js) —
// never a live value. Whether that commit is what origin/master says is
// drift, which /health owns: this line links there and never computes it.

function formatUtc(iso) {
  if (!iso) return "at an unknown time";
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export default function Provenance() {
  return (
    <div data-testid="docs-provenance" className="mb-4 border-b border-zinc-800 pb-2 font-mono text-[11px] text-zinc-500">
      as of{" "}
      {BUILD_SHA === "unknown" ? (
        <span className="text-zinc-300">commit unknown</span>
      ) : (
        <>
          commit{" "}
          <a className="text-zinc-300 hover:underline" href={`${REPO_URL}/commit/${BUILD_SHA}`} target="_blank" rel="noreferrer">
            {BUILD_SHA.slice(0, 9)}
          </a>
        </>
      )}
      , built {formatUtc(BUILD_TIME)}
      {" · "}
      <Link to="/health" className="text-zinc-400 hover:underline">
        is prod on this commit? → /health
      </Link>
    </div>
  );
}
