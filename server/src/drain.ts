/**
 * The drain decision: should a detached ephemeral session be killed yet?
 *
 * The ordering is the rule: reattached beats gone beats idle. Reattached cancels because someone
 * is looking at the session now; gone cancels because killing a name that no longer resolves could
 * reap something that reused it; idle is the only path to a kill, at or past the threshold.
 */

export type DrainInput = {
  /** Is the session live again (someone reattached)? */
  reattached: boolean;
  /** Last tmux activity in epoch MILLISECONDS, or null when the session is gone. */
  activityMs: number | null;
  /** Now, epoch ms. */
  now: number;
  /** Quiet threshold; defaults to the caller's QUIET_MS. */
  quietMs: number;
};

export type DrainVerdict =
  | { action: "cancel"; reason: "reattached" | "gone" }
  | { action: "kill"; idleMs: number }
  | { action: "wait" };

/**
 * Who is keeping a session alive: a session drains when nothing holds it any more. A hold is a
 * split panel or a single terminal view, keyed per live client; `terminal.close` means "release my
 * hold", and the drain is scheduled only when the last one goes.
 *
 * Two invariants: it is a refcount, not ownership (the same project can be open in two layouts or
 * two browsers, and closing one must not kill the other's session), and a hold belongs to a live
 * client, never to a saved layout (saved layouts persist to disk, and counting them would mean
 * their sessions never drain). Pure bookkeeping: no tmux, no timers, no disk.
 */
export class Holds {
  /** tmux session name → the holder keys keeping it alive. */
  private readonly byName = new Map<string, Set<string>>();
  /** holder key → what it holds. Holder keys are `${connId}:${viewId}`. */
  private readonly byHolder = new Map<string, { name: string; project: string | null }>();

  /**
   * Register (or move) a hold. Re-holding the same session with the same key is a no-op. Returns
   * the hold this displaced (a panel switching project); the caller must treat a displaced `last`
   * hold exactly like a release, or that session never drains.
   */
  add(
    holder: string,
    name: string,
    project: string | null,
  ): { name: string; project: string | null; last: boolean } | null {
    const prev = this.byHolder.get(holder);
    if (prev?.name === name) return null;
    const displaced = prev ? this.remove(holder): null;
    this.byHolder.set(holder, { name, project });
    let set = this.byName.get(name);
    if (!set) this.byName.set(name, (set = new Set()));
    set.add(holder);
    return displaced;
  }

  /**
   * Drop one hold. Returns what it held plus whether that was the LAST one, the caller only needs
   * to consider draining when `last` is true. Returns null for a holder that never existed, so a
   * duplicate release is harmless.
   */
  remove(holder: string): { name: string; project: string | null; last: boolean } | null {
    const entry = this.byHolder.get(holder);
    if (!entry) return null;
    this.byHolder.delete(holder);
    const set = this.byName.get(entry.name);
    set?.delete(holder);
    const last = !set || set.size === 0;
    if (last) this.byName.delete(entry.name);
    return {...entry, last };
  }

  /**
   * Drop every hold owned by a connection (its socket closed). Returns only the sessions whose LAST
   * hold went: a session another browser still holds is not in the list.
   */
  removeConn(connId: string): { name: string; project: string | null }[] {
    const prefix = `${connId}:`;
    const released: { name: string; project: string | null }[] = [];
    for (const holder of [...this.byHolder.keys()]) {
      if (!holder.startsWith(prefix)) continue;
      const gone = this.remove(holder);
      if (gone?.last) released.push({ name: gone.name, project: gone.project });
    }
    return released;
  }

  isHeld(name: string): boolean {
    return (this.byName.get(name)?.size ?? 0) > 0;
  }

  /** Holder count for a session: for audit lines and tests, not for decisions. */
  count(name: string): number {
    return this.byName.get(name)?.size ?? 0;
  }
}

export function drainVerdict(input: DrainInput): DrainVerdict {
  if (input.reattached) return { action: "cancel", reason: "reattached" };
  if (input.activityMs === null) return { action: "cancel", reason: "gone" };
  const idleMs = input.now - input.activityMs;
  // Clock skew, or a session that produced output in the same millisecond we read it, can make idle
  // negative. Negative idle is never a reason to kill, wait for the next tick.
  if (idleMs >= input.quietMs) return { action: "kill", idleMs };
  return { action: "wait" };
}
