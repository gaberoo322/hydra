/**
 * Sentry Instrumentation — must be imported FIRST before any other modules.
 *
 * Captures:
 *   - Unhandled exceptions and rejections
 *   - Express route errors
 *   - Redis connection failures
 *   - Agent timeouts and crashes
 *   - Cycle failures
 */

import * as Sentry from "@sentry/node";

import { logger } from "./logger.ts";

const SENTRY_DSN = process.env.SENTRY_DSN || "";

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    release: `hydra@${process.env.HYDRA_VERSION || "1.0.0"}`,

    // Capture 100% of errors, 10% of transactions
    tracesSampleRate: 0.1,

    // Tag all events with hydra metadata
    initialScope: {
      tags: {
        service: "hydra-orchestrator",
      },
    },
  });

  logger.info({ component: "sentry" }, "Sentry initialized for hydra-orchestrator");
} else {
  logger.info({ component: "sentry" }, "Sentry skipped — no SENTRY_DSN configured");
}

export { Sentry };
