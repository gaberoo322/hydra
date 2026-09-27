import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

// /docs provenance (#4590, ADR-0034 §10 trust rule 1): the build's own commit
// and build time, baked in as constants — the page never fetches them. A
// git-less build must not fail: the SHA falls back to the literal "unknown",
// which the page renders honestly as 'commit unknown'.
function resolveBuildSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch (err) {
    console.error("[vite.config] git rev-parse HEAD failed; build SHA is 'unknown':", err?.message ?? err);
    return "unknown";
  }
}

const sha = resolveBuildSha();
const builtAt = new Date().toISOString();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "import.meta.env.HYDRA_BUILD_SHA": JSON.stringify(sha),
    "import.meta.env.HYDRA_BUILD_TIME": JSON.stringify(builtAt),
  },
  optimizeDeps: {
    include: ["react", "react-dom", "react-router-dom"],
  },
  server: {
    port: 3000,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
        rewrite: (path) => path.replace(/^\/ws/, ""),
      },
    },
  },
});
