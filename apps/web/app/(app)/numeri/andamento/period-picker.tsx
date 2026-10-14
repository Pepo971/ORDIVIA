import Link from "next/link";
import { PERIOD_OPTIONS, type Period } from "@ordivia/domain";
import { cx } from "@/components/ui";
import { formatDate } from "@/lib/format";

/** Selettore del periodo: scorciatoie come link (funziona senza JavaScript) e date libere con un form GET. */
export function PeriodPicker({ period, basePath, tz }: { period: Period; basePath: string; tz: string }) {
  return (
    <div className="mb-5 space-y-3">
      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-sand p-1" aria-label="Periodo">
        {PERIOD_OPTIONS.filter((o) => o.key !== "personalizzato").map((o) => (
          <Link
            key={o.key}
            href={`${basePath}?periodo=${o.key}`}
            aria-current={period.key === o.key ? "page" : undefined}
            className={cx(
              "flex min-h-11 items-center rounded-lg px-3.5 text-sm font-bold whitespace-nowrap",
              period.key === o.key ? "bg-white text-night shadow-sm" : "text-muted hover:text-night",
            )}
          >
            {o.label}
          </Link>
        ))}
      </nav>
      <details className="rounded-xl border border-sand-deep bg-white px-3 py-2" open={period.key === "personalizzato"}>
        <summary className="cursor-pointer text-sm font-bold text-night">
          {period.label}: {period.from === period.to ? formatDate(period.from, tz) : `${formatDate(period.from, tz)} – ${formatDate(period.to, tz)}`}
          <span className="font-normal text-muted"> · confronto con {period.prev.label}</span>
        </summary>
        <form action={basePath} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="periodo" value="personalizzato" />
          <label className="text-sm">
            <span className="mb-1 block font-bold text-night">Dal</span>
            <input type="date" name="dal" defaultValue={period.from} className="h-11 rounded-xl border border-sand-deep px-3" required />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-bold text-night">Al</span>
            <input type="date" name="al" defaultValue={period.to} className="h-11 rounded-xl border border-sand-deep px-3" required />
          </label>
          <button className="h-11 rounded-xl bg-night px-4 text-sm font-bold text-warm">Mostra</button>
        </form>
      </details>
    </div>
  );
}

export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 }).format(v)}%`);
export const fmtNum = (v: number | null | undefined, digits = 1) => (v == null ? "—" : new Intl.NumberFormat("it-IT", { maximumFractionDigits: digits }).format(v));
export const fmtMin = (v: number | null | undefined) => (v == null ? "—" : `${fmtNum(v)} min`);
