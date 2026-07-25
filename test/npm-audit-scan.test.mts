import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAudit,
  renderSummary,
  type AuditJson,
} from "../scripts/ci/npm-audit-scan.ts";

// Regression coverage for the security-critical fail-closed audit logic
// (issue #3650) — the same properties two independent adversarial reviewers
// verified on PR #3608 before it was demoted out of the required gate. Pure
// function, no Redis/network: its own top-level suite with no shared teardown.

const WAIVED = "GHSA-qwww-vcr4-c8h2"; // react-router RSC CSRF (operator-waived)

function ghsaUrl(id: string): string {
  return `https://github.com/advisories/${id}`;
}

describe("evaluateAudit — fail-closed npm-audit classifier", () => {
  test("empty audit → nothing blocking or waived", () => {
    const r = evaluateAudit({ vulnerabilities: {} }, [WAIVED]);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 0);
  });

  test("missing vulnerabilities key → healthy, no throw", () => {
    const r = evaluateAudit({} as AuditJson, []);
    assert.deepEqual(r, { blocking: [], waived: [] });
  });

  test("allowlisted high advisory → waived, not blocking", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        "react-router": {
          severity: "high",
          range: ">=7.12.0",
          via: [{ url: ghsaUrl(WAIVED), title: "RSC CSRF" }],
        },
      },
    };
    const r = evaluateAudit(audit, [WAIVED]);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 1);
    assert.equal(r.waived[0].name, "react-router");
    assert.deepEqual(r.waived[0].ids, [WAIVED]);
  });

  test("new, different GHSA with empty allowlist → blocks", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        "brace-expansion": {
          severity: "high",
          range: "<=5.0.7",
          via: [{ url: ghsaUrl("GHSA-mh99-v99m-4gvg") }],
        },
      },
    };
    const r = evaluateAudit(audit, []);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].name, "brace-expansion");
    assert.deepEqual(r.blocking[0].ids, ["GHSA-mh99-v99m-4gvg"]);
  });

  test("even with the react-router waiver present, a different new CVE still blocks", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        "react-router": {
          severity: "high",
          range: ">=7.12.0",
          via: [{ url: ghsaUrl(WAIVED) }],
        },
        lodash: {
          severity: "critical",
          range: "<9",
          via: [{ url: ghsaUrl("GHSA-aaaa-bbbb-cccc") }],
        },
      },
    };
    const r = evaluateAudit(audit, [WAIVED]);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].name, "lodash");
    assert.equal(r.waived.length, 1);
  });

  test("co-resident waived + unwaived ids on ONE package → blocks on the unwaived id only", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        somepkg: {
          severity: "high",
          range: "*",
          via: [
            { url: ghsaUrl(WAIVED) },
            { url: ghsaUrl("GHSA-zzzz-yyyy-xxxx") },
          ],
        },
      },
    };
    const r = evaluateAudit(audit, [WAIVED]);
    assert.equal(r.blocking.length, 1);
    assert.deepEqual(r.blocking[0].ids, ["GHSA-zzzz-yyyy-xxxx"]);
    assert.equal(r.waived.length, 0);
  });

  test("pure-transitive (via strings only) → skipped, parent judged separately", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        "react-router-dom": {
          severity: "high",
          range: ">=7.12.0",
          via: ["react-router"], // string alias, no advisory object
        },
      },
    };
    const r = evaluateAudit(audit, []);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 0);
  });

  test("moderate/low severities are ignored (gate is high+)", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        qs: {
          severity: "moderate",
          range: "*",
          via: [{ url: ghsaUrl("GHSA-q8mj-m7cp-5q26") }],
        },
      },
    };
    const r = evaluateAudit(audit, []);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 0);
  });

  test("advisory object without a url → skipped (no id to judge)", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        weird: {
          severity: "high",
          range: "*",
          via: [{ title: "no url here" }],
        },
      },
    };
    const r = evaluateAudit(audit, []);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 0);
  });

  test("non-GHSA advisory url → fails closed (never matches an allowlist entry)", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        legacy: {
          severity: "critical",
          range: "*",
          via: [{ url: "https://npmjs.com/advisories/1234" }],
        },
      },
    };
    const r = evaluateAudit(audit, [WAIVED]);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].ids[0], "https://npmjs.com/advisories/1234");
  });

  test("allowlist entries are trimmed and blanks ignored", () => {
    const audit: AuditJson = {
      vulnerabilities: {
        "react-router": {
          severity: "high",
          range: "*",
          via: [{ url: ghsaUrl(WAIVED) }],
        },
      },
    };
    const r = evaluateAudit(audit, ["", `  ${WAIVED}  `]);
    assert.equal(r.blocking.length, 0);
    assert.equal(r.waived.length, 1);
  });
});

describe("renderSummary", () => {
  test("clean audit renders the no-advisories line", () => {
    const out = renderSummary("orchestrator", { blocking: [], waived: [] }, []);
    assert.match(out, /No high or critical advisories found\./);
    assert.match(out, /## npm audit — orchestrator/);
  });

  test("blocking finding is flagged as needing a dep-bump", () => {
    const out = renderSummary(
      "dashboard",
      {
        blocking: [
          { name: "brace-expansion", ids: ["GHSA-mh99-v99m-4gvg"], severity: "high", range: "<=5.0.7" },
        ],
        waived: [],
      },
      [WAIVED],
    );
    assert.match(out, /needs dep-bump/);
    assert.match(out, /brace-expansion/);
    assert.match(out, /Scoped allowlist active/);
  });
});
