"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PlatformIcon } from "@/components/PlatformIcon";

interface SessionEntry {
  session_id: string;
  source: string;
  project_path: string;
  started_at: string;
  total_tokens: number;
  total_cost_usd: number;
  turn_count: number;
  llm_call_count: number;
  tool_call_count: number;
}

interface IndexData {
  session_count: number;
  total_tokens: number;
  total_cost_usd: number;
  sources: { source: string; count: number }[];
  sessions: SessionEntry[];
}

function fmt(n: number) { return n.toLocaleString(); }
function fmtCost(n: number) { return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`; }

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat-tile">
      <p className="stat-tile-label">{label}</p>
      <p className="stat-tile-value">{value}</p>
      {hint && <p className="text-[11px] text-muted mt-1">{hint}</p>}
    </div>
  );
}

const SOURCE_ACCENT: Record<string, string> = {
  "claude-code": "linear-gradient(135deg, rgba(107,93,255,0.15), rgba(107,93,255,0.05))",
  codex: "linear-gradient(135deg, rgba(45,190,168,0.15), rgba(45,190,168,0.05))",
  openclaw: "linear-gradient(135deg, rgba(255,138,92,0.15), rgba(255,138,92,0.05))",
};

function platformPill(source: string) {
  return (
    <span
      className="pill"
      style={{ backgroundImage: SOURCE_ACCENT[source] ?? "none" }}
    >
      <PlatformIcon source={source} size={11} />
      {source}
    </span>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<IndexData | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [sort, setSort] = useState<"cost" | "tokens" | "date">("date");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => {
        if (!r.ok) throw new Error("No data");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16">
        <p className="eyebrow mb-2">Sessions</p>
        <h1 className="text-3xl font-semibold tracking-tight mb-4">Dashboard</h1>
        <div className="card p-6 text-sm">
          <p className="font-semibold mb-2">No data found</p>
          <p className="text-muted">Run the index builder first:</p>
          <pre className="codeblock mt-3 text-xs">
            bash ~/.claude/skills/costea/scripts/update-index.sh
          </pre>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12 animate-pulse">
        <div className="h-3 w-20 bg-surface-warm rounded mb-3" />
        <div className="h-9 w-48 bg-surface-warm rounded mb-2" />
        <div className="h-3 w-64 bg-surface-warm rounded mb-8" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="stat-tile">
              <div className="h-2 w-16 bg-surface-warm rounded" />
              <div className="h-7 w-24 bg-surface-warm rounded mt-3" />
            </div>
          ))}
        </div>
        <div className="card h-[480px]" />
      </div>
    );
  }

  const sessions = data.sessions
    .filter((s) => filter === "all" || s.source === filter)
    .filter((s) => !query || s.session_id.includes(query) || s.project_path?.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      if (sort === "cost") return (b.total_cost_usd || 0) - (a.total_cost_usd || 0);
      if (sort === "tokens") return (b.total_tokens || 0) - (a.total_tokens || 0);
      return (b.started_at || "").localeCompare(a.started_at || "");
    });

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-8">
        <p className="eyebrow mb-2">Sessions</p>
        <h1 className="text-4xl font-semibold tracking-tight">Ledger</h1>
        <p className="text-sm text-muted mt-2">
          Every agent session indexed, grouped by platform, sorted by whatever you care about.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total cost" value={fmtCost(data.total_cost_usd)} hint={`${fmt(data.session_count)} sessions`} />
        <StatCard label="Total tokens" value={fmt(data.total_tokens)} hint="cumulative" />
        <StatCard label="Avg / session" value={fmtCost(data.session_count ? data.total_cost_usd / data.session_count : 0)} />
        <div className="stat-tile">
          <p className="stat-tile-label">Platforms</p>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {data.sources.map((s) => (
              <span key={s.source} className="pill" style={{ backgroundImage: SOURCE_ACCENT[s.source] ?? "none" }}>
                <PlatformIcon source={s.source} size={11} />
                {s.source} · {s.count}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by id or project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-[200px] px-3 py-2 bg-surface-elevated border border-border-soft rounded-[var(--radius-md)] text-sm focus:outline-none focus:border-foreground/40 transition-colors"
        />
        <div className="flex items-center gap-2 text-sm">
          <span className="eyebrow">Filter</span>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-sm border border-border-soft rounded-[var(--radius-md)] px-2 py-2 bg-surface-elevated"
          >
            <option value="all">All platforms</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex CLI</option>
            <option value="openclaw">OpenClaw</option>
          </select>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="eyebrow">Sort</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="text-sm border border-border-soft rounded-[var(--radius-md)] px-2 py-2 bg-surface-elevated"
          >
            <option value="date">Date (recent)</option>
            <option value="cost">Cost (high)</option>
            <option value="tokens">Tokens (high)</option>
          </select>
        </div>
        <span className="text-xs text-muted ml-auto">{sessions.length} sessions</span>
      </div>

      {/* Session table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated">
              <tr className="text-left eyebrow">
                <th className="py-3 px-5">Session</th>
                <th className="py-3 px-5">Platform</th>
                <th className="py-3 px-5 text-right">Turns</th>
                <th className="py-3 px-5 text-right">Tokens</th>
                <th className="py-3 px-5 text-right">Cost</th>
                <th className="py-3 px-5">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-soft)]">
              {sessions.slice(0, 100).map((s) => (
                <tr key={s.session_id} className="hover:bg-surface-elevated/50 transition-colors">
                  <td className="py-3 px-5">
                    <Link
                      href={`/session/${s.session_id}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {s.session_id.slice(0, 10)}…
                    </Link>
                    {s.project_path && (
                      <p className="text-[10px] text-muted mt-0.5 truncate max-w-[220px]">
                        {s.project_path.replace(/.*\//, "")}
                      </p>
                    )}
                  </td>
                  <td className="py-3 px-5">{platformPill(s.source)}</td>
                  <td className="py-3 px-5 font-mono text-xs text-right">{s.turn_count}</td>
                  <td className="py-3 px-5 font-mono text-xs text-right">{fmt(s.total_tokens)}</td>
                  <td className="py-3 px-5 font-mono text-xs font-medium text-right">{fmtCost(s.total_cost_usd)}</td>
                  <td className="py-3 px-5 text-xs text-muted">{s.started_at?.slice(0, 10) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
