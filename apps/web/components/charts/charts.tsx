import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/components/ui";

// Grafici leggeri renderizzati sul server: niente librerie, niente JavaScript nel browser.
// Regole: una sola tinta per serie (teal); il rosso «pericolo» solo per gli elementi da correggere,
// sempre accompagnato da un'etichetta; valori in testo (mai colore da solo); tooltip nativi (<title>).

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  /** Testo del valore (già formattato) */
  display: string;
  /** Dettaglio secondario sotto l'etichetta */
  hint?: string;
  href?: string;
  /** Elemento su cui intervenire: barra in rosso + etichetta */
  flag?: string;
}

/** Barre orizzontali con etichette e valori in testo: leggibili su telefono e accessibili. */
export function BarList({
  data,
  target,
  targetLabel,
  emptyText = "Nessun dato nel periodo.",
  max: forcedMax,
}: {
  data: BarDatum[];
  /** Linea di riferimento (es. obiettivo minuti) */
  target?: number;
  targetLabel?: string;
  emptyText?: string;
  max?: number;
}) {
  if (data.length === 0) return <p className="px-4 py-6 text-center text-sm text-muted">{emptyText}</p>;
  const max = Math.max(forcedMax ?? 0, target ?? 0, ...data.map((d) => Math.abs(d.value)), 0) || 1;
  return (
    <ul className="space-y-2.5 px-4 py-3" role="list">
      {data.map((d) => {
        const w = Math.max((Math.abs(d.value) / max) * 100, d.value === 0 ? 0 : 1.5);
        const label = d.href ? (
          <Link href={d.href} className="font-bold text-night underline-offset-4 hover:underline">{d.label}</Link>
        ) : (
          <span className="font-bold text-night">{d.label}</span>
        );
        return (
          <li key={d.key} title={`${d.label}: ${d.display}`}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {label}
                {d.flag && <span className="ml-2 rounded-full bg-danger-soft px-2 py-0.5 text-[0.7rem] font-bold text-danger">▲ {d.flag}</span>}
              </span>
              <span className="shrink-0 font-extrabold text-night tabular-nums">{d.display}</span>
            </div>
            <div className="relative mt-1 h-2.5 rounded-r-[4px] bg-sand/60">
              <div className={cx("h-2.5 rounded-r-[4px]", d.flag ? "bg-danger" : "bg-teal")} style={{ width: `${w}%` }} />
              {target != null && target > 0 && (
                <div className="absolute -top-1 h-[18px] w-0.5 bg-night" style={{ left: `calc(${(target / max) * 100}% - 1px)` }} aria-hidden />
              )}
            </div>
            {d.hint && <p className="mt-0.5 text-xs text-muted">{d.hint}</p>}
          </li>
        );
      })}
      {target != null && targetLabel && (
        <li className="flex items-center gap-2 pt-1 text-xs text-muted">
          <span className="inline-block h-3 w-0.5 bg-night" aria-hidden /> {targetLabel}
        </li>
      )}
    </ul>
  );
}

export interface ColumnDatum {
  key: string;
  /** Etichetta breve sull'asse (es. «lun 6») */
  label: string;
  value: number;
  display: string;
  flag?: boolean;
}

/** Colonne verticali in SVG (serie giornaliera). Tooltip nativo su ogni colonna; massimo etichettato. */
export function ColumnChart({ data, height = 140, ariaLabel }: { data: ColumnDatum[]; height?: number; ariaLabel: string }) {
  if (data.length === 0) return null;
  const W = Math.max(data.length * 28, 280);
  const top = 18;
  const bottom = 22;
  const plotH = height - top - bottom;
  const max = Math.max(...data.map((d) => d.value), 0);
  const scale = max > 0 ? plotH / max : 0;
  const band = W / data.length;
  const barW = Math.min(24, Math.max(band - 4, 3));
  const maxIdx = data.findIndex((d) => d.value === max && max > 0);
  const labelEvery = Math.ceil(data.length / 10);
  return (
    <figure className="px-4 py-3">
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-label={ariaLabel}>
        <line x1={0} x2={W} y1={top + plotH + 0.5} y2={top + plotH + 0.5} stroke="var(--color-sand-deep)" strokeWidth={1} />
        {data.map((d, i) => {
          const h = Math.max(d.value * scale, d.value > 0 ? 2 : 0);
          const x = i * band + (band - barW) / 2;
          const y = top + plotH - h;
          const r = Math.min(4, h / 2, barW / 2);
          // colonna con estremità arrotondata (4px) e base squadrata
          const path =
            h > 0
              ? `M${x},${top + plotH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${top + plotH} Z`
              : "";
          return (
            <g key={d.key}>
              <rect x={i * band} y={top} width={band} height={plotH} fill="transparent">
                <title>{`${d.label}: ${d.display}`}</title>
              </rect>
              {path && (
                <path d={path} fill={d.flag ? "var(--color-danger)" : "var(--color-teal)"}>
                  <title>{`${d.label}: ${d.display}`}</title>
                </path>
              )}
              {i === maxIdx && (
                <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--color-ink)">
                  {d.display}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={i * band + band / 2} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/** Riquadro «Dove intervenire»: la decisione che il grafico supporta. */
export function DecisionNote({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "danger" | "ok" }) {
  return (
    <div
      className={cx(
        "mx-4 mb-4 rounded-xl px-3 py-2.5 text-sm",
        tone === "danger" ? "bg-danger-soft text-ink" : tone === "ok" ? "bg-ok-soft text-ink" : "bg-warm text-ink",
      )}
    >
      <span className="mr-1 font-bold text-night">Dove intervenire:</span>
      {children}
    </div>
  );
}

/** Variazione rispetto al periodo precedente; il colore dice se è un bene o un male (con freccia e segno). */
export function Delta({ value, goodWhenUp = true, suffix = "%" }: { value: number | null; goodWhenUp?: boolean; suffix?: string }) {
  if (value == null) return <span className="text-xs text-muted">nessun confronto</span>;
  if (value === 0) return <span className="text-xs font-bold text-muted">= invariato</span>;
  const up = value > 0;
  const good = up === goodWhenUp;
  const txt = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1, signDisplay: "always" }).format(value);
  return (
    <span className={cx("text-xs font-bold", good ? "text-ok" : "text-danger")}>
      {up ? "▲" : "▼"} {txt}
      {suffix}
    </span>
  );
}

/** Riquadro KPI: etichetta, valore, variazione e dettaglio. */
export function StatTile({ label, value, delta, hint }: { label: string; value: string; delta?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-sand-deep/70 bg-white p-3.5">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className="mt-1 text-xl font-extrabold text-night tabular-nums">{value}</p>
      {delta && <div className="mt-0.5">{delta}</div>}
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
