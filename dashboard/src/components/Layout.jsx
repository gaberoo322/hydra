import Sidebar from "./Sidebar.jsx";

export default function Layout({ children, connected }) {
  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar connected={connected} />
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="animate-fade-in">
          {children}
        </div>
      </main>
    </div>
  );
}
