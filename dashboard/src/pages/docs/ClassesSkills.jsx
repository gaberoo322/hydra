// Classes & skills catalogue (#4592, ADR-0034 §10) — the /docs/cat/classes
// view plus the card components the per-skill views reuse.
//
// Every generated value renders inside a Generated frame fed by its inventory
// (classes / skills); nothing here names a class or a skill — the cards are
// pure functions of docs/generated/classes.json + skills.json rows, which the
// build bundles (inventories.js). No view-time fetch of any kind.
//
// Stage grouping is the one hand-authored constant: the ORDER of the stage
// column's values (INV-19), not a list of names — brain first, the five spine
// stages, pre-plan producers, ops, Target, operator-interactive last.

import { Link } from "react-router-dom";
import Generated, { SourceRail } from "./Generated.jsx";
import { loadInventory } from "./inventories.js";

/** The stage-column display order (values of the column, never class/skill names). */
export const STAGE_ORDER = [
  "brain",
  "plan",
  "spec",
  "tickets",
  "implement",
  "review",
  "pre-plan-producer",
  "ops",
  "target",
  "operator-interactive",
];

/** Human label for a stage value — derived from the string itself. */
export function stageLabel(stage) {
  return String(stage)
    .split("-")
    .map((w) => (w === "" ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Rows bucketed by stage, in STAGE_ORDER (unknown stages trail, in seen order). */
export function stageGroups(rows) {
  const buckets = new Map(STAGE_ORDER.map((s) => [s, []]));
  const extra = [];
  for (const r of rows ?? []) {
    if (buckets.has(r.stage)) buckets.get(r.stage).push(r);
    else extra.push(r);
  }
  const out = [];
  for (const stage of STAGE_ORDER) {
    const group = buckets.get(stage);
    if (group.length > 0) out.push({ stage, rows: group });
  }
  for (const r of extra) {
    const last = out[out.length - 1];
    if (last && last.stage === r.stage) last.rows.push(r);
    else out.push({ stage: r.stage, rows: [r] });
  }
  return out;
}

function StageSection({ stage, children }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500" data-testid="stage-group">
        {stageLabel(stage)}
        <span className="ml-2 font-mono text-[10px] normal-case text-zinc-600">{stage}</span>
      </h2>
      <div className="grid gap-2 md:grid-cols-2">{children}</div>
    </section>
  );
}

/** The skill-view route for a skill name — derived, never hand-listed. */
export function skillHref(name) {
  return `/docs/skill/${name}`;
}

function Chip({ children }) {
  return <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">{children}</span>;
}

/** One dispatch-class card: the table row, linked to its skill views (INV-20). */
export function ClassCard({ row }) {
  return (
    <div id={row.name} data-testid="class-card" className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-zinc-200">{row.name}</span>
        <Chip>{row.stage}</Chip>
        <Chip>{row.model === "inherit" ? "model: omitted" : `model: ${row.model}`}</Chip>
        <Chip>{row.scope}</Chip>
        {row.cooldownSeconds != null && <Chip>cooldown {row.cooldownSeconds}s</Chip>}
      </div>
      <div className="mt-1 text-[12px] text-zinc-400">
        skill <Link to={skillHref(row.skill)} className="font-mono text-sky-400 hover:underline">{row.skill}</Link>
        {row.skill_by_ticket_type &&
          Object.entries(row.skill_by_ticket_type).map(([type, target]) => (
            <span key={type} className="ml-2">
              <span className="font-mono text-zinc-500">{type}</span> →{" "}
              <Link to={skillHref(target)} className="font-mono text-sky-400 hover:underline">{target}</Link>
            </span>
          ))}
      </div>
      {row.notes && <p className="mt-1 line-clamp-3 text-[12px] text-zinc-500">{row.notes}</p>}
    </div>
  );
}

/** One skill card: the derived skills-inventory row (INV-20's generated card). */
export function SkillCard({ row, linked = true, showDescription = true }) {
  const name = linked ? <Link to={row.route} className="font-mono text-sky-400 hover:underline">{row.name}</Link> : <span className="font-mono text-zinc-200">{row.name}</span>;
  return (
    <div id={row.name} data-testid="skill-card" className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {name}
        <Chip>{row.stage}</Chip>
        {row.composedFrom.length > 0 && <Chip>composed of {row.composedFrom.length}</Chip>}
      </div>
      {showDescription && row.description && <p className="mt-1 text-[12px] text-zinc-500">{row.description}</p>}
      {row.dispatchedBy.length > 0 && (
        <div className="mt-1 text-[12px] text-zinc-400">
          dispatched by{" "}
          {row.dispatchedBy.map((d) => (
            <span key={`${d.class}:${d.via}`} className="ml-1">
              <span className="font-mono text-zinc-300">{d.class}</span>
              {d.via === "default" ? "" : <span className="text-zinc-500"> ({d.via})</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Skill cards grouped by stage (INV-19's grouping, inside a Generated/skills frame). */
export function SkillGroups({ rows }) {
  return (
    <div className="space-y-4">
      {stageGroups(rows).map((g) => (
        <StageSection key={g.stage} stage={g.stage}>
          {g.rows.map((r) => (
            <SkillCard key={r.name} row={r} />
          ))}
        </StageSection>
      ))}
    </div>
  );
}

/** Class cards grouped by stage (inside a Generated/classes frame). */
export function ClassGroups({ rows }) {
  return (
    <div className="space-y-4">
      {stageGroups(rows).map((g) => (
        <StageSection key={g.stage} stage={g.stage}>
          {g.rows.map((r) => (
            <ClassCard key={r.name} row={r} />
          ))}
        </StageSection>
      ))}
    </div>
  );
}

/** The full class table (INV-20): every class row, each linked to its skill view. */
export function ClassTable({ rows }) {
  return (
    <table className="w-full text-left text-[12px]">
      <thead>
        <tr className="text-zinc-500">
          <th className="px-2 py-1">class</th>
          <th className="px-2 py-1">stage</th>
          <th className="px-2 py-1">model</th>
          <th className="px-2 py-1">skill</th>
          <th className="px-2 py-1">ticket-type routing</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} id={r.name} className="border-t border-zinc-800/60">
            <td className="px-2 py-1 font-mono text-zinc-300">{r.name}</td>
            <td className="px-2 py-1 text-zinc-400">{r.stage}</td>
            <td className="px-2 py-1 text-zinc-400">{r.model}</td>
            <td className="px-2 py-1">
              <Link to={skillHref(r.skill)} className="font-mono text-sky-400 hover:underline">{r.skill}</Link>
            </td>
            <td className="px-2 py-1">
              {r.skill_by_ticket_type
                ? Object.entries(r.skill_by_ticket_type).map(([type, target]) => (
                    <span key={type} className="mr-2">
                      <span className="font-mono text-zinc-500">{type}</span> →{" "}
                      <Link to={skillHref(target)} className="font-mono text-sky-400 hover:underline">{target}</Link>
                    </span>
                  ))
                : <span className="text-zinc-600">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The live-state homes from the classes inventory's one constant rule (INV-21). */
export function classLiveHomes(classes) {
  if (!classes?.ok || classes.rows.length === 0) return [];
  const first = classes.rows[0];
  return [first.home, first.secondaryHome].filter((h) => typeof h === "string");
}

/**
 * The /docs/cat/classes view (#4592 INV-19): skill cards then class cards, each
 * set grouped by stage inside its own Generated frame; live rail = the class
 * home rule; source rail = both inventory files.
 */
export default function ClassesSkills() {
  const classes = loadInventory("classes");
  const skills = loadInventory("skills");
  return {
    body: (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Classes &amp; skills</h1>
        <p className="text-sm text-zinc-400">
          The dispatch-class alphabet (scripts/autopilot/classes.json) and the playbook fleet it dispatches — grouped by
          lifecycle stage. The brain stage is the autopilot loop itself; operator-interactive skills are dispatched by no
          class.
        </p>
        <Generated family="skills" inventory={skills} title="Skills by stage">
          {skills.ok && <SkillGroups rows={skills.rows} />}
        </Generated>
        <Generated family="classes" inventory={classes} title="Dispatch classes by stage">
          {classes.ok && <ClassGroups rows={classes.rows} />}
        </Generated>
      </div>
    ),
    live: classLiveHomes(classes),
    source: (
      <div className="space-y-2">
        <SourceRail family="classes" inventory={classes} />
        <SourceRail family="skills" inventory={skills} />
      </div>
    ),
  };
}
