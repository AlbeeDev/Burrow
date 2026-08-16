/**
 * The browser end of the Claude → Burrow push.
 *
 * Scoped to ONE project at a time on purpose: a push is a thing the model wanted *you* to look
 * at, so it belongs to the view you are in, not to a global tray. A push that arrives while
 * you're looking elsewhere is not lost: the gateway keeps a short per-project history and this
 * refetches it whenever the project (or the connection) changes, which is also what makes a
 * reload or a late-attaching second browser catch up.
 *
 * The wire names (`images.recent`, `image.push`) are v1's and deliberately unchanged: renaming
 * them would churn the protocol for no behavioural gain. What changed in v2 is the payload, 
 * metadata, not bytes.
 */
import { useCallback, useEffect, useState } from "react";
import type { PushedItem } from "./gateway";
import { useGateway } from "./useGateway";

export type PushFeed = {
  items: PushedItem[]; // newest first
  open: boolean;
  index: number;
  show: (at?: number) => void;
  close: () => void;
  step: (delta: number) => void;
};

export function usePushes(project: string | null): PushFeed {
  const { gateway, status } = useGateway();
  const [items, setItems] = useState<PushedItem[]>([]);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  // Whatever the gateway already has for this project.
  useEffect(() => {
    setItems([]);
    setOpen(false);
    setIndex(0);
    if (status !== "ready") return;
    let live = true;
    gateway
.req<{ images: PushedItem[] }>("images.recent", { project })
.then((r) => {
        if (live) setItems(r.images ?? []);
      })
.catch(() => {});
    return () => {
      live = false;
    };
  }, [gateway, status, project]);

  // A push for the project on screen opens itself, that is the whole point of the feature.
  useEffect(
    () =>
      gateway.on("image.push", (payload: { project: string | null; image: PushedItem }) => {
        if ((payload.project ?? null) !== project) return;
        setItems((prev) => [payload.image, ...prev.filter((i) => i.id !== payload.image.id)]);
        setIndex(0);
        setOpen(true);
      }),
    [gateway, project],
  );

  // The strip changed with nothing new arriving, Claude tidied up (`unshow`). Refetch, and
  // deliberately do NOT open anything: a removal must never put something on your screen.
  useEffect(
    () =>
      gateway.on("push.changed", (payload: { project: string | null }) => {
        if ((payload.project ?? null) !== project) return;
        gateway
.req<{ images: PushedItem[] }>("images.recent", { project })
.then((r) => setItems(r.images ?? []))
.catch(() => {});
      }),
    [gateway, project],
  );

  const show = useCallback((at = 0) => {
    setIndex(at);
    setOpen(true);
  }, []);

  const step = useCallback(
    (delta: number) => setIndex((i) => Math.min(items.length - 1, Math.max(0, i + delta))),
    [items.length],
  );

  return { items, open, index, show, close: () => setOpen(false), step };
}
