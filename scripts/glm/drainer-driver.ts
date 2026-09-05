/**
 * Thin CLI entrypoint for the GLM dev-drainer's bash↔TypeScript bridge
 * (issue #4371). All logic lives in `src/glm/drainer-driver.ts::runDriverMode`
 * (the `scripts/tier-classify.ts` → `src/tier-classifier.ts` precedent); this
 * file only maps argv -> outcome -> stdout/stderr/exit code.
 *
 * Invoked by scripts/glm/drainer-loop.sh's run_driver():
 *   node --experimental-strip-types scripts/glm/drainer-driver.ts <mode> [...args]
 */
import { isDriverFailure, runDriverMode } from "../../src/glm/drainer-driver.ts";

const outcome = await runDriverMode(process.argv.slice(2));
if (isDriverFailure(outcome)) {
  process.stderr.write("glm-drainer driver threw: " + outcome.message + "\n");
  process.exit(1);
} else {
  process.stdout.write(outcome.line + "\n");
  process.exit(outcome.exitCode);
}
