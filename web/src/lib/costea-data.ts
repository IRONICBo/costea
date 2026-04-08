import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { homedir } from "os";

const COSTEA_DIR = path.join(homedir(), ".costea");
const SESSIONS_DIR = path.join(COSTEA_DIR, "sessions");
const INDEX_FILE = path.join(COSTEA_DIR, "index.json");

export interface SessionIndex {
  updated_at: string;
  session_count: number;
  total_tokens: number;
  total_cost_usd: number;
  sources: { source: string; count: number }[];
  sessions: SessionEntry[];
}

export interface SessionEntry {
  session_id: string;
  source: string;
  project_path: string;
  started_at: string;
  ended_at: string;
  turn_count: number;
  llm_call_count: number;
  tool_call_count: number;
  total_tokens: number;
  total_cost_usd: number;
  subagent_count: number;
}

export interface SessionSummary {
  session_id: string;
  source: string;
  project_path: string;
  started_at: string;
  ended_at: string;
  turn_count: number;
  llm_call_count: number;
  tool_call_count: number;
  token_usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total: number;
    subagent_total: number;
    grand_total: number;
  };
  cost: {
    total_usd: number;
    parent_usd: number;
    subagent_usd: number;
    by_model: Record<string, number>;
  };
  by_model: {
    model: string;
    call_count: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cost_usd: number;
  }[];
  by_skill: { skill: string; turns: number; tokens: number; cost_usd: number }[];
  top_tools: { tool: string; calls: number; category: string }[];
  reasoning_vs_tools: {
    reasoning_turns: number;
    reasoning_tokens: number;
    tool_inv_turns: number;
    tool_inv_tokens: number;
    reasoning_pct: number;
  };
  subagents: {
    count: number;
    total_tokens: number;
    total_cost_usd: number;
    agents: { agent_id: string; tokens: number; cost_usd: number; llm_call_count: number }[];
  };
  top_turns_by_cost: {
    turn_id: string;
    prompt: string;
    tokens: number;
    cost_usd: number;
    timestamp: string;
  }[];
}

export interface TurnRecord {
  turn_id: string;
  session_id: string;
  source: string;
  timestamp: string;
  user_prompt: string;
  is_skill: boolean;
  skill_name: string | null;
  token_usage: { input: number; output: number; cache_read: number; cache_write: number; total: number };
  cost: { total_usd: number; by_model: Record<string, number> };
  tools_summary: { total_calls: number; by_tool: Record<string, number> };
  llm_call_count: number;
}

export interface LLMCallRecord {
  call_id: string;
  session_id: string;
  agent_id: string | null;
  turn_id: string;
  source: string;
  timestamp: string;
  model: string;
  model_short: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  cost_usd: number;
  stop_reason: string;
  is_reasoning_turn: boolean;
  tool_calls: { tool_name: string; tool_use_id: string }[];
  dedup_siblings: number;
}

/** Read and parse a JSONL file into an array of records */
async function readJSONL<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean) as T[];
}

/** Get the global session index */
export async function getIndex(): Promise<SessionIndex | null> {
  if (!existsSync(INDEX_FILE)) return null;
  const raw = await readFile(INDEX_FILE, "utf-8");
  return JSON.parse(raw);
}

/** Get summary for a single session */
export async function getSessionSummary(sessionId: string): Promise<SessionSummary | null> {
  const summaryPath = path.join(SESSIONS_DIR, sessionId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  const raw = await readFile(summaryPath, "utf-8");
  return JSON.parse(raw);
}

/** Get turn records for a session */
export async function getSessionTurns(sessionId: string): Promise<TurnRecord[]> {
  return readJSONL<TurnRecord>(path.join(SESSIONS_DIR, sessionId, "session.jsonl"));
}

/** Get LLM call records for a session */
export async function getSessionCalls(sessionId: string): Promise<LLMCallRecord[]> {
  return readJSONL<LLMCallRecord>(path.join(SESSIONS_DIR, sessionId, "llm-calls.jsonl"));
}

/** Get aggregated stats across all sessions */
export async function getAggregatedStats() {
  const index = await getIndex();
  if (!index || index.sessions.length === 0) {
    return { totalCost: 0, totalTokens: 0, sessionCount: 0, sources: [], byModel: {}, byDay: [] };
  }

  const byModel: Record<string, { tokens: number; cost: number; sessions: number }> = {};
  const byDay: Record<string, { date: string; cost: number; tokens: number; sessions: number }> = {};

  for (const s of index.sessions) {
    // by day
    const day = s.started_at?.slice(0, 10) || "unknown";
    if (!byDay[day]) byDay[day] = { date: day, cost: 0, tokens: 0, sessions: 0 };
    byDay[day].cost += s.total_cost_usd || 0;
    byDay[day].tokens += s.total_tokens || 0;
    byDay[day].sessions += 1;
  }

  // Load summaries for model breakdown (only first 50 to avoid slowness)
  const sessionIds = index.sessions.slice(0, 50).map((s) => s.session_id);
  for (const sid of sessionIds) {
    const summary = await getSessionSummary(sid);
    if (!summary) continue;
    for (const m of summary.by_model || []) {
      if (!byModel[m.model]) byModel[m.model] = { tokens: 0, cost: 0, sessions: 0 };
      byModel[m.model].tokens += (m.input || 0) + (m.output || 0);
      byModel[m.model].cost += m.cost_usd || 0;
      byModel[m.model].sessions += 1;
    }
  }

  return {
    totalCost: index.total_cost_usd,
    totalTokens: index.total_tokens,
    sessionCount: index.session_count,
    sources: index.sources,
    byModel,
    byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
