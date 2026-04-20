import Link from "next/link";
import { HeroEstimator } from "@/components/HeroEstimator";

function ReceiptCard() {
  return (
    <div className="bg-surface receipt-shadow rounded-md max-w-[320px] w-full font-receipt text-sm shadow-[var(--shadow-lg)]">
      <div className="h-3 bg-[repeating-linear-gradient(90deg,transparent,transparent_4px,var(--surface)_4px,var(--surface)_8px)] rounded-t" />
      <div className="px-6 pt-6 pb-5 text-center">
        <p className="text-lg font-bold tracking-[0.3em] text-foreground">COSTEA</p>
        <p className="text-[10px] text-muted mt-1 tracking-[0.2em] uppercase">Agent Cost Receipt</p>
        <p className="text-[10px] text-muted-light mt-0.5">2026-04-21 09:04:12</p>
        <div className="receipt-dash my-4" />
        <div className="text-left">
          <p className="text-[10px] text-muted uppercase tracking-wider">Task</p>
          <p className="text-xs text-foreground mt-0.5 leading-snug">Refactor the auth module</p>
        </div>
        <div className="receipt-dash my-4" />
        <div className="space-y-1.5 text-[11px]">
          {[
            ["Input tokens", "12,400"],
            ["Output tokens", "5,800"],
            ["Cache read", "34,900"],
            ["Tool calls", "14"],
            ["Similar tasks", "3"],
            ["Est. runtime", "~2 min"],
          ].map(([l, v]) => (
            <div key={l} className="flex justify-between">
              <span className="text-muted">{l}</span>
              <span className="text-foreground">{v}</span>
            </div>
          ))}
        </div>
        <div className="receipt-dash my-4" />
        <p className="text-[10px] text-muted uppercase tracking-wider text-left mb-2">Provider Estimates</p>
        <div className="space-y-1 text-[11px]">
          {[
            ["Claude Sonnet 4.6", "$0.38"],
            ["GPT-5.4", "$0.54"],
            ["Gemini 2.5 Pro", "$0.29"],
          ].map(([n, c]) => (
            <div key={n} className="flex justify-between">
              <span className="text-foreground/70">{n}</span>
              <span className="text-foreground">{c}</span>
            </div>
          ))}
        </div>
        <div className="receipt-double my-4" />
        <div className="flex justify-between items-baseline">
          <span className="text-xs font-bold text-foreground uppercase tracking-wider">Estimated Total</span>
          <span className="text-xl font-bold text-foreground">$0.38</span>
        </div>
        <p className="text-[10px] text-muted-light text-right mt-0.5">best price: Gemini 2.5 Pro</p>
        <div className="receipt-dash my-4" />
        <div className="flex justify-between text-[11px]">
          <span className="text-muted">Confidence</span>
          <span className="text-foreground font-bold">96%</span>
        </div>
        <div className="receipt-dash my-4" />
        <div className="bg-surface-warm -mx-6 px-6 py-3">
          <p className="text-xs text-foreground">
            Proceed? <span className="font-bold">[Y/N]</span>
            <span className="inline-block w-[6px] h-[13px] bg-foreground animate-pulse align-middle ml-1" />
          </p>
        </div>
        <p className="text-[9px] text-muted-light mt-4 tracking-wide">POWERED BY /COSTEA SKILL</p>
        <p className="text-[9px] text-muted-light mt-0.5">THANK YOU FOR BEING COST-CONSCIOUS</p>
        <div className="flex justify-center gap-[2px] mt-3">
          {[3, 1, 2, 1, 3, 2, 1, 1, 3, 1, 2, 3, 1, 2, 1, 1, 3, 2, 1, 3, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1].map((w, i) => (
            <div key={i} className="bg-foreground" style={{ width: `${w}px`, height: "20px" }} />
          ))}
        </div>
      </div>
      <div className="h-3 bg-[repeating-linear-gradient(90deg,transparent,transparent_4px,var(--surface)_4px,var(--surface)_8px)] rounded-b" />
    </div>
  );
}

