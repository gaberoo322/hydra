/**
 * Shared shapes for the per-bucket attention line modules (issue #5615,
 * ADR-0034 §8). A bucket module builds `Draft`s and names its own failed
 * sources; the composer in src/attention.ts owns evidence accounting, registry
 * action resolution, the ledger reconcile and the drain-order sort.
 */

import type { Bucket } from "../schemas/operator-actions.ts";
import type { AttentionFeedItem } from "../schemas/attention.ts";
import type { ActionContext } from "./actions.ts";

export type ItemBase = Omit<AttentionFeedItem, "bucket" | "rank" | "key" | "action" | "subLines">;

export interface Draft {
  key: string;
  context: ActionContext;
  base: ItemBase;
  subLines?: { key: string; line: string; detail: string }[];
}

/**
 * The uniform read shape every bucket module returns. A failed read NEVER
 * yields drafts with an empty `sourceErrors` (never an asserted zero).
 */
export interface BucketRead {
  drafts: Draft[];
  /** Proof the lookup ran (rows scanned), NOT the admitted count. */
  scanned: number;
  /** Named failed sources; non-empty renders the bucket UNKNOWN. */
  sourceErrors: string[];
}

/**
 * Run `fn` and settle it — a synchronous throw from an injected dep is
 * captured as a rejection too, so no source can escape the never-throw
 * contract.
 */
export async function settle<T>(fn: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await fn() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

export function bucketOf(key: string): Bucket {
  return key.slice(0, key.indexOf(":")) as Bucket;
}
