"use client";

import { Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Run } from "@/lib/db/schema";
import { CLOSE_TOLERANCE, FRESH_WITHIN_HOURS, type EvalRow, type EvalSummary, type GoldenSet, type Outcome, type RetailerEval } from "@/lib/eval";
import { describeBasis, RETAILERS } from "@/lib/retailers";

type EvalResponse = { rows: EvalRow[]; summary: EvalSummary; retailers: RetailerEval[]; set: GoldenSet; goldAgeDays: number; activeRun: Run | null };

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const hours = (h: number | null) => (h == null ? "—" : Math.abs(h) < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);

const OUTCOME_LABEL: Record<Outcome, { label: string; className: string }> = {
  exact: { label: "exact", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  correct_absent: { label: "correctly unpriced", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  close: { label: `within ${CLOSE_TOLERANCE * 100}%`, className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  wrong_price: { label: "wrong price", className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" },
  false_price: { label: "false price", className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300" },
  missed: { label: "missed", className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  different_basis: { label: "different store", className: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300" },
  not_run: { label: "not run", className: "bg-muted text-muted-foreground" },
};

export default function EvalPage() {
  const [data, setData] = useState<EvalResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/eval");
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("Could not load the eval. Did you run `npm run db:push`?");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  const running = !!data?.activeRun;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [running, load]);

  async function rerun() {
    if (!data) return;
    setStarting(true);
    setError(null);
    try {
      const cells = data.set.items.map((i) => ({ upc: i.upc, retailer: i.retailer }));
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cells }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start the run");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setStarting(false);
    }
  }

  const s = data?.summary;
  const goldAgeDays = data?.goldAgeDays ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Exa Price Eval</h1>
          <p className="text-xs text-muted-foreground">
            {data
              ? `Golden set: ${data.set.items.length} SKU × retailer prices checked by hand on ${new Date(data.set.verifiedAt).toLocaleDateString()}. `
              : "Loading… "}
            Scores the latest price the tracker shows for each one.
          </p>
        </div>
        <Button size="sm" onClick={rerun} disabled={running || starting || !data}>
          {running || starting ? <Loader2 className="animate-spin" /> : <Play />}
          Re-run Exa on golden set
        </Button>
      </header>

      {data?.activeRun && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
          <Loader2 className="size-3.5 animate-spin" /> Looking up prices… {data.activeRun.completed} / {data.activeRun.total}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data && goldAgeDays > 3 && (
        <Alert>
          <AlertTitle>The golden set is {goldAgeDays.toFixed(0)} days old</AlertTitle>
          <AlertDescription>Retail prices change often. Check the golden prices again before you trust these scores.</AlertDescription>
        </Alert>
      )}

      {s ? (
        <section className="space-y-1">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            <Stat
              label="Overall correct"
              value={pct(s.overallAccuracy)}
              sub={`exact price or correctly unpriced · ${s.evaluated} scored${s.differentBasis ? `, ${s.differentBasis} other-store left out` : ""}`}
            />
            <Stat
              label="Price accuracy"
              value={pct(s.exactRate)}
              sub={`exact on ${s.counts.exact}/${s.goldPriced} real prices · ${pct(s.withinToleranceRate)} within ${CLOSE_TOLERANCE * 100}%`}
            />
            <Stat
              label="False prices"
              value={pct(s.falsePriceRate)}
              sub={`priced ${s.counts.false_price} of ${s.goldUnpriced} that aren't sold / have no price`}
              bad={!!s.counts.false_price}
            />
            <Stat
              label="Freshness"
              value={pct(s.freshRate)}
              sub={`observed within ${FRESH_WITHIN_HOURS}h of the hand check · median lag ${hours(s.medianLagHours)}`}
            />
          </div>
        </section>
      ) : (
        <Skeleton className="h-32 w-full" />
      )}

      {data && (
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          {data.retailers.map((r) => (
            <span key={r.retailer} className="rounded-full border px-2 py-0.5">
              <span className="font-medium">{RETAILERS[r.retailer].name}</span>{" "}
              {r.evaluated ? `${r.correct}/${r.evaluated} correct` : "not in golden set"}
              {r.skipped > 0 && <span className="text-muted-foreground"> · {r.skipped} skipped</span>}
            </span>
          ))}
        </div>
      )}

      {/* Own scroll box so the header stays visible while scrolling rows. */}
      <div className="max-h-[calc(100dvh-4rem)] overflow-auto rounded-md border">
        <table className="w-full min-w-[960px] text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-left text-[11px] text-muted-foreground shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="px-2 py-1.5 font-medium">SKU</th>
              <th className="px-2 py-1.5 font-medium">Retailer</th>
              <th className="px-2 py-1.5 font-medium">Stratum</th>
              <th className="px-2 py-1.5 text-right font-medium">Golden</th>
              <th className="px-2 py-1.5 text-right font-medium">Exa</th>
              <th className="px-2 py-1.5 text-right font-medium">Error</th>
              <th className="px-2 py-1.5 font-medium">Result</th>
              <th className="px-2 py-1.5 text-right font-medium">Lag</th>
              <th className="px-2 py-1.5 font-medium" title="golden / Exa">Stock</th>
            </tr>
          </thead>
          <tbody>
            {!data &&
              Array.from({ length: 10 }, (_, i) => (
                <tr key={i} className="border-t"><td colSpan={9} className="px-2 py-1"><Skeleton className="h-4 w-full" /></td></tr>
              ))}
            {data?.rows.map((r) => {
              const basisDiffers = r.observedBasis != null && r.observedBasis !== r.item.basis;
              return (
                <tr key={`${r.item.upc}-${r.item.retailer}`} className="border-t hover:bg-muted/40">
                  <td className="max-w-[380px] px-2 py-1" title={`UPC ${r.item.upc}\n${r.item.notes}`}>
                    <div className="truncate">
                      <span className="font-medium">{r.title}</span>
                      <span className="ml-1.5 text-muted-foreground">{r.item.notes}</span>
                    </div>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">{RETAILERS[r.item.retailer].name}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-[11px] text-muted-foreground">{r.item.stratum}</td>
                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap" title={describeBasis(r.item.basis)}>
                    <a href={r.item.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {r.item.expected.price != null ? usd(r.item.expected.price) : <Status s={r.item.expected.status} />}
                    </a>
                  </td>
                  <td
                    className="px-2 py-1 text-right tabular-nums whitespace-nowrap"
                    title={[r.observedBasis && describeBasis(r.observedBasis), r.observed?.notes].filter(Boolean).join("\n")}
                  >
                    {r.observed?.source === "third_party" && <Tag className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">3P</Tag>}
                    {basisDiffers && <Tag className="bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300">other store</Tag>}
                    {!r.observed ? (
                      "—"
                    ) : r.observed.status === "priced" && r.observed.price != null ? (
                      r.observed.url ? (
                        <a href={r.observed.url} target="_blank" rel="noreferrer" className="hover:underline">{usd(r.observed.price)}</a>
                      ) : (
                        usd(r.observed.price)
                      )
                    ) : (
                      <Status s={r.observed.status} />
                    )}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {r.errorPct == null ? "—" : `${r.errorPct > 0 ? "+" : ""}${(r.errorPct * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className={`rounded px-1 py-px text-[10px] font-medium ${OUTCOME_LABEL[r.outcome].className}`}>
                      {OUTCOME_LABEL[r.outcome].label}
                    </span>
                    {r.likelyStale && <span className="ml-1 text-[10px] text-amber-700 dark:text-amber-400">stale?</span>}
                  </td>
                  <td className={`px-2 py-1 text-right tabular-nums ${r.fresh === false ? "text-rose-600" : ""}`}>{hours(r.lagHours)}</td>
                  <td className={`px-2 py-1 whitespace-nowrap ${r.availabilityMatch === false ? "text-rose-600" : "text-muted-foreground"}`}>
                    {stock(r.item.expected.availability)} / {stock(r.observed?.availability)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {data && data.set.skipped.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer text-foreground">
            Left out of the golden set ({data.set.skipped.length}): sampled, but the price couldn&apos;t be checked by hand
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {data.set.skipped.map((x) => (
              <li key={`${x.upc}-${x.retailer}`}>
                {RETAILERS[x.retailer].name} · UPC {x.upc}: {x.reason}
              </li>
            ))}
          </ul>
          <p className="mt-1">{data.set.method}</p>
        </details>
      )}
    </main>
  );
}

const stock = (a?: string | null) => (a === "in_stock" ? "in" : a === "out_of_stock" ? "OOS" : a === "unknown" ? "?" : "—");

function Stat({ label, value, sub, bad }: { label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <div className="rounded-md border px-2.5 py-1.5" title={sub}>
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-lg leading-tight font-semibold tabular-nums ${bad ? "text-rose-600" : ""}`}>{value}</div>
      <div className="text-[10px] leading-snug text-muted-foreground">{sub}</div>
    </div>
  );
}

function Tag({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`mr-1 rounded px-1 py-px text-[9px] font-medium ${className}`}>{children}</span>;
}

function Status({ s }: { s: string }) {
  const label = s === "not_listed" ? "not sold" : s === "no_price" ? "no price" : s;
  return <span className="text-xs text-muted-foreground">{label}</span>;
}