function FeatureCard({
  eyebrow,
  title,
  body,
  tint,
}: {
  eyebrow: string;
  title: string;
  body: string;
  tint: "a" | "b" | "c" | "d";
}) {
  const tintMap = {
    a: "linear-gradient(135deg, rgba(107,93,255,0.12), rgba(107,93,255,0) 60%)",
    b: "linear-gradient(135deg, rgba(255,138,92,0.14), rgba(255,138,92,0) 60%)",
    c: "linear-gradient(135deg, rgba(45,190,168,0.14), rgba(45,190,168,0) 60%)",
    d: "linear-gradient(135deg, rgba(255,215,107,0.18), rgba(255,215,107,0) 60%)",
  };
  return (
    <div className="card card-interactive p-6 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none opacity-70"
        style={{ backgroundImage: tintMap[tint] }}
      />
      <div className="relative">
        <p className="eyebrow mb-2">{eyebrow}</p>
        <h3 className="text-lg font-semibold tracking-tight mb-2">{title}</h3>
        <p className="text-sm text-foreground-soft leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function ModelShelf() {
  const items = [
    "Claude Opus 4.6",
    "Claude Sonnet 4.6",
    "Claude Haiku 4.5",
    "GPT-5.4",
    "GPT-5.2 Codex",
    "Gemini 2.5 Pro",
    "Gemini 2.5 Flash",
    "DeepSeek V4",
    "Grok 3",
  ];
  const loop = [...items, ...items];
  return (
    <div className="overflow-hidden py-3 border-y border-border-soft bg-surface-elevated/60">
      <div className="marquee-track text-xs text-muted">
        {loop.map((name, i) => (
          <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-a/60" />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}

function EnsembleDiagram() {
  return (
    <div className="card p-6 relative overflow-hidden">
      <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full blur-3xl"
           style={{ background: "radial-gradient(circle, rgba(107,93,255,0.22), transparent 70%)" }} />
      <p className="eyebrow mb-3">Prediction engine</p>
      <h3 className="text-xl font-semibold tracking-tight mb-4">Ensemble of three, calibrated to one.</h3>
      <p className="text-sm text-foreground-soft leading-relaxed mb-6 max-w-xl">
        Every estimate runs through a gradient-boosted tree, a PyTorch MLP,
        and a sklearn linear quantile regressor in parallel. The router
        picks whichever model wins per-task on historical medAPE, then a
        conformal calibrator turns that point estimate into an honest
        80% interval.
      </p>

      <div className="grid grid-cols-3 gap-3 text-xs">
        {[
          { name: "GBDT", meta: "gradient boosting · 47 feats", hue: "a" },
          { name: "MLP", meta: "PyTorch · quantile head", hue: "b" },
          { name: "Linear", meta: "sklearn · quantile", hue: "c" },
        ].map((m) => (
          <div key={m.name} className="rounded-[var(--radius-md)] border border-border-soft bg-surface p-3">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background:
                    m.hue === "a" ? "var(--brand-a)" : m.hue === "b" ? "var(--brand-b)" : "var(--brand-c)",
                }}
              />
              <span className="font-semibold text-foreground">{m.name}</span>
            </div>
            <p className="text-muted leading-snug text-[11px]">{m.meta}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3 text-xs">
        <span className="pill pill-brand">metric-driven auto-select</span>
        <span className="pill pill-positive">conformal 80% bands</span>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <>
      {/* ========================= HERO ========================= */}
      <section className="mesh relative">
        <div className="grid-dots absolute inset-0 opacity-40 pointer-events-none" aria-hidden />
        <div className="max-w-7xl mx-auto px-6 pt-20 pb-24 grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-16 items-start relative">
          <div>
            <div className="inline-flex items-center gap-2 mb-6">
              <span className="pill pill-brand">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-a animate-pulse" />
                v1.2 · ensemble prediction is live
              </span>
            </div>
            <h1 className="text-[44px] md:text-[64px] leading-[1.02] tracking-tight font-semibold">
              Cost infrastructure<br />
              for the <span className="gradient-text italic font-serif">agent era</span>.
            </h1>
            <p className="mt-6 text-lg text-foreground-soft leading-relaxed max-w-xl">
              Costea predicts the token bill of every AI-agent task{" "}
              <em>before</em> you run it — then reconciles it against
              the one that actually arrived. Like Stripe, but for LLM
              compute.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/estimate" className="btn-primary">
                Estimate a task <span aria-hidden>→</span>
              </Link>
              <a
                href="https://github.com/memovai/costea"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
              >
                Star on GitHub
              </a>
            </div>

            <div className="mt-10 grid grid-cols-3 gap-4 max-w-xl">
              {[
                ["~18%", "cost medAPE"],
                ["7", "providers priced"],
                ["3", "models ensembled"],
              ].map(([v, l]) => (
                <div key={l}>
                  <p className="text-2xl font-semibold tracking-tight">{v}</p>
                  <p className="text-xs text-muted mt-0.5">{l}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex lg:justify-end relative">
            <div className="relative">
              <div
                className="absolute -inset-6 rounded-[28px] blur-2xl opacity-70 -z-10"
                style={{
                  background:
                    "conic-gradient(from 210deg at 50% 50%, rgba(107,93,255,0.35), rgba(255,138,92,0.30), rgba(45,190,168,0.30), rgba(107,93,255,0.35))",
                }}
              />
              <ReceiptCard />
            </div>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-6 pb-8 relative">
          <HeroEstimator />
        </div>
      </section>

      <ModelShelf />

      {/* ========================= VALUE PILLARS ========================= */}
      <section className="max-w-7xl mx-auto px-6 py-20">
        <div className="max-w-2xl mb-10">
          <p className="eyebrow mb-3">Why Costea</p>
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight leading-tight">
            Know the bill before the compute runs.
          </h2>
          <p className="mt-3 text-foreground-soft leading-relaxed">
            Three surfaces — a pre-flight estimator, a post-flight ledger,
            and a calibration dashboard — all speaking the same pricing
            vocabulary across every major agent runtime.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FeatureCard
            tint="a"
            eyebrow="Pre-flight"
            title="Per-task estimate"
            body="Type a task, get tokens, tool-calls, runtime, and a per-provider price column — in under 200ms on cached history."
          />
          <FeatureCard
            tint="b"
            eyebrow="Post-flight"
            title="Sessions ledger"
            body="Every Claude Code, Codex, and OpenClaw session indexed, split by model, plotted over time, searchable by cost."
          />
          <FeatureCard
            tint="c"
            eyebrow="Calibration"
            title="Accuracy, honestly"
            body="Scatter plots of predicted vs. actual across every estimate you've ever run. No cherry-picked demos — the residuals are right there."
          />
        </div>
      </section>

      {/* ========================= ENSEMBLE ========================= */}
      <section className="max-w-7xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-8 items-start">
          <EnsembleDiagram />
          <div className="card p-6">
            <p className="eyebrow mb-3">Pipeline</p>
            <h3 className="text-xl font-semibold tracking-tight mb-4">From JSONL to a price tag.</h3>
            <pre className="codeblock text-[12px] leading-relaxed whitespace-pre">
{`Session JSONL × 3 platforms
    │
    ▼   parse-{claudecode,codex,openclaw}.sh
~/.costea/sessions/{id}/
  session.jsonl · llm-calls.jsonl · tools.jsonl
    │
    ▼   summarize-session.sh
summary.json  →  fitting.Predictor
    │
    ├─▶ /costea     receipt + Y/N gate
    └─▶ /costeamigo historical report`}
            </pre>
          </div>
        </div>
      </section>

      {/* ========================= PRICING STRIP ========================= */}
      <section className="max-w-7xl mx-auto px-6 pb-20">
        <div className="flex items-end justify-between mb-6">
          <div>
            <p className="eyebrow mb-2">Providers on file</p>
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">Seven frontier models, one pricing table.</h2>
          </div>
          <Link href="/estimate" className="btn-ghost text-sm">
            Compare live →
          </Link>
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-elevated">
              <tr className="text-left text-muted eyebrow">
                <th className="py-3 px-5">Provider</th>
                <th className="py-3 px-5">Tier</th>
                <th className="py-3 px-5 text-right">Input / M</th>
                <th className="py-3 px-5 text-right">Output / M</th>
                <th className="py-3 px-5 text-right">Cache read</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-soft)]">
              {[
                ["Claude Opus 4.6", "Frontier", "$5.00", "$25.00", "$0.50"],
                ["Claude Sonnet 4.6", "Balanced", "$3.00", "$15.00", "$0.30"],
                ["Claude Haiku 4.5", "Fast", "$1.00", "$5.00", "$0.10"],
                ["GPT-5.4", "Frontier", "$2.50", "$15.00", "—"],
                ["GPT-5.2 Codex", "Coding", "$1.07", "$8.50", "—"],
                ["Gemini 2.5 Pro", "Frontier", "$1.25", "$5.00", "—"],
                ["Gemini 2.5 Flash", "Fast", "$0.15", "$0.60", "—"],
              ].map(([name, tier, inp, out, cache]) => (
                <tr key={name} className="hover:bg-surface-elevated/50 transition-colors">
                  <td className="py-3 px-5 font-medium">{name}</td>
                  <td className="py-3 px-5"><span className="pill">{tier}</span></td>
                  <td className="py-3 px-5 text-right font-mono text-xs">{inp}</td>
                  <td className="py-3 px-5 text-right font-mono text-xs">{out}</td>
                  <td className="py-3 px-5 text-right font-mono text-xs text-muted">{cache}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ========================= INSTALL STRIP ========================= */}
      <section className="max-w-7xl mx-auto px-6 pb-24">
        <div className="card p-8 md:p-10 relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none opacity-70"
            style={{
              backgroundImage:
                "radial-gradient(ellipse 60% 60% at 10% 0%, rgba(107,93,255,0.14), transparent 60%), radial-gradient(ellipse 50% 50% at 100% 100%, rgba(255,138,92,0.14), transparent 60%)",
            }}
          />
          <div className="relative grid grid-cols-1 md:grid-cols-[1fr_0.9fr] gap-10 items-center">
            <div>
              <p className="eyebrow mb-3">Get started</p>
              <h2 className="text-3xl font-semibold tracking-tight leading-tight mb-3">
                Install in a line. Costs in a breath.
              </h2>
              <p className="text-foreground-soft leading-relaxed mb-6 max-w-lg">
                Install Costea as a Claude Code skill, or run the web dashboard
                locally. Works out-of-the-box against your existing
                session history.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/estimate" className="btn-primary">
                  Launch estimator
                </Link>
                <a
                  href="https://github.com/memovai/costea"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary"
                >
                  Read the docs
                </a>
              </div>
            </div>
            <div className="space-y-3">
              <div className="codeblock">npx @asklv/costea</div>
              <div className="codeblock">
                ln -s /path/to/costea/skills/costea ~/.claude/skills/costea
              </div>
              <div className="codeblock">costea refactor the auth module</div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
