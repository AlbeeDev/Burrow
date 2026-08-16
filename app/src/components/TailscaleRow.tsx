/**
 * The Tailscale addon's Settings row: detect, warn, do, report.
 *
 * The warning is not decoration. Turning this on changes who can reach a root shell, from
 * this machine only, to every device on your tailnet. That deserves a sentence and a deliberate
 * second click, not a switch that flips under your finger.
 *
 * Everything it can be told is shown rather than guessed at: not installed, installed but not
 * signed in, already published, or the Docker deployment where the sidecar does this instead. A row
 * that just said "unavailable" would leave someone with no idea which of those they were in.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";
import { AddonRow, type AddonStatus } from "./AddonRow";

type State =
  | { status: "container"; running: boolean }
  | { status: "absent" }
  | { status: "logged-out" }
  | { status: "ready"; host: string; url: string; serving: boolean; bin: string | null };

type Result = { ok: boolean; url?: string; message: string };

export function TailscaleRow() {
  const { gateway, status: conn } = useGateway();
  const [state, setState] = useState<State | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const load = useCallback(() => {
    if (conn !== "ready") return;
    gateway
.req<State>("tailscale.state")
.then(setState)
.catch(() => setState({ status: "absent" }));
  }, [gateway, conn]);

  useEffect(load, [load]);

  async function apply(on: boolean) {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    try {
      const r = await gateway.req<Result>("tailscale.serve", { on });
      setResult(r);
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message: "The gateway did not answer." });
    } finally {
      setBusy(false);
      load(); // re-read rather than assume the toggle landed where we asked
    }
  }

  if (!state || !state.status) return null;

  /*
   * Five internal states mapped onto the shared vocabulary, so this row and the usage row can be
   * compared at a glance instead of read. `container` is "off" rather than "problem": nothing is
   * wrong, this deployment simply solves the same problem a different way.
   */
  const STATUS: Record<State["status"], AddonStatus> = {
    container: "off", // refined below: a sidecar that is actually running is "on"
    absent: "absent",
    "logged-out": "setup",
    ready: "off", // refined below once we know whether it is actually serving
  };
  const addonStatus: AddonStatus =
    state.status === "ready"
      ? state.serving
        ? "on": "off": state.status === "container"
        ? state.running
          ? "on": "setup": (STATUS[state.status] ?? "absent");

  const check = () => {
    setChecking(true);
    load();
    // The probe is fast; this is only so the spinner is visible rather than a flicker.
    setTimeout(() => setChecking(false), 400);
  };

  return (
    <AddonRow
      title="Reachable from other devices"
      status={addonStatus}
      statusLabel={state.status === "container" && state.running ? "Sidecar": undefined}
      onCheck={state.status === "container" ? undefined: check}
      checking={checking}
      found={state.status === "ready" ? state.bin: null}
      actions={
        state.status === "ready" &&
        !busy && (
          <button
            onClick={() => (state.serving ? apply(false): setConfirming(true))}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              state.serving
                ? "border-line text-muted hover:border-danger/60 hover:text-danger": "border-accent bg-accent/10 text-accent hover:bg-accent/20"
            }`}
          >
            {state.serving ? "Stop publishing": "Publish"}
          </button>
        )
      }
    >
      {state.status === "container" ? (
        state.running ? (
          <>The Tailscale sidecar is running and publishes Burrow on your tailnet.</>
        ): (
          /*
            Checked rather than announced. This row used to state that the sidecar publishes Burrow
            full stop: written when it always ran, and a plain untruth once it became opt-in.
          */
          <>
            This deployment publishes through a Tailscale sidecar, and it isn't running. Add{" "}
            <code className="text-ink">COMPOSE_PROFILES=tailscale</code> and{" "}
            <code className="text-ink">TS_AUTHKEY</code> to <code className="text-ink">.env</code>, then{" "}
            <code className="text-ink">docker compose up -d</code>.
          </>
        )
      ): state.status === "absent" ? (
        <>
          Burrow can publish itself on a{" "}
          <a
            href="https://tailscale.com/download"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            Tailscale <ArrowSquareOut size={11} className="inline" />
          </a>{" "}
          network, so you can open it on your phone. Install it and press refresh.
        </>
      ): state.status === "logged-out" ? (
        <>
          Tailscale is installed but not signed in. Run <code className="text-ink">tailscale up</code>,
          then press refresh.
        </>
      ): state.serving ? (
        <>
          Published at{" "}
          <a
            href={state.url}
            target="_blank"
            rel="noreferrer"
            className="break-all text-accent underline underline-offset-2"
          >
            {state.url}
          </a>
        </>
      ): (
        <>
          This machine only. Publishing makes Burrow reachable from every device signed into your
          tailnet.
        </>
      )}

      {/* The deliberate second click. Says what changes, not that something will change. */}
      {confirming && state.status === "ready" && (
        <div className="mt-2.5 rounded-lg border border-[#e0a94b]/50 bg-[#e0a94b]/5 p-2.5">
          <p className="text-xs text-ink">
            Burrow gives a browser a shell on this machine. Publishing it means{" "}
            <b>anyone signed into your tailnet</b> can reach it at{" "}
            <span className="break-all font-mono">{state.url}</span>.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button onClick={() => setConfirming(false)} className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink">
              Cancel
            </button>
            <button onClick={() => apply(true)} className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-bg">
              Publish it
            </button>
          </div>
        </div>
      )}

      {busy && <p className="mt-2 text-accent">Asking Tailscale…</p>}
      {result && !busy && (
        <p className={`mt-2 whitespace-pre-line ${result.ok ? "text-muted": "text-[#e5604d]"}`}>
          {result.message}
        </p>
      )}
    </AddonRow>
  );
}
