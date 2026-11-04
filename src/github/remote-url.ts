/**
 * github/remote-url.ts — the ONE home of the git-remote URL rule (issue #5098,
 * epic #5094): userinfo redaction, repo normalisation and host extraction.
 *
 * Before this module the rule lived in two places that drifted — the watchdog's
 * bash `sed` chain and `recent-merges.ts` — and `[^/]*@` was re-broken in each
 * (docs/research/2026-10-24-qa-findings-recurrence...). Every URL that reaches
 * a log line, event payload, Page fact or fetch-stderr WARN passes through
 * {@link redactUrlUserinfo} / {@link redactUrlUserinfoText} first.
 *
 * Pure string functions; no I/O.
 */

const SCHEME = "[A-Za-z][A-Za-z0-9+.-]*";

/**
 * Strip `user[:token]@` userinfo from a remote URL so a credentialed origin
 * (https://user:TOKEN@github.com/...) never reaches a log sink (#4939 QA).
 * Everything after `scheme://` through the LAST `@` is removed (greedy), so a
 * token containing `@` or `/` never leaks (#5026 INV-8, QA round 4); an `@`
 * in the path is over-stripped, which is fail-safe for a log sink. The scheme
 * follows RFC 3986. scp-style `git@host:path` has no scheme and is left alone
 * (no secret).
 */
export function redactUrlUserinfo(url: string): string {
  return url.replace(new RegExp(`^(${SCHEME}:\\/\\/).*@`), "$1");
}

/**
 * Free-text variant for multi-line git stderr: strips userinfo anywhere in the
 * text, greedy up to the last `@` of the whitespace/quote-free run (so a token
 * containing `/` never survives) — the same rule as {@link redactUrlUserinfo}.
 */
export function redactUrlUserinfoText(text: string): string {
  return text.replace(new RegExp(`(${SCHEME}:\\/\\/)[^\\s'"]*@`, "g"), "$1");
}

/**
 * Remove scheme and userinfo: for a scheme URL strip through the LAST `@` of
 * the whole remainder (greedy), else just the scheme; scp-style
 * `user@host:path` keeps the `^[^/]*@` strip.
 */
function stripSchemeAndUserinfo(url: string): string {
  return url
    .replace(new RegExp(`^${SCHEME}:\\/\\/.*@`), "")
    .replace(new RegExp(`^${SCHEME}:\\/\\/`), "")
    .replace(/^[^/]*@/, "");
}

/**
 * Normalise a remote URL to its lowercased `owner/repo` identity: scheme and
 * userinfo gone, `host[:port]` (or scp `host:`) gone, trailing slashes and
 * `.git` dropped.
 */
export function normaliseRemoteRepo(url: string): string {
  return stripSchemeAndUserinfo(url)
    .replace(/^[^/:]+[:/]/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/**
 * The lowercased host of a remote URL: scheme + userinfo stripped, then
 * `^[^/:]+` (an optional `:port` is dropped). An ssh Host alias reads as that
 * alias (set HYDRA_WATCHDOG_EXPECTED_ORIGIN_HOST if one is used).
 */
export function remoteHost(url: string): string {
  return stripSchemeAndUserinfo(url).replace(/^([^/:]+).*$/s, "$1").toLowerCase();
}
