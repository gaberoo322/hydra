import type { OperatorChannel, OperatorMessage, ChannelResult } from "../../src/operator-channel/index.ts";

/**
 * page()/brief() are private to the channel (issue #5391). The dedup-reducer
 * drives in the operator-channel tests exercise the edge-trigger state machine
 * with hand-built messages, which report() derives from the per-kind table
 * instead, so they reach the private methods through this one typed cast.
 */
export function priv(ch: OperatorChannel) {
  return ch as unknown as {
    page(msg: OperatorMessage): Promise<ChannelResult>;
    brief(msg: OperatorMessage): Promise<{ appended: boolean }>;
  };
}
