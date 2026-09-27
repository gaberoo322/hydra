// Build provenance constants for /docs (#4590, ADR-0034 §10 trust rule 1).
// Vite `define` constants from dashboard/vite.config.js — never a live value.

export const BUILD_SHA = import.meta.env.HYDRA_BUILD_SHA || "unknown";
export const BUILD_TIME = import.meta.env.HYDRA_BUILD_TIME || "";

export const REPO_URL = "https://github.com/gaberoo322/hydra";

/** GitHub blob URL for a repo file at the build SHA (master when unknown). */
export function sourceUrl(path, line) {
  const ref = BUILD_SHA === "unknown" ? "master" : BUILD_SHA;
  return `${REPO_URL}/blob/${ref}/${path}${line ? `#L${line}` : ""}`;
}
