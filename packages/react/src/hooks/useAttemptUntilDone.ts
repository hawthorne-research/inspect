import { useEffect, useRef } from "react";

/**
 * Calls `attempt` after each commit until it returns true, then not again
 * until `key` changes. A null `key` does nothing and forgets the last done
 * key, so the same key later runs again.
 *
 * For one-off work that waits on data arriving over several renders, such
 * as landing a deep link once its target has rendered: `attempt` returns
 * false while it can't act yet.
 */
export function useAttemptUntilDone(
  key: string | null,
  attempt: () => boolean
): void {
  const done = useRef<string | null>(null);
  // Every commit, by design: what `attempt` waits for can arrive with any
  // render, and it is a cheap no-op once done.
  useEffect(() => {
    if (key === null) {
      done.current = null;
      return;
    }
    if (done.current !== key && attempt()) done.current = key;
  });
}
