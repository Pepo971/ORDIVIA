import Link from "next/link";
import { addDays, mapLayout, POINT_STATE_LABEL, type PointDay, type PointState } from "@ordivia/domain";
import { Tabs, cx } from "@/components/ui";
import { can, type AppContext } from "@/lib/context";
import { formatDate } from "@/lib/format";
import type { BeachPoint } from "@/lib/beach-queries";

/** Schede interne della Spiaggia: lo spiaggino vede la giornata e le prenotazioni, il responsabile anche il resto. */
export function BeachTabs({ ctx, active }: { ctx: AppContext; active: string }) {
  const manage = can(ctx, "beach.manage");
  const items = [
    { key: "giornata", label: "Giornata", href: "/servizio/spiaggia" },
    { key: "prenotazioni", label: "Prenotazioni", href: "/servizio/spiaggia/prenotazioni" },
    ...(manage
      ? [
          { key: "riepilogo", label: "Riepilogo", href: "/servizio/spiaggia/riepilogo" },
          { key: "mappa", label: "Mappa", href: "/servizio/spiaggia/mappa" },
          { key: "listino", label: "Listino", href: "/servizio/spiaggia/listino" },
        ]
      : []),
  ];
  return <Tabs items={items} active={active} />;
}

// Colori ad alto contrasto, leggibili sotto il sole.
export const STATE_STYLE: Record<PointState, string> = {
  libero: "bg-white text-night border-2 border-night/60",
  prenotato: "bg-teal text-white border-2 border-teal-deep",
  presente: "bg-ok text-white border-2 border-ok",
  abbonato: "bg-night text-warm border-2 border-night",
  fuori_servizio: "bg-danger-soft text-danger border-2 border-dashed border-danger",
};

export function Legend({ counts }: { counts?: Partial<Record<PointState, number>> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold text-night" aria-label="Legenda">
      {(Object.keys(STATE_STYLE) as PointState[]).map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={cx("inline-block h-5 w-5 rounded-md", STATE_STYLE[s])} aria-hidden />
          {POINT_STATE_LABEL[s]}
          {counts && <span className="text-muted">{counts[s] ?? 0}</span>}
        </li>
      ))}
    </ul>
  );
}

export function DateNav({ date, today, basePath, extra = "" }: { date: string; today: string; basePath: string; extra?: string }) {
  const link = (d: string) => `${basePath}?data=${d}${extra}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={link(addDays(date, -1))} className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-night bg-white text-xl font-bold text-night" aria-label="Giorno precedente">
        ‹
      </Link>
      <form action={basePath} className="flex items-center gap-2">
        <label className="sr-only" htmlFor="beach-date">Data</label>
        <input
          id="beach-date"
          type="date"
          name="data"
          defaultValue={date}
          className="h-12 rounded-xl border-2 border-night bg-white px-3 text-base font-bold text-night"
        />
        <button className="h-12 rounded-xl bg-night px-4 font-bold text-warm">Vai</button>
      </form>
      <Link href={link(addDays(date, 1))} className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-night bg-white text-xl font-bold text-night" aria-label="Giorno successivo">
        ›
      </Link>
      {date !== today && (
        <Link href={link(today)} className="flex h-12 items-center rounded-xl bg-sand px-4 font-bold text-night">
          Oggi
        </Link>
      )}
      <span className="font-display text-lg font-semibold text-night">{date === today ? "Oggi, " : ""}{formatDate(date)}</span>
    </div>
  );
}

/** Mappa a griglia: settori, file (fila 1 verso il mare), posizione nella fila. */
export function BeachMap({
  points,
  states,
  hrefFor,
  selected,
}: {
  points: BeachPoint[];
  states: Map<string, PointDay>;
  hrefFor: (p: BeachPoint) => string;
  selected?: string | null;
}) {
  const layout = mapLayout(points);
  return (
    <div className="space-y-6">
      {layout.map((z) => {
        const maxX = Math.max(1, ...z.rows.flatMap((r) => r.points.map((p) => p.pos_x ?? 0)), ...z.rows.map((r) => r.points.length));
        return (
          <section key={z.zone} aria-label={`Settore ${z.zone}`}>
            <h2 className="mb-2 font-display text-xl font-semibold text-night">Settore {z.zone}</h2>
            <div className="overflow-x-auto pb-2">
              <div className="min-w-max">
                <div className="mb-1.5 rounded-lg bg-teal-soft py-1 text-center text-xs font-bold tracking-widest text-teal-deep uppercase" aria-hidden>
                  Mare
                </div>
                {z.rows.map((r) => (
                  <div key={r.row} className="mb-1.5 flex items-center gap-1.5">
                    <span className="w-8 shrink-0 text-right text-xs font-bold text-muted" title={`Fila ${r.row}`}>
                      {r.row}
                    </span>
                    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${maxX}, 3rem)` }}>
                      {r.points.map((p, i) => {
                        const s = states.get(p.id);
                        const st = s?.state ?? "libero";
                        const half = s && s.freeSlot && s.freeSlot !== "intera" && st !== "libero";
                        return (
                          <Link
                            key={p.id}
                            href={hrefFor(p)}
                            scroll={false}
                            style={{ gridColumn: p.pos_x && p.pos_x <= maxX ? Math.round(p.pos_x) : i + 1 }}
                            aria-label={`${p.kind} ${p.label}: ${POINT_STATE_LABEL[st]}${half ? `, libero il ${s!.freeSlot}` : ""}`}
                            aria-current={selected === p.id ? "true" : undefined}
                            className={cx(
                              "relative flex h-12 w-12 items-center justify-center rounded-lg text-sm font-extrabold",
                              STATE_STYLE[st],
                              selected === p.id && "ring-4 ring-warn ring-offset-2",
                            )}
                          >
                            {p.label}
                            {half && (
                              <span className="absolute -top-1.5 -right-1.5 rounded-full bg-warn px-1 text-[0.65rem] leading-4 text-white" aria-hidden>
                                ½
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
