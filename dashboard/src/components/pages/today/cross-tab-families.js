/**
 * Model families rendered as columns in the per-skill cross-tab and summed for
 * the dispatch-kind split (issues #693, #2403). Shared by `SkillModelCrossTab`
 * and `DispatchKindSplit`; kept in its own module so both component files stay
 * component-only (react-refresh fast-refresh boundary).
 */
export const CROSS_TAB_FAMILIES = ["opus", "sonnet", "haiku", "unknown"];
