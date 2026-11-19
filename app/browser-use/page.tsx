"use client";

import { Loader2, Play, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ToolScore } from "@/lib/browser-use";
import { BROWSER_TOOLS, type BrowserTool } from "@/lib/db/schema";
import { CLOSE_TOLERANCE, type EvalRow, type Outcome } from "@/lib/eval";
import { RETAILERS } from "@/lib/retailers";

type Row = EvalRow & { tools: Record<BrowserTool, ToolScore | null> };
type Response = { rows: Row[]; running: number };

const TOOL_LABEL: Record<BrowserTool, string> = { browserless: "Browserless Smart Scrape", firecrawl: "Firecrawl Interact" };
const usd = (n: number) => `$${n.toFixed(2)}`;
const secs = (ms: number | null) => (ms == null ? "" : `${(ms / 1000).toFixed(0)}s`);

const GOOD = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const MEH = "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
const BAD = "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300";
const MUTED = "bg-muted text-muted-foreground";
const OUTCOME: Record<Outcome | "error" | "running", { label: string; className: string }> = {
  exact: { label: "exact", className: GOOD },
  correct_absent: { label: "correctly unpriced", className: GOOD },
  close: { label: `within ${CLOSE_TOLERANCE * 100}%`, className: MEH },
  missed: { label: "missed", className: MEH },
  wrong_price: { label: "wrong price", className: BAD },
  false_price: { label: "false price", className: BAD },
  different_basis: { label: "different store", className: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  not_run: { label: "not run", className: MUTED },
  error: { label: "error", className: BAD },
  running: { label: "running…", className: MUTED },
};
const CORRECT = ["exact", "correct_absent"];

export default function BrowserUsePage() {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/browser-use");
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("Could not load. Did you run `npm run db:push`?");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const running = (data?.running ?? 0) > 0;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [running, load]);

  async function start(body: { cells?: { upc: string; retailer: string }[]; tools?: BrowserTool[] } = {}) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/browser-use", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not start");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setStarting(false);
    }
  }

  const rows = data?.rows ?? [];
  const tally = (pick: (r: Row) => string | undefined) => {
    const done = rows.map(pick).filter((o): o is string => !!o && o !== "running" && o !== "not_run");
    return { correct: done.filter((o) => CORRECT.includes(o)).length, done: done.length };
  };
  const scores = [
    { name: "Exa", ...tally((r) => r.outcome), note: "by definition: these are its misses" },
    ...BROWSER_TOOLS.map((t) => {
      const checks = rows.map((r) => r.tools[t]).filter((s): s is ToolScore => !!s && s.outcome !== "running");
      const ms = checks.map((s) => s.check.durationMs).filter((d): d is number => d != null).sort((a, b) => a - b);
      return {
        name: TOOL_LABEL[t],
        ...tally((r) => r.tools[t]?.outcome),
        note: [
          `${checks.filter((s) => s.outcome === "error").length} errors`,
          ms.length ? `median ${secs(ms[Math.floor(ms.length / 2)])}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  ];

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Browser-Use: re-checking Exa&apos;s misses</h1>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Every golden-set case where the Eval tab doesn&apos;t show the right answer, re-tried with Browserless Smart Scrape
            (stealth browser + AI JSON extraction) and Firecrawl Interact (scrape, then an AI agent in the live browser). Both
            are given the golden set&apos;s URL directly, which Exa had to find on its own. Prices are normalized to the
            SKU&apos;s pack and scored the same way as the Eval tab.
          </p>
        </div>
        <Button size="sm" onClick={() => start()} disabled={running || starting || !rows.length}>
          {running || starting ? <Loader2 className="animate-spin" /> : <Play />}
          Run both on all {rows.length || ""} misses
        </Button>
      </header>

      {running && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> {data?.running} browser checks running (each takes 20–90s)…
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data ? (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {scores.map((s) => (
            <div key={s.name} className="rounded-md border px-2.5 py-1.5">
              <div className="truncate text-[11px] text-muted-foreground">{s.name}</div>
              <div className="text-lg leading-tight font-semibold tabular-nums">
                {s.done ? `${s.correct} / ${s.done}` : "—"}
                <span className="ml-1 text-xs font-normal text-muted-foreground">correct</span>
              </div>
              <div className="truncate text-[10px] text-muted-foreground">{s.note}</div>
            </div>
          ))}
        </div>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}

      <div className="max-h-[calc(100dvh-4rem)] overflow-auto rounded-md border">
        <table className="w-full min-w-[1100px] text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-left text-[11px] text-muted-foreground shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="px-2 py-1.5 font-medium">SKU</th>
              <th className="px-2 py-1.5 font-medium">Retailer</th>
              <th className="px-2 py-1.5 text-right font-medium">Golden</th>
              <th className="border-l px-2 py-1.5 font-medium">Exa</th>
              {BROWSER_TOOLS.map((t) => (
                <th key={t} className="border-l px-2 py-1.5 font-medium">{TOOL_LABEL[t]}</th>
              ))}
              <th className="w-8 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {!data &&
              Array.from({ length: 6 }, (_, i) => (
                <tr key={i} className="border-t"><td colSpan={7} className="px-2 py-1"><Skeleton className="h-4 w-full" /></td></tr>
              ))}
            {data && !rows.length && (
              <tr><td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">Exa got every golden-set case right. Nothing to re-check.</td></tr>
            )}
            {rows.map((r) => {
              const rowRunning = BROWSER_TOOLS.some((t) => r.tools[t]?.outcome === "running");
              return (
                <tr key={`${r.item.upc}-${r.item.retailer}`} className="border-t align-top hover:bg-muted/40">
                  <td className="max-w-[300px] px-2 py-1.5" title={`UPC ${r.item.upc}`}>
                    <div className="font-medium">{r.title}</div>
                    <div className="text-[11px] text-muted-foreground">{r.item.notes}</div>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{RETAILERS[r.item.retailer].name}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                    <a href={r.item.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {r.item.expected.price != null ? usd(r.item.expected.price) : <Muted s={r.item.expected.status} />}
                    </a>
                    {r.item.expected.listedPrice != null && (
                      <div className="text-[10px] text-muted-foreground">listed {usd(r.item.expected.listedPrice)}</div>
                    )}
                  </td>
                  <td className="border-l px-2 py-1.5" title={r.observed?.notes ?? ""}>
                    <Cell
                      price={r.observed?.status === "priced" ? r.observed.price : null}
                      status={r.observed?.status}
                      outcome={r.outcome}
                      errorPct={r.errorPct}
                      href={r.observed?.url}
                      sub={r.observed?.source === "third_party" ? "third-party source" : r.observed?.productTitle}
                    />
                  </td>
                  {BROWSER_TOOLS.map((t) => {
                    const s = r.tools[t];
                    if (!s) return <td key={t} className="border-l px-2 py-1.5 text-muted-foreground">not run</td>;
                    const c = s.check;
                    return (
                      <td key={t} className="border-l px-2 py-1.5" title={[c.notes, c.detail].filter(Boolean).join("\n")}>
                        <Cell
                          price={s.skuPrice}
                          status={c.status}
                          outcome={s.outcome}
                          errorPct={s.errorPct}
                          listed={s.normalized ? c.price : null}
                          sub={c.status === "error" ? c.notes : c.productTitle}
                          meta={[secs(c.durationMs), c.detail].filter(Boolean).join(" · ")}
                        />
                      </td>
                    );
                  })}
                  <td className="px-1 py-1.5">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="Re-run both tools on this case"
                      disabled={running || starting}
                      onClick={() => start({ cells: [{ upc: r.item.upc, retailer: r.item.retailer }] })}
                    >
                      {rowRunning ? <Loader2 className="animate-spin" /> : <RotateCw />}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Hover a cell for the tool&apos;s notes. Kroger prices depend on which store the browser lands on, so a Kroger price that
        differs from the golden one is marked &quot;different store&quot; and isn&apos;t counted as wrong.
      </p>
    </main>
  );
}

function Cell(props: {
  price: number | null | undefined;
  status?: string | null;
  outcome: Outcome | "error" | "running";
  errorPct: number | null;
  href?: string | null;
  listed?: number | null;
  sub?: string | null;
  meta?: string;
}) {
  const o = OUTCOME[props.outcome];
  const price =
    props.outcome === "running" ? null : props.price != null ? usd(props.price) : props.status && props.status !== "error" ? <Muted s={props.status} /> : null;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-medium tabular-nums">
          {props.href && price ? (
            <a href={props.href} target="_blank" rel="noreferrer" className="hover:underline">{price}</a>
          ) : (
            price
          )}
        </span>
        <span className={`rounded px-1 py-px text-[10px] font-medium ${o.className}`}>
          {props.outcome === "running" && <Loader2 className="mr-0.5 inline size-2.5 animate-spin" />}
          {o.label}
        </span>
        {props.errorPct != null && props.outcome !== "exact" && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {props.errorPct > 0 ? "+" : ""}
            {(props.errorPct * 100).toFixed(1)}%
          </span>
        )}
      </div>
      {props.listed != null && <div className="text-[10px] text-muted-foreground">listed {usd(props.listed)}, pack-normalized</div>}
      {props.sub && <div className="line-clamp-2 max-w-[260px] text-[10px] text-muted-foreground">{props.sub}</div>}
      {props.meta && <div className="text-[10px] text-muted-foreground/80">{props.meta}</div>}
    </div>
  );
}

function Muted({ s }: { s: string }) {
  const label = s === "not_listed" ? "not sold" : s === "no_price" ? "no price" : s;
  return <span className="text-xs font-normal text-muted-foreground">{label}</span>;
}
