// The GENERATED frame (#4590, ADR-0034 §10 trust rules 2-4). Every block
// derived from a docs/generated/<family>.json inventory renders inside it:
// dashed cyan border, a GENERATED badge, optional title, row count, and a
// header naming the inventory file and its extractor. Both names are DERIVED
// from the family string, never hand-typed per block, so the header stays true
// for every later family. Prose never uses this frame.
//
// `inventory` is the result of parseInventory(): when it is not ok, the frame
// renders the explicit 'inventory unavailable' state instead of its children —
// never an empty table (trust rule 4).

import { inventoryFile, extractorFile } from "./inventories.js";

export default function Generated({ family, title, inventory, children }) {
  if (!inventory || !inventory.ok) {
    return (
      <div
        data-testid="inventory-unavailable"
        className="rounded border border-amber-700 bg-amber-950/30 p-3 text-sm text-amber-300"
      >
        inventory unavailable: {inventoryFile(family)} missing or unparseable
      </div>
    );
  }
  return (
    <section className="rounded-md border border-dashed border-cyan-800/70 bg-cyan-950/10">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-dashed border-cyan-800/70 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="rounded bg-cyan-900/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cyan-300">
            generated
          </span>
          {title && <span className="text-sm font-medium text-zinc-200">{title}</span>}
          <span className="text-xs text-zinc-500">{inventory.rows.length} rows</span>
        </div>
        <span className="font-mono text-[11px] text-cyan-700">
          {`${inventoryFile(family)} ← ${extractorFile(family)}`}
        </span>
      </header>
      <div className="overflow-x-auto p-3">{children}</div>
    </section>
  );
}

/**
 * The rail Source section for one inventory family (#4592): the committed
 * file plus its generatedFrom globs. Shared by the code-imported catalogue
 * views (Docs.jsx) and the classes/skills views (ClassesSkills.jsx).
 */
export function SourceRail({ family, inventory }) {
  return (
    <div className="space-y-1 font-mono text-[11px] text-zinc-500">
      <div>{inventoryFile(family)}</div>
      {inventory?.ok && inventory.generatedFrom.length > 0 && (
        <div>
          <div className="text-zinc-600">generated from</div>
          <ul>
            {inventory.generatedFrom.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
