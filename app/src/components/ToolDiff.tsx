/**
 * Renders a file-edit tool call as a colored diff (like Claude Code's), from the tool
 * input we already have: Edit → old_string vs new_string, MultiEdit → each edit, Write →
 * the new content as additions. Falls back to nothing for other tools.
 */

type Row = { t: " " | "-" | "+"; line: string };

const MAX_ROWS = 80;

/** Line-level LCS diff, with a size guard for very large inputs. */
function lineDiff(oldStr: string, newStr: string): Row[] {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const m = a.length;
  const n = b.length;

  // Guard against O(m*n) blowups on huge edits: just show all-removed + all-added.
  if (m * n > 200_000) {
    return [...a.map((line): Row => ({ t: "-", line })), ...b.map((line): Row => ({ t: "+", line }))];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1: Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);

  const out: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) out.push({ t: " ", line: a[i]! }), i++, j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: "-", line: a[i]! }), i++;
    else out.push({ t: "+", line: b[j]! }), j++;
  }
  while (i < m) out.push({ t: "-", line: a[i++]! });
  while (j < n) out.push({ t: "+", line: b[j++]! });
  return out;
}

function toBlocks(name: string, input: any): Row[][] {
  if (name === "Edit") return [lineDiff(String(input?.old_string ?? ""), String(input?.new_string ?? ""))];
  if (name === "MultiEdit" && Array.isArray(input?.edits))
    return input.edits.map((e: any) => lineDiff(String(e?.old_string ?? ""), String(e?.new_string ?? "")));
  if (name === "Write")
    return [String(input?.content ?? "").split("\n").map((line): Row => ({ t: "+", line }))];
  return [];
}

export function isDiffTool(name: string): boolean {
  return name === "Edit" || name === "MultiEdit" || name === "Write";
}

/** Mechanical added/removed line counts, computed from the tool data (not Claude's text). */
export function diffStats(name: string, input: unknown): { added: number; removed: number } | null {
  if (!isDiffTool(name)) return null;
  let added = 0;
  let removed = 0;
  for (const rows of toBlocks(name, input))
    for (const r of rows) {
      if (r.t === "+") added++;
      else if (r.t === "-") removed++;
    }
  return { added, removed };
}

export function ToolDiff({ name, input }: { name: string; input: unknown }) {
  const blocks = toBlocks(name, input);
  return (
    <div className="space-y-2">
      {blocks.map((rows, bi) => {
        const shown = rows.slice(0, MAX_ROWS);
        const hidden = rows.length - shown.length;
        return (
          <pre
            key={bi}
            className="overflow-x-auto rounded-lg border border-line bg-[#0d0b07] p-2 font-mono text-[11px] leading-[1.5]"
          >
            {shown.map((r, i) => (
              <div
                key={i}
                className={
                  r.t === "+"
                    ? "bg-ok/10 text-ok"
: r.t === "-"
                      ? "bg-danger/10 text-danger"
: "text-faint"
                }
              >
                <span className="select-none opacity-60">{r.t}</span>
                {" " + r.line}
              </div>
            ))}
            {hidden > 0 && <div className="text-faint">… {hidden} more lines</div>}
          </pre>
        );
      })}
    </div>
  );
}
