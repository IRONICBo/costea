"use client";

import { useCallback, useEffect, useState } from "react";

interface ShareableEstimate {
  task: string;
  task_type: string;
  estimate: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_hit_pct: number;
    tool_calls: number;
    est_runtime: string;
  };
  providers: { name: string; cost: number }[];
  total_cost: number;
  best_provider: string;
  confidence: number;
  ml_method?: string;
}

/** Left-pad a string to `w` chars. */
function pad(s: string, w: number) {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function lpad(s: string, w: number) {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}
function fmtInt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

const W = 50; // inner width for receipt

function line(char = "─") {
  return char.repeat(W);
}
function row(label: string, value: string) {
  const space = W - label.length - value.length;
  return "│ " + label + " ".repeat(Math.max(space - 2, 1)) + value + " │";
}
function center(s: string) {
  const pad = Math.max(Math.floor((W - s.length) / 2), 0);
  return "│" + " ".repeat(pad) + s + " ".repeat(W - pad - s.length) + "│";
}

/** Format estimate as a plaintext receipt matching skill/receipt.sh output. */
export function plaintextReceipt(e: ShareableEstimate): string {
  const rows: string[] = [];
  rows.push("┌" + line() + "┐");
  rows.push(center("C O S T E A"));
  rows.push(center("Agent Cost Receipt"));
  rows.push("├" + line("╌") + "┤");
  rows.push(row("Task", e.task.slice(0, W - 10)));
  rows.push(row("Type", e.task_type));
  rows.push("├" + line("╌") + "┤");
  rows.push(row("Input tokens", fmtInt(e.estimate.input_tokens)));
  rows.push(row("Output tokens", fmtInt(e.estimate.output_tokens)));
  rows.push(row("Cache read", fmtInt(e.estimate.cache_read_tokens)));
  rows.push(row("Cache hit rate", `${e.estimate.cache_hit_pct}%`));
  rows.push(row("Tool calls", String(e.estimate.tool_calls)));
  rows.push(row("Est. runtime", e.estimate.est_runtime));
  rows.push("├" + line("╌") + "┤");
  rows.push("│ PROVIDER ESTIMATES" + " ".repeat(W - 19) + "│");
  for (const p of e.providers.slice(0, 5)) {
    rows.push(row(p.name, fmtCost(p.cost)));
  }
  rows.push("╞" + line("═") + "╡");
  rows.push(row("ESTIMATED TOTAL", fmtCost(e.total_cost)));
  rows.push(row("Best provider", e.best_provider));
  rows.push(row("Confidence", `${e.confidence}%`));
  if (e.ml_method) rows.push(row("Method", e.ml_method));
  rows.push("├" + line("╌") + "┤");
  rows.push(center("Proceed? [Y/N]"));
  rows.push("└" + line() + "┘");
  rows.push("");
  rows.push("— costea.app · " + new Date().toISOString().slice(0, 19).replace("T", " "));
  return rows.join("\n");
}

type Mode = "link" | "plaintext" | "json";

export function ShareEstimate({ estimate }: { estimate: ShareableEstimate }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<Mode | null>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    u.pathname = "/estimate";
    u.searchParams.set("task", estimate.task);
    setUrl(u.toString());
  }, [estimate.task]);

  const copy = useCallback(async (mode: Mode) => {
    let text = "";
    if (mode === "link") text = url;
    else if (mode === "plaintext") text = plaintextReceipt(estimate);
    else text = JSON.stringify(estimate, null, 2);

    try {
      await navigator.clipboard.writeText(text);
      setCopied(mode);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      // Fallback: select + execCommand (older browsers)
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(mode);
        setTimeout(() => setCopied(null), 1800);
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [url, estimate]);

  return (
    <div className="relative inline-flex items-center gap-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-secondary text-xs"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Share <span aria-hidden>↗</span>
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 z-50 w-72 card p-2 text-sm"
          >
            <ShareRow
              label="Copy link"
              hint="shareable URL with ?task="
              onClick={() => copy("link")}
              done={copied === "link"}
            />
            <ShareRow
              label="Copy plaintext receipt"
              hint="ASCII art, pastes into terminal/Slack"
              onClick={() => copy("plaintext")}
              done={copied === "plaintext"}
            />
            <ShareRow
              label="Copy JSON"
              hint="machine-readable — same shape as /api/estimate"
              onClick={() => copy("json")}
              done={copied === "json"}
            />
            <div className="mt-1 pt-2 border-t border-border-soft text-[10px] text-muted px-3 pb-1">
              Tip: run <span className="font-mono text-foreground/80">costea &lt;task&gt; --web</span> in the skill to jump straight here.
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ShareRow({ label, hint, onClick, done }: {
  label: string; hint: string; onClick: () => void; done: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-start justify-between gap-3 px-3 py-2 rounded-[var(--radius-sm)] hover:bg-surface-elevated text-left transition-colors"
      role="menuitem"
    >
      <div>
        <p className="font-medium text-foreground">{label}</p>
        <p className="text-[11px] text-muted mt-0.5">{hint}</p>
      </div>
      <span className={`text-[11px] shrink-0 mt-0.5 ${done ? "text-[color:var(--brand-c)]" : "text-muted-light"}`}>
        {done ? "copied!" : "copy"}
      </span>
    </button>
  );
}
