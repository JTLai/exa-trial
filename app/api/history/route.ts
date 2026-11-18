import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { observations } from "@/lib/db/schema";

export async function GET(request: Request) {
  const upc = new URL(request.url).searchParams.get("upc");
  if (!upc) return NextResponse.json({ error: "upc is required" }, { status: 400 });
  const rows = db
    .select()
    .from(observations)
    .where(and(eq(observations.upc, upc)))
    .orderBy(desc(observations.observedAt), desc(observations.id))
    .limit(200)
    .all();
  return NextResponse.json(rows);
}
