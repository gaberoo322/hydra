// PROTOTYPE — wayfinder #4545. Floating variant switcher; dev-only.
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export default function PrototypeSwitcher({ variants }) {
  const [params, setParams] = useSearchParams();
  const keys = variants.map((v) => v.key);
  const current = params.get("variant") ?? keys[0];
  const idx = Math.max(0, keys.indexOf(current));
  const go = (d) => {
    const next = new URLSearchParams(params);
    next.set("variant", keys[(idx + d + keys.length) % keys.length]);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t.closest?.("input, textarea, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (import.meta.env.PROD) return null;
  const v = variants[idx];
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-full bg-fuchsia-600 text-white shadow-2xl px-2 py-1.5 text-sm font-medium ring-2 ring-fuchsia-300">
      <button onClick={() => go(-1)} className="rounded-full w-7 h-7 hover:bg-fuchsia-500">←</button>
      <span className="px-1">PROTOTYPE · {v.key} — {v.name}</span>
      <button onClick={() => go(1)} className="rounded-full w-7 h-7 hover:bg-fuchsia-500">→</button>
    </div>
  );
}
