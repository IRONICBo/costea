import { NextResponse } from "next/server";
import { getSessionSummary, getSessionTurns, getSessionCalls } from "@/lib/costea-data";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const summary = await getSessionSummary(id);
  if (!summary) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const turns = await getSessionTurns(id);
  const calls = await getSessionCalls(id);

  return NextResponse.json({ summary, turns, calls });
}
