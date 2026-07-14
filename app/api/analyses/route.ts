import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { analyzeText } from "@/lib/ai";
import { db } from "@/lib/db";
import { analyses } from "@/lib/db/schema";

const createRequestSchema = z.object({
  text: z.string().trim().min(1, "Text is required").max(10_000),
});

export async function GET() {
  const rows = await db
    .select()
    .from(analyses)
    .orderBy(desc(analyses.createdAt), desc(analyses.id))
    .limit(20);
  return NextResponse.json(rows);
}

export async function POST(request: Request) {
  const parsed = createRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  try {
    const result = await analyzeText(parsed.data.text);
    const [row] = await db
      .insert(analyses)
      .values({ input: parsed.data.text, ...result })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    console.error("Analysis failed:", error);
    return NextResponse.json(
      { error: "Analysis failed. Check the server logs and your API key." },
      { status: 500 },
    );
  }
}
