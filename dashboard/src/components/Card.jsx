export default function Card({ title, children, className = "" }) {
  return (
    <div className={`bg-zinc-900 border border-zinc-800 rounded-lg p-4 ${className}`}>
      {title && (
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{title}</h3>
      )}
      {children}
    </div>
  );
}
