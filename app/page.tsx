"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { Analysis } from "@/lib/db/schema";

const sentimentStyles: Record<Analysis["sentiment"], string> = {
  positive: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  negative: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export default function Home() {
  const [text, setText] = useState("");
  const [analyses, setAnalyses] = useState<Analysis[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/analyses")
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(setAnalyses)
      .catch(() => setError("Could not load past analyses. Did you run `npm run db:push`?"))
      .finally(() => setLoadingList(false));
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/analyses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Request failed");
      setAnalyses((prev) => [body, ...prev]);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Text Analyzer</h1>
        <p className="text-muted-foreground">
          Paste any text — customer feedback, an email, a review — and GPT will
          summarize it, classify sentiment, and extract topics. Results are
          saved to SQLite.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-3">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste text to analyze…"
          rows={5}
          disabled={submitting}
          required
        />
        <Button type="submit" disabled={submitting || text.trim().length === 0}>
          {submitting ? "Analyzing…" : "Analyze"}
        </Button>
      </form>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-medium">Recent analyses</h2>

        {loadingList && (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        )}

        {submitting && <Skeleton className="h-28 w-full" />}

        {!loadingList && analyses.length === 0 && !submitting && (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Submit some text above to see results here.
          </p>
        )}

        {analyses.map((analysis) => (
          <Card key={analysis.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base leading-snug">
                  {analysis.summary}
                </CardTitle>
                <Badge className={sentimentStyles[analysis.sentiment]}>
                  {analysis.sentiment}
                </Badge>
              </div>
              <CardDescription>
                {new Date(analysis.createdAt).toLocaleString()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {analysis.topics.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
              <p className="line-clamp-3 text-sm text-muted-foreground">
                {analysis.input}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
