import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plugs, CircleNotch } from "@phosphor-icons/react";
import { useGateway } from "../lib/useGateway";

/**
 * Enable/disable which MCP servers THIS project's bubble Claude can use (per-project, 
 * saving never touches other projects). Save persists the list and recycles the project's
 * persistent process; the button shows a spinner until the server confirms.
 */
export function McpModal({ project, onClose }: { project: string | null; onClose: () => void }) {
  const { gateway } = useGateway();
  const [servers, setServers] = useState<string[] | null>(null); // null = loading
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    gateway
.req<{ servers: string[]; disabled: string[] }>("mcp.list", { project })
.then((r) => {
        if (cancelled) return;
        setServers(r.servers ?? []);
        setDisabled(new Set(r.disabled ?? []));
      })
.catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [gateway, project]);

  function toggle(name: string) {
    setDisabled((d) => {
      const n = new Set(d);
      n.has(name) ? n.delete(name): n.add(name);
      return n;
    });
  }

  function save() {
    setSaving(true);
    setError(null);
    gateway
.req<{ disabled: string[] }>("mcp.set_disabled", { project, disabled: [...disabled] })
.then(() => onClose())
.catch((e) => {
        setSaving(false);
        setError(e.message);
      });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2">
            <Plugs size={18} weight="fill" className="text-accent" />
            <div>
              <h2 className="text-base font-semibold text-ink">MCP servers</h2>
              <p className="text-xs text-faint">
                For <span className="font-mono text-muted">{project ?? "master"}</span> only, other
                projects keep their own set.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            <X size={18} weight="bold" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {servers === null ? (
            <p className="p-3 text-sm text-faint">Loading…</p>
          ): servers.length === 0 ? (
            <p className="p-3 text-sm text-faint">No MCP servers configured.</p>
          ): (
            servers.map((name) => {
              const on = !disabled.has(name);
              return (
                <button
                  key={name}
                  onClick={() => toggle(name)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-raised"
                >
                  <span
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                      on ? "bg-accent": "bg-line"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 size-4 rounded-full bg-bg transition-all ${
                        on ? "left-[18px]": "left-0.5"
                      }`}
                    />
                  </span>
                  <span className={`flex-1 font-mono text-sm ${on ? "text-ink": "text-faint"}`}>
                    {name}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-faint">
                    {on ? "on": "off"}
                  </span>
                </button>
              );
            })
          )}
          {error && <p className="px-3 py-2 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
          <span className="text-xs text-faint">
            {servers ? `${servers.length - disabled.size}/${servers.length} enabled`: ""}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-line px-4 py-1.5 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || servers === null}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-bg disabled:opacity-60"
            >
              {saving && <CircleNotch size={14} weight="bold" className="animate-spin" />}
              {saving ? "Applying…": "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
