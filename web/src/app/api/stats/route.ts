import { NextResponse } from "next/server";
import { getAggregatedStats } from "@/lib/costea-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await getAggregatedStats();
  return NextResponse.json(stats);
}
