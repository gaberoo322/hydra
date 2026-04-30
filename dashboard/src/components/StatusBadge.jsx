const COLORS = {
  running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  completed: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  merged: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  "rolled-back": "bg-orange-500/20 text-orange-400 border-orange-500/30",
  abandoned: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  blocked: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  pending: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
  approved: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  idle: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

export default function StatusBadge({ status }) {
  const classes = COLORS[status] || COLORS.pending;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded border ${classes}`}>
      {status}
    </span>
  );
}
