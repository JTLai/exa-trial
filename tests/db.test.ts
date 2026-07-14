import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { analyses } from "@/lib/db/schema";

// Mirrors the table `drizzle-kit push` creates from lib/db/schema.ts.
const createTableSql = `
CREATE TABLE analyses (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  input text NOT NULL,
  summary text NOT NULL,
  sentiment text NOT NULL,
  topics text NOT NULL,
  created_at integer DEFAULT (unixepoch()) NOT NULL
);`;

describe("analyses table", () => {
  it("round-trips a row, including JSON topics and the timestamp default", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(createTableSql);
    const db = drizzle(sqlite);

    const [row] = await db
      .insert(analyses)
      .values({
        input: "Great product, fast shipping!",
        summary: "Positive feedback about product quality and shipping.",
        sentiment: "positive",
        topics: ["quality", "shipping"],
      })
      .returning();

    expect(row.id).toBe(1);
    expect(row.topics).toEqual(["quality", "shipping"]);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
