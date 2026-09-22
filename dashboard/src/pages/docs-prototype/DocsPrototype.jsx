// PROTOTYPE — wayfinder #4545 (map #4537). Throwaway; lives on branch
// prototype/docs-4545 only.
//
// "Three variants of the /docs reference page, switchable via ?variant=A|B|C,
//  on a new /docs/* route inside the real cockpit Layout + Sidebar, fed by a
//  one-shot fixture of real generated inventories and marked-rendered corpus."
//
// Judge: can a reader get from "what is the autopilot?" to the class table,
// its skill, its playbook, and the Now page that shows it running, without
// leaving the page except on purpose?
import { useParams, useSearchParams } from "react-router-dom";
import PrototypeSwitcher from "../../components/PrototypeSwitcher.jsx";
import VariantA from "./VariantA.jsx";
import VariantB from "./VariantB.jsx";
import VariantC from "./VariantC.jsx";

const VARIANTS = [
  { key: "A", name: "Manual — tree · page · on-this-page", C: VariantA },
  { key: "B", name: "Atlas — areas-first hub, no tree", C: VariantB },
  { key: "C", name: "Index — name list + relations panel", C: VariantC },
];

export default function DocsPrototype() {
  const splat = useParams()["*"] ?? "";
  const [params] = useSearchParams();
  const v = VARIANTS.find((x) => x.key === params.get("variant")) ?? VARIANTS[0];
  const V = v.C;
  return (
    <div className="-m-6 min-h-screen" data-testid="docs-prototype">
      <V viewKey={splat.replace(/\/$/, "")} q={params.get("q") ?? ""} />
      <PrototypeSwitcher variants={VARIANTS} />
    </div>
  );
}
