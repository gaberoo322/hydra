import Sidebar from "./Sidebar.jsx";
import VersionBadge from "./VersionBadge.jsx";

/**
 * The app shell: sidebar + scrolling content well.
 *
 * The content well is a column so `VersionBadge` (issue #3681) can sit at the
 * bottom of EVERY route as a sticky strip — the always-on half of the versions
 * surface, paired with the Today-page `Versions` panel it links into.
 */
export default function Layout({ children, connected }) {
  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar connected={connected} />
      <main className="flex-1 flex flex-col overflow-y-auto">
        <div className="flex-1 p-6">
          <div className="animate-fade-in">
            {children}
          </div>
        </div>
        <VersionBadge />
      </main>
    </div>
  );
}
