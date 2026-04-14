"use client";

import { useEffect, useState, useCallback } from "react";

interface Manifest {
  trained_at: string;
  n_train: number;
  n_val: number;
  params: { num_trees: number; leaves: number; lr: number };
  files: Record<string, Record<string, string>>;
}

interface ActiveModel {
  source: "user" | "builtin";
  dir: string;
  manifest: Manifest;
}

interface TrainingConfig {
  enabled: boolean;
  mode: "full" | "incremental";
  schedule: { type: "daily" | "weekly"; day?: number; hour: number; minute: number };
  trigger: { min_new_tasks: number };
  params: { num_trees: number; incremental_trees: number; leaves: number; min_tasks: number };
  last_run: { timestamp: string; mode: string; tasks: number; duration_ms: number; status: string } | null;
}

interface HistoryEntry {
  timestamp: string;
  mode: string;
  tasks: number;
  duration_ms: number;
  status: string;
  trigger: string;
  error?: string;
}

interface StatusData {
  active_model: ActiveModel | null;
  builtin_available: boolean;
  config: TrainingConfig;
  task_count: number;
  new_tasks_since: number;
  history: HistoryEntry[];
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function treeCount(manifest: Manifest) {
  let total = 0;
  for (const tgt of Object.values(manifest.files)) {
    total += Object.keys(tgt).length;
  }
  // Each file is one quantile head with many trees — approximate from params
  return `${Object.keys(manifest.files).length * 3} heads`;
}

export default function TrainingPage() {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [training, setTraining] = useState(false);
  const [trainResult, setTrainResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<TrainingConfig | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/training");
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const d = await r.json();
      setData(d);
      setConfig(d.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function handleTrain(mode: "full" | "incremental") {
    setTraining(true);
    setTrainResult(null);
    try {
      const r = await fetch("/api/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const result = await r.json();
      if (result.ok) {
        setTrainResult(`Training completed in ${fmtDuration(result.record.duration_ms)}`);
        fetchStatus();
      } else {
        setTrainResult(`Training failed: ${result.record?.error || result.stderr?.slice(-200) || "unknown error"}`);
      }
    } catch (e) {
      setTrainResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTraining(false);
    }
  }

  async function handleReset() {
    if (!confirm("Reset to built-in model? Your local trained model will be deleted.")) return;
    try {
      const r = await fetch("/api/training", { method: "DELETE" });
      if (!r.ok) throw new Error("Reset failed");
      fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveConfig() {
    if (!config) return;
    setSaving(true);
    try {
      const r = await fetch("/api/training", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (!r.ok) throw new Error("Save failed");
      const result = await r.json();
      setConfig(result.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <div className="p-8 text-red-600">Error: {error}</div>;
  if (!data || !config) return <div className="p-8 text-muted">Loading...</div>;

  const model = data.active_model;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">Training Configuration</h1>

      {/* Model Status */}
      <section className="bg-surface rounded-lg border border-border p-6 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Model Status</h2>
        {model ? (
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <div className="text-muted">Active model</div>
            <div className="font-mono text-xs">
              {model.source === "user" ? "~/.costea/models/" : "built-in"}
              <span className="ml-2 px-1.5 py-0.5 bg-surface-warm rounded text-[10px] uppercase">{model.source}</span>
            </div>
            <div className="text-muted">Trained at</div>
            <div>{fmtDate(model.manifest.trained_at)}</div>
            <div className="text-muted">Training data</div>
            <div>{model.manifest.n_train.toLocaleString()} tasks</div>
            <div className="text-muted">Quantile heads</div>
            <div>{treeCount(model.manifest)}</div>
            <div className="text-muted">Current task count</div>
            <div>
              {data.task_count.toLocaleString()}
              {data.new_tasks_since > 0 && (
                <span className="ml-2 text-xs text-muted">
                  (+{data.new_tasks_since} since training)
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">No model loaded. Train one or install the built-in model.</p>
        )}
      </section>

      {/* Quick Actions */}
      <section className="bg-surface rounded-lg border border-border p-6 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Quick Actions</h2>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => handleTrain("full")}
            disabled={training}
            className="px-4 py-2 bg-accent text-surface rounded text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
          >
            {training ? "Training..." : "Full Retrain"}
          </button>
          <button
            onClick={() => handleTrain("incremental")}
            disabled={training || !model}
            className="px-4 py-2 bg-accent text-surface rounded text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
          >
            {training ? "Training..." : "Incremental Update"}
          </button>
          <button
            onClick={handleReset}
            disabled={training || model?.source !== "user"}
            className="px-4 py-2 border border-border rounded text-sm hover:bg-surface-warm transition-colors disabled:opacity-40"
          >
            Reset to Built-in
          </button>
        </div>
        {trainResult && (
          <p className={`text-sm ${trainResult.startsWith("Training completed") ? "text-green-700" : "text-red-600"}`}>
            {trainResult}
          </p>
        )}
      </section>

      {/* Schedule Configuration */}
      <section className="bg-surface rounded-lg border border-border p-6 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Scheduled Training</h2>

        <label className="flex items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
            className="w-4 h-4"
          />
          Enable auto-training
        </label>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <label className="text-muted text-xs uppercase">Mode</label>
            <select
              value={config.mode}
              onChange={(e) => setConfig({ ...config, mode: e.target.value as "full" | "incremental" })}
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            >
              <option value="full">Full retrain</option>
              <option value="incremental">Incremental update</option>
            </select>
          </div>
          <div>
            <label className="text-muted text-xs uppercase">Schedule</label>
            <select
              value={config.schedule.type}
              onChange={(e) =>
                setConfig({ ...config, schedule: { ...config.schedule, type: e.target.value as "daily" | "weekly" } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          {config.schedule.type === "weekly" && (
            <div>
              <label className="text-muted text-xs uppercase">Day</label>
              <select
                value={config.schedule.day ?? 0}
                onChange={(e) =>
                  setConfig({ ...config, schedule: { ...config.schedule, day: parseInt(e.target.value) } })
                }
                className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
              >
                {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-muted text-xs uppercase">Hour (UTC)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={config.schedule.hour}
              onChange={(e) =>
                setConfig({ ...config, schedule: { ...config.schedule, hour: parseInt(e.target.value) || 0 } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm pt-2 border-t border-border">
          <div>
            <label className="text-muted text-xs uppercase">New task threshold</label>
            <input
              type="number"
              min={10}
              value={config.trigger.min_new_tasks}
              onChange={(e) =>
                setConfig({ ...config, trigger: { ...config.trigger, min_new_tasks: parseInt(e.target.value) || 100 } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            />
          </div>
          <div>
            <label className="text-muted text-xs uppercase">Min tasks for training</label>
            <input
              type="number"
              min={50}
              value={config.params.min_tasks}
              onChange={(e) =>
                setConfig({ ...config, params: { ...config.params, min_tasks: parseInt(e.target.value) || 200 } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            />
          </div>
          <div>
            <label className="text-muted text-xs uppercase">Trees (full)</label>
            <input
              type="number"
              min={50}
              value={config.params.num_trees}
              onChange={(e) =>
                setConfig({ ...config, params: { ...config.params, num_trees: parseInt(e.target.value) || 200 } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            />
          </div>
          <div>
            <label className="text-muted text-xs uppercase">Trees (incremental)</label>
            <input
              type="number"
              min={10}
              value={config.params.incremental_trees}
              onChange={(e) =>
                setConfig({ ...config, params: { ...config.params, incremental_trees: parseInt(e.target.value) || 50 } })
              }
              className="mt-1 block w-full border border-border rounded px-3 py-2 bg-surface text-sm"
            />
          </div>
        </div>

        <button
          onClick={saveConfig}
          disabled={saving}
          className="px-4 py-2 bg-accent text-surface rounded text-sm font-medium hover:opacity-80 transition-opacity disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save Configuration"}
        </button>
      </section>

      {/* Training History */}
      {data.history.length > 0 && (
        <section className="bg-surface rounded-lg border border-border p-6 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Training History</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted text-xs uppercase">
                  <th className="pb-2 pr-4">Date</th>
                  <th className="pb-2 pr-4">Mode</th>
                  <th className="pb-2 pr-4 text-right">Tasks</th>
                  <th className="pb-2 pr-4 text-right">Duration</th>
                  <th className="pb-2 pr-4">Trigger</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-mono text-xs">{fmtDate(h.timestamp)}</td>
                    <td className="py-2 pr-4">{h.mode}</td>
                    <td className="py-2 pr-4 text-right">{h.tasks.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right">{fmtDuration(h.duration_ms)}</td>
                    <td className="py-2 pr-4 text-muted">{h.trigger}</td>
                    <td className="py-2">
                      <span className={h.status === "success" ? "text-green-700" : "text-red-600"}>
                        {h.status === "success" ? "success" : "failed"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
