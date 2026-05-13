// ---------------------------------------------------------------------------
// buildSpecAnchor — shared spec-task → anchor adapter
// ---------------------------------------------------------------------------
//
// Extracted from select.ts so the unified capacity-floor dispatcher
// (capacity-floors.ts) and the natural spec-tier path in select.ts can both
// reach it without a circular import. The two paths produce byte-identical
// anchors — there's exactly one place that formats a spec task into the
// "user-request" anchor shape the planner expects.

import { formatSpecForPrompt } from "../specs.ts";

export function buildSpecAnchor(specNext: { spec: any; task: any }) {
  console.log(
    `[ControlLoop] Picking spec task: "${specNext.task.title}" from spec ` +
    `"${specNext.spec.title}" (task ${specNext.task.id}/${specNext.spec.tasks.length})`,
  );
  return {
    type: "user-request" as const,
    reference: specNext.task.title,
    whyNow: `Spec "${specNext.spec.title}" task ${specNext.task.id}/${specNext.spec.tasks.length}: ${specNext.task.title}`,
    context: {
      specSlug: specNext.spec.slug,
      specTaskId: specNext.task.id,
      specTitle: specNext.spec.title,
      specRationale: specNext.spec.rationale,
      _specPromptContext: formatSpecForPrompt(specNext.spec, specNext.task),
    },
    description: specNext.task.description || specNext.task.title,
  };
}
