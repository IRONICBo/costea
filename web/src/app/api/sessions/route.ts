import { NextResponse } from "next/server";
import { getIndex } from "@/lib/costea-data";

export const dynamic = "force-dynamic";

export async function GET() {
  const index = await getIndex();
  if (!index) {
    return NextResponse.json(
      { error: "No costea data found. Run: bash ~/.claude/skills/costea/scripts/update-index.sh" },
      { status: 404 }
    );
  }
  return NextResponse.json(index);
}
