"use client";

import { ChevronDown, ChevronRight, Download, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Observation, Run } from "@/lib/db/schema";
import type { RetailerSummary, RetrievalOutcome, RetrievalSummary, SkuRow } from "@/lib/insights";
import { RETAILER_IDS, RETAILERS, type RetailerId } from "@/lib/retailers";
import { packLabel } from "@/lib/size";

type PricesResponse = { rows: SkuRow[]; retailers: RetailerSummary[]; retrieval: RetrievalSummary; activeRun: Run | null };

const usd = (n: number) => `$${n.toFixed(2)}`;
const isComparable = (o?: Observation): o is Observation & { price: number } =>
  !!o && o.status === "priced" && o.price != null && o.matchType === "exact";

export default function Home() {
  const [data, setData] = useState<PricesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [brand, setBrand] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/prices");
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("Could not load prices. Did you run `npm run db:push`?");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  // Poll while a refresh is running so prices fill in live.
  const running = !!data?.activeRun;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [running, load]);

  async function startRun(upcs?: string[]) {
    if (!upcs) {
      const n = (data?.rows.length ?? 0) * RETAILER_IDS.length;
      if (!confirm(`Refresh ${n} SKU × retailer prices? This takes ~20 minutes and roughly $5 of Exa usage plus OpenAI tokens.`)) return;
    }
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upcs }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start refresh");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setStarting(false);
    }
  }

  const brands = useMemo(() => [...new Set(data?.rows.map((r) => r.brand))].sort(), [data]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.rows ?? []).filter(
      (r) => (!brand || r.brand === brand) && (!q || r.title.toLowerCase().includes(q) || r.upc.includes(q)),
    );
  }, [data, query, brand]);

  const lastObserved = useMemo(() => {
    let max = 0;
    for (const r of data?.rows ?? []) for (const o of Object.values(r.prices)) max = Math.max(max, new Date(o.observedAt).getTime());
    return max ? new Date(max) : null;
  }, [data]);

  return (
    <main className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Retail Price Tracker</h1>
          <p className="text-sm text-muted-foreground">
            {data ? `${data.rows.length} active SKUs` : "Loading…"} across Walmart, Target, Amazon, Walgreens and Kroger ·
            {lastObserved ? ` last observation ${lastObserved.toLocaleString()}` : " no prices collected yet"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" nativeButton={false} render={<a href="/api/prices?format=csv" />}>
            <Download /> Export CSV
          </Button>
          <Button onClick={() => startRun()} disabled={running || starting || !data}>
            {running || starting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh all prices
          </Button>
        </div>
      </header>

      {data?.activeRun && <RunProgress run={data.activeRun} />}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data ? <RetrievalPanel r={data.retrieval} /> : <Skeleton className="h-40 w-full" />}

      {data ? <RetailerCards summaries={data.retailers} total={data.rows.length} /> : <Skeleton className="h-28 w-full" />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title or UPC…"
          className="w-64"
        />
        <BrandChip active={!brand} onClick={() => setBrand(null)}>All brands</BrandChip>
        {brands.map((b) => (
          <BrandChip key={b} active={brand === b} onClick={() => setBrand(brand === b ? null : b)}>
            {b}
          </BrandChip>
        ))}
      </div>

      <Legend />

      {/* Own scroll box (both axes) so the header can stick while the table also scrolls sideways on small screens. */}
      <div className="max-h-[calc(100dvh-2rem)] overflow-auto rounded-lg border">
        <table className="w-full min-w-[1000px] text-sm">
          <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground shadow-[0_1px_0_var(--border)]">
            <tr>
              <th className="w-8 p-2" />
              <th className="p-2 font-medium">SKU</th>
              {RETAILER_IDS.map((r) => (
                <th key={r} className="w-[110px] p-2 text-right font-medium">{RETAILERS[r].name}</th>
              ))}
              <th className="w-[90px] p-2 text-right font-medium">Spread</th>
              <th className="w-10 p-2" />
            </tr>
          </thead>
          <tbody>
            {!data &&
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="border-t"><td colSpan={9} className="p-2"><Skeleton className="h-8 w-full" /></td></tr>
              ))}
            {rows.map((row) => (
              <Fragment key={row.upc}>
                <tr
                  className="cursor-pointer border-t hover:bg-muted/40"
                  onClick={() => setExpanded(expanded === row.upc ? null : row.upc)}
                >
                  <td className="p-2 text-muted-foreground">
                    {expanded === row.upc ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  </td>
                  <td className="p-2">
                    <div className="font-medium leading-snug">{row.title}</div>
                    <div className="text-xs text-muted-foreground">{row.brand} · UPC {row.upc}</div>
                  </td>
                  {RETAILER_IDS.map((r) => (
                    <td key={r} className="p-2 text-right align-middle">
                      <PriceCell o={row.prices[r]} row={row} />
                    </td>
                  ))}
                  <td className="p-2 text-right tabular-nums text-muted-foreground">
                    {row.min != null && row.max != null && row.max > row.min
                      ? `${(((row.max - row.min) / row.min) * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="p-2">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Refresh this SKU"
                      disabled={running || starting}
                      onClick={(e) => {
                        e.stopPropagation();
                        startRun([row.upc]);
                      }}
                    >
                      <RefreshCw />
                    </Button>
                  </td>
                </tr>
                {expanded === row.upc && (
                  <tr className="border-t bg-muted/20">
                    <td colSpan={9} className="p-4">
                      <SkuDetail row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {data && rows.length === 0 && (
              <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">No SKUs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function BrandChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active ? "border-foreground bg-foreground text-background" : "hover:bg-muted"
      }`}
    >
      {children}
    </button>
  );
}

function RunProgress({ run }: { run: Run }) {
  const pct = run.total ? (run.completed / run.total) * 100 : 0;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" /> Refreshing prices… {run.completed} / {run.total} lookups
          {run.failed > 0 && <span className="text-rose-600"> · {run.failed} failed</span>}
        </span>
        <span className="text-muted-foreground tabular-nums">Exa spend ${run.costUsd.toFixed(2)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const OUTCOME_META: Record<RetrievalOutcome, { label: string; hint: string; bar: string; text: string }> = {
  confident: {
    label: "Retrieved",
    hint: "Exact-SKU price at high or medium confidence",
    bar: "bg-emerald-500",
    text: "text-emerald-600",
  },
  low_confidence: {
    label: "Low confidence",
    hint: "Exact-SKU price, but low confidence (e.g. third-party source, or price not found verbatim on the page)",
    bar: "bg-amber-400",
    text: "text-amber-600",
  },
  blocked: {
    label: "Blocked / missed",
    hint: "Retailer probably sells it, but Exa didn't get a price: price hidden from the crawler (Target, Kroger \"Prices May Vary\"), search found nothing usable, or the lookup errored",
    bar: "bg-rose-500",
    text: "text-rose-600",
  },
  unavailable: {
    label: "Not available",
    hint: "Justifiably no price: the retailer doesn't carry this exact SKU/size, or shows the listing as unavailable",
    bar: "bg-slate-400 dark:bg-slate-500",
    text: "text-muted-foreground",
  },
  not_checked: { label: "Not checked", hint: "No lookup yet", bar: "bg-muted", text: "text-muted-foreground" },
};

function RetrievalPanel({ r }: { r: RetrievalSummary }) {
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
  // Of the prices that exist to be found (everything but justified unavailables), how many did Exa get?
  const findable = r.total - r.unavailable - r.not_checked;
  const shown = RETRIEVAL_ORDER.filter((k) => k !== "not_checked" || r.not_checked > 0);
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">Exa retrieval</h2>
        <p className="text-xs text-muted-foreground">
          Latest lookup per SKU × retailer · {r.total} prices wanted
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Retrieved (any confidence)"
          value={`${r.retrieved}/${r.total}`}
          sub={`${pct(r.retrieved, r.total)} of all · ${pct(r.retrieved, findable)} of findable`}
          hint="Findable = all prices wanted minus the justifiably unavailable ones"
        />
        {shown.map((k) => (
          <Stat
            key={k}
            label={OUTCOME_META[k].label}
            value={String(r[k])}
            sub={`${pct(r[k], r.total)} of wanted`}
            hint={OUTCOME_META[k].hint}
            className={OUTCOME_META[k].text}
            dot={OUTCOME_META[k].bar}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        {r.byRetailer.map((c) => (
          <div key={c.retailer} className="grid grid-cols-[80px_1fr_44px] items-center gap-2 text-xs">
            <span className="text-muted-foreground">{RETAILERS[c.retailer].name}</span>
            <div className="flex h-3 overflow-hidden rounded-full bg-muted">
              {RETRIEVAL_ORDER.map((k) =>
                c[k] ? (
                  <div
                    key={k}
                    className={OUTCOME_META[k].bar}
                    style={{ width: `${(c[k] / c.total) * 100}%` }}
                    title={`${RETAILERS[c.retailer].name} · ${OUTCOME_META[k].label}: ${c[k]} of ${c.total}`}
                  />
                ) : null,
              )}
            </div>
            <span className="text-right tabular-nums">{pct(c.retrieved, c.total)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const RETRIEVAL_ORDER: RetrievalOutcome[] = ["confident", "low_confidence", "blocked", "unavailable", "not_checked"];

function Stat({
  label,
  value,
  sub,
  hint,
  className = "",
  dot,
}: {
  label: string;
  value: string;
  sub: string;
  hint: string;
  className?: string;
  dot?: string;
}) {
  return (
    <div className="space-y-0.5" title={hint}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {dot && <span className={`size-2 rounded-full ${dot}`} />}
        {label}
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${className}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}

function RetailerCards({ summaries, total }: { summaries: RetailerSummary[]; total: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {summaries.map((s) => {
        const idx = s.avgIndexPct;
        return (
          <div key={s.retailer} className="space-y-1 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{RETAILERS[s.retailer].name}</span>
              {RETAILERS[s.retailer].priceVia === "deep_search" && (
                <Badge variant="outline" className="text-[10px]" title="Prices from third-party sources via Exa deep search">3rd-party</Badge>
              )}
            </div>
            <div
              className={`text-2xl font-semibold tabular-nums ${
                idx == null ? "text-muted-foreground" : idx < -0.5 ? "text-emerald-600" : idx > 0.5 ? "text-rose-600" : ""
              }`}
            >
              {idx == null ? "—" : `${idx > 0 ? "+" : ""}${idx.toFixed(1)}%`}
            </div>
            <div className="text-xs text-muted-foreground">
              vs. cross-retailer median{s.comparedSkus ? ` (${s.comparedSkus} SKUs)` : ""}
            </div>
            <div className="text-xs text-muted-foreground">
              {s.priced}/{total} priced · lowest on {s.lowestCount} · highest on {s.highestCount}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span><span className="font-medium text-emerald-600">$0.00</span> lowest</span>
      <span><span className="font-medium text-rose-600">$0.00</span> highest</span>
      <span><Tag className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">3P</Tag> third-party source</span>
      <span><span className="text-muted-foreground">no match</span> = UPC / exact size not found at that retailer</span>
      <span><Tag className="bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300">pack ÷2</Tag> only a different pack sold; price normalized to this SKU</span>
      <span><Tag className="bg-muted text-muted-foreground">low</Tag> low confidence</span>
      <span><Tag className="bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">OOS</Tag> out of stock</span>
      <span>Spread = (max − min) / min across exact matches</span>
    </div>
  );
}

function Tag({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`ml-1 rounded px-1 py-px text-[10px] font-medium ${className}`}>{children}</span>;
}

function PriceCell({ o, row }: { o?: Observation; row: SkuRow }) {
  if (!o) return <span className="text-muted-foreground/50">—</span>;
  if (o.status === "error") return <span className="text-xs text-rose-600" title={o.notes ?? ""}>error</span>;
  if (o.status === "not_listed") return <span className="text-xs text-muted-foreground" title={o.notes ?? ""}>no match</span>;
  if (o.status === "no_price" || o.price == null)
    return <span className="text-xs text-muted-foreground" title={o.notes ?? ""}>listed, no price</span>;

  const comparable = isComparable(o) && row.min !== row.max;
  const color = comparable && o.price === row.min ? "text-emerald-600" : comparable && o.price === row.max ? "text-rose-600" : "";
  return (
    <div className="leading-tight" title={o.notes ?? ""}>
      <span className={`font-medium tabular-nums ${color} ${o.matchType !== "exact" ? "text-muted-foreground" : ""}`}>
        {usd(o.price)}
      </span>
      {o.regularPrice != null && o.regularPrice > o.price && (
        <div className="text-[11px] text-muted-foreground line-through tabular-nums">{usd(o.regularPrice)}</div>
      )}
      <div>
        {o.packRatio != null && (
          <Tag className="bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300">
            pack {packLabel(o.packRatio)}
          </Tag>
        )}
        {o.source === "third_party" && <Tag className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300">3P</Tag>}
        {o.confidence === "low" && <Tag className="bg-muted text-muted-foreground">low</Tag>}
        {o.availability === "out_of_stock" && <Tag className="bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">OOS</Tag>}
      </div>
    </div>
  );
}

function SkuDetail({ row }: { row: SkuRow }) {
  const [history, setHistory] = useState<Observation[] | null>(null);
  useEffect(() => {
    fetch(`/api/history?upc=${row.upc}`)
      .then((r) => r.json())
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [row.upc, row.prices]);

  return (
    <div className="grid gap-3 md:grid-cols-5">
      {RETAILER_IDS.map((r) => {
        const o = row.prices[r];
        const past = (history ?? []).filter((h) => h.retailer === r && h.status === "priced" && h.price != null);
        return (
          <div key={r} className="space-y-2 rounded-md border bg-background p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{RETAILERS[r as RetailerId].name}</span>
              {o?.upcVerified && (
                <span className="flex items-center gap-1 text-emerald-600" title="UPC on the retailer page matches">
                  <ShieldCheck className="size-3.5" /> UPC
                </span>
              )}
            </div>
            {!o ? (
              <p className="text-muted-foreground">Not checked yet.</p>
            ) : (
              <>
                {o.url && (
                  <a href={o.url} target="_blank" rel="noreferrer" className="flex items-start gap-1 text-sky-700 hover:underline dark:text-sky-400">
                    <span className="line-clamp-2">{o.productTitle || o.url}</span>
                    <ExternalLink className="mt-0.5 size-3 shrink-0" />
                  </a>
                )}
                <p className="text-muted-foreground">{o.notes}</p>
                <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  <dt className="text-muted-foreground">Match</dt><dd>{o.matchType ?? "—"}</dd>
                  <dt className="text-muted-foreground">Confidence</dt><dd>{o.confidence ?? "—"}</dd>
                  <dt className="text-muted-foreground">Source</dt><dd>{o.source === "third_party" ? "third-party" : o.source === "retailer_page" ? "retailer page" : "—"}</dd>
                  <dt className="text-muted-foreground">Stock</dt><dd>{o.availability ?? "—"}</dd>
                  {o.packRatio != null && o.listedPrice != null && (
                    <><dt className="text-muted-foreground">Pack price</dt><dd>{usd(o.listedPrice)} {packLabel(o.packRatio)}</dd></>
                  )}
                  {o.promo && (<><dt className="text-muted-foreground">Promo</dt><dd>{o.promo}</dd></>)}
                  <dt className="text-muted-foreground">Observed</dt><dd>{new Date(o.observedAt).toLocaleDateString()}</dd>
                </dl>
                {o.citations && o.citations.length > 0 && (
                  <div>
                    <div className="text-muted-foreground">Price sources</div>
                    {o.citations.slice(0, 3).map((c) => (
                      <a key={c} href={c} target="_blank" rel="noreferrer" className="block truncate text-sky-700 hover:underline dark:text-sky-400">
                        {new URL(c).hostname}
                      </a>
                    ))}
                  </div>
                )}
                {past.length > 1 && (
                  <div>
                    <div className="text-muted-foreground">History</div>
                    {past.slice(0, 6).map((h) => (
                      <div key={h.id} className="flex justify-between tabular-nums">
                        <span className="text-muted-foreground">{new Date(h.observedAt).toLocaleDateString()}</span>
                        <span>{usd(h.price!)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
