import { NextResponse } from "next/server";
import { estimateTask } from "@/lib/estimator";
import { predictWithFitting } from "@/lib/fitting-adapter";

export const dynamic = "force-dynamic";

/** Try ML prediction first (fitting module), fall back to heuristic. */
async function predict(task: string) {
  // ML path: uses trained GBDT/MLP/Linear models for ~18% cost medAPE
  const mlResult = await predictWithFitting(task);
  if (mlResult) return mlResult;

  // Heuristic fallback: keyword similarity + baselines (~70% cost medAPE)
  return estimateTask(task);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  if (!task) {
    return NextResponse.json({ error: "Missing ?task= parameter" }, { status: 400 });
  }

  const result = await predict(task);
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const body = await req.json();
  const task = body.task;
  if (!task) {
    return NextResponse.json({ error: "Missing task field" }, { status: 400 });
  }

  const result = await predict(task);
  return NextResponse.json(result);
}
