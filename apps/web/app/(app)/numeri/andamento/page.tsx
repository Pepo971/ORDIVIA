import { pctChange, resolvePeriod } from "@ordivia/domain";
import { BarList, ColumnChart, DecisionNote, Delta, StatTile } from "@/components/charts/charts";
import { Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { getEconomic, getOperational, type Economic, type Operational } from "@/lib/analytics-queries";
import { can, requirePerm } from "@/lib/context";
import { formatEur, formatQty } from "@/lib/format";
import { today } from "@/lib/queries";
import { fmtMin, fmtNum, fmtPct, PeriodPicker } from "./period-picker";

export const metadata = { title: "Andamento" };
export const dynamic = "force-dynamic";

const BASE = "/numeri/andamento";

function dayLabel(d: string) {
  return new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", weekday: "short", day: "numeric" }).format(new Date(`${d}T12:00:00Z`));
}

export default async function AndamentoPage({ searchParams }: { searchParams: Promise<{ periodo?: string; dal?: string; al?: string }> }) {
  const ctx = await requirePerm("analytics.view", "finance.view");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const period = resolvePeriod(sp.periodo, today(ctx), { from: sp.dal, to: sp.al });
  const finance = can(ctx, "finance.view");

  const [op, opPrev, ec, ecPrev] = await Promise.all([
    getOperational(ctx.facility.id, period.from, period.to),
    getOperational(ctx.facility.id, period.prev.from, period.prev.to),
    getEconomic(ctx, period.from, period.to),
    getEconomic(ctx, period.prev.from, period.prev.to),
  ]);

  return (
    <div>
      <PageHeader title="Andamento" subtitle={`${ctx.facility.name} · numeri calcolati dai dati registrati, confrontati con il periodo precedente equivalente.`} />
      <PeriodPicker period={period} basePath={BASE} tz={tz} />

      {op.error !== null ? (
        <Notice tone="danger">{op.error}</Notice>
      ) : (
        <OperationalSection op={op.data} prev={opPrev.error === null ? opPrev.data : null} days={period.days} />
      )}

      {finance && ec && (
        <section className="mt-8">
          <h2 className="mb-1 font-display text-xl font-semibold text-night">Numeri economici</h2>
          <p className="mb-4 text-sm text-muted">Visibili solo a chi ha accesso ai dati economici. Importi IVA inclusa dove non indicato.</p>
          {ec.error !== null ? (
            <Notice tone="danger">{ec.error}</Notice>
          ) : (
            <EconomicSection ec={ec.data} prev={ecPrev && ecPrev.error === null ? ecPrev.data : null} days={period.days} />
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Operativo
// ---------------------------------------------------------------------------

function OperationalSection({ op, prev, days }: { op: Operational; prev: Operational | null; days: number }) {
  const hasService = op.orders > 0;
  const hasAnything =
    hasService || op.waste.length > 0 || op.adjustments.length > 0 || op.haccp.readings > 0 || op.tasks.due > 0 || (op.beach?.bookings ?? 0) > 0;

  if (!hasAnything) {
    return (
      <Card>
        <EmptyState
          title="Ancora nessun dato in questo periodo"
          text="I numeri compaiono quando registri comande in sala o cassa, movimenti di magazzino, temperature HACCP o attività. Non stimiamo nulla senza dati."
          action={<LinkButton href="/servizio" variant="secondary">Vai al servizio</LinkButton>}
        />
      </Card>
    );
  }

  const target = op.ticket_target_minutes;
  const stations = op.service.filter((s) => s.avg_served_min != null);
  const slow = stations.filter((s) => (s.avg_served_min ?? 0) > target);
  const sold = op.items.filter((i) => i.qty > 0);
  const top = sold.slice(0, 5);
  const bottom = [...op.items].filter((i) => i.menu_item_id).sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name, "it")).slice(0, 5);
  const avgPerOrder = op.orders > 0 ? op.covers / op.orders : null;

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Coperti" value={fmtNum(op.covers, 0)} delta={<Delta value={pctChange(op.covers, prev?.covers)} />} hint={avgPerOrder != null ? `${fmtNum(avgPerOrder)} per comanda` : undefined} />
        <StatTile label="Comande" value={fmtNum(op.orders, 0)} delta={<Delta value={pctChange(op.orders, prev?.orders)} />} hint={`${fmtNum(op.items_sold, 0)} pezzi venduti`} />
        {op.beach ? (
          <StatTile
            label="Occupazione spiaggia"
            value={fmtPct(op.beach.occupancy_pct)}
            delta={<Delta value={op.beach.occupancy_pct != null && prev?.beach?.occupancy_pct != null ? Math.round((op.beach.occupancy_pct - prev.beach.occupancy_pct) * 10) / 10 : null} suffix=" punti" />}
            hint={`${op.beach.points} postazioni${op.beach.no_show ? ` · ${op.beach.no_show} non presentati` : ""}`}
          />
        ) : (
          <StatTile label="Attività in tempo" value={fmtPct(op.tasks.on_time_pct)} hint={`${op.tasks.on_time} su ${op.tasks.due} in scadenza`} />
        )}
        {op.reservations ? (
          <StatTile
            label="No-show prenotazioni"
            value={fmtPct(op.reservations.no_show_pct)}
            delta={<Delta value={op.reservations.no_show_pct != null && prev?.reservations?.no_show_pct != null ? Math.round((op.reservations.no_show_pct - prev.reservations.no_show_pct) * 10) / 10 : null} goodWhenUp={false} suffix=" punti" />}
            hint={`${op.reservations.no_show} su ${op.reservations.reservations} prenotazioni`}
          />
        ) : (
          <StatTile
            label="HACCP fuori limite"
            value={fmtNum(op.haccp.out_of_range, 0)}
            delta={<Delta value={pctChange(op.haccp.out_of_range, prev?.haccp.out_of_range)} goodWhenUp={false} />}
            hint={`${op.haccp.readings} rilevazioni`}
          />
        )}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {op.beach && <StatTile label="Attività in tempo" value={fmtPct(op.tasks.on_time_pct)} hint={`${op.tasks.on_time} su ${op.tasks.due} in scadenza${op.tasks.open_overdue ? ` · ${op.tasks.open_overdue} scadute aperte` : ""}`} />}
        {op.reservations && (
          <StatTile label="HACCP fuori limite" value={fmtNum(op.haccp.out_of_range, 0)} delta={<Delta value={pctChange(op.haccp.out_of_range, prev?.haccp.out_of_range)} goodWhenUp={false} />} hint={`${op.haccp.readings} rilevazioni`} />
        )}
        {!op.beach && op.tasks.open_overdue > 0 && <StatTile label="Attività scadute aperte" value={fmtNum(op.tasks.open_overdue, 0)} />}
        {op.haccp.without_action > 0 && <StatTile label="Senza azione correttiva" value={fmtNum(op.haccp.without_action, 0)} hint="temperature fuori limite" />}
        {!op.reservations && <StatTile label="No-show" value="—" hint="disponibile con il modulo prenotazioni" />}
      </div>

      {days > 1 && hasService && (
        <Card className="mb-5">
          <CardHeader title="Coperti per giorno" hint="Per organizzare turni e preparazioni sui giorni forti" />
          <ColumnChart
            ariaLabel="Coperti per giorno"
            data={op.daily.map((d) => ({ key: d.d, label: dayLabel(d.d), value: d.covers, display: `${fmtNum(d.covers, 0)} coperti` }))}
          />
          {(() => {
            const withCovers = op.daily.filter((d) => d.covers > 0);
            if (withCovers.length < 2) return null;
            const best = withCovers.reduce((a, b) => (b.covers > a.covers ? b : a));
            const worst = withCovers.reduce((a, b) => (b.covers < a.covers ? b : a));
            return (
              <DecisionNote>
                il giorno più pieno è stato {dayLabel(best.d)} ({fmtNum(best.covers, 0)} coperti), il più scarico {dayLabel(worst.d)} ({fmtNum(worst.covers, 0)}): allinea turni e preparazioni.
              </DecisionNote>
            );
          })()}
        </Card>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader title="Tempo di servizio per postazione" hint="Media da comanda inviata a piatto servito" />
          <BarList
            data={stations.map((s) => ({
              key: s.station_id,
              label: s.name,
              value: s.avg_served_min ?? 0,
              display: fmtMin(s.avg_served_min),
              hint: `${s.lines_served} righe servite · pronto in ${fmtMin(s.avg_ready_min)} · 1 su 10 oltre ${fmtMin(s.p90_served_min)}`,
              flag: (s.avg_served_min ?? 0) > target ? "oltre obiettivo" : undefined,
            }))}
            target={target}
            targetLabel={`Obiettivo ${target} minuti`}
            emptyText="Nessun piatto servito con tempi registrati nel periodo."
          />
          {stations.length > 0 && (
            <DecisionNote tone={slow.length ? "danger" : "ok"}>
              {slow.length
                ? `${slow.map((s) => s.name).join(", ")} ${slow.length === 1 ? "è più lenta" : "sono più lente"} dell'obiettivo: rivedi la linea, le preparazioni anticipate o il personale nelle ore di punta.`
                : "tutte le postazioni sono entro l'obiettivo."}
            </DecisionNote>
          )}
        </Card>

        <Card>
          <CardHeader title="Più venduti" hint="Pezzi venduti nel periodo" />
          <BarList data={top.map((i) => ({ key: i.menu_item_id ?? i.name, label: i.name, value: i.qty, display: `${fmtNum(i.qty, 0)} pz` }))} emptyText="Nessuna vendita nel periodo." />
          {bottom.length > 0 && sold.length > 0 && (
            <>
              <h3 className="border-t border-sand px-4 pt-3 text-sm font-bold text-night">Meno venduti</h3>
              <BarList
                data={bottom.map((i) => ({ key: `b-${i.menu_item_id}`, label: i.name, value: i.qty, display: `${fmtNum(i.qty, 0)} pz`, flag: i.qty === 0 ? "mai venduto" : undefined }))}
                max={top[0]?.qty}
              />
              <DecisionNote>
                le voci in fondo occupano spazio nel menu e in magazzino: valuta di toglierle, cambiarne la posizione o prepararle solo su richiesta.
              </DecisionNote>
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Sprechi e scaduti" hint="Quantità registrate come spreco o scaduto" />
          <BarList
            data={op.waste.slice(0, 8).map((w, i) => ({
              key: w.product_id,
              label: w.name,
              value: w.qty,
              display: formatQty(w.qty, w.unit),
              hint: `${w.movements} registrazioni`,
              flag: i < 3 ? "da ridurre" : undefined,
            }))}
            emptyText="Nessuno spreco registrato nel periodo."
          />
          {op.waste.length > 0 && <DecisionNote>parti dai primi 3 prodotti: riduci le quantità ordinate o preparate e controlla la rotazione (primo entrato, primo uscito).</DecisionNote>}
        </Card>

        <Card>
          <CardHeader title="Differenze di inventario" hint="Rettifiche: contato meno quantità a sistema" />
          <BarList
            data={op.adjustments.slice(0, 8).map((a) => ({
              key: a.product_id,
              label: a.name,
              value: a.qty,
              display: `${a.qty > 0 ? "+" : ""}${formatQty(a.qty, a.unit)}`,
              flag: a.qty < 0 ? "ammanco" : undefined,
            }))}
            emptyText="Nessuna rettifica di inventario nel periodo."
          />
          {op.adjustments.some((a) => a.qty < 0) && (
            <DecisionNote tone="danger">gli ammanchi ricorrenti indicano scarichi non registrati, porzioni più grandi della ricetta o ammanchi: verifica le ricette e chi registra gli scarichi.</DecisionNote>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Economico (solo finance.view: la RPC lo verifica nel database)
// ---------------------------------------------------------------------------

function EconomicSection({ ec, prev, days }: { ec: Economic; prev: Economic | null; days: number }) {
  const hasSales = ec.revenue > 0 || ec.items.length > 0;
  const hasAny = hasSales || ec.suppliers.length > 0 || ec.labour.hours > 0 || ec.waste.value > 0;
  if (!hasAny) {
    return (
      <Card>
        <EmptyState title="Nessun incasso o costo registrato nel periodo" text="Incassi, spesa fornitori, costo del personale e valore degli sprechi compaiono man mano che li registri." />
      </Card>
    );
  }

  const withMargin = ec.items.filter((i) => i.margin != null && i.missing_costs === 0);
  const worst = withMargin.slice(0, 3); // la RPC ordina per margine crescente
  const fc = ec.food_cost;
  const labourPct = ec.labour.cost != null && ec.revenue > 0 ? (ec.labour.cost / ec.revenue) * 100 : null;
  const prevLabourPct = prev && prev.labour.cost != null && prev.revenue > 0 ? (prev.labour.cost / prev.revenue) * 100 : null;

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Incassi" value={formatEur(ec.revenue)} delta={<Delta value={pctChange(ec.revenue, prev?.revenue)} />} hint={`cassa ${formatEur(ec.revenue_pos)} · spiaggia ${formatEur(ec.revenue_beach)}`} />
        <StatTile label="Scontrino medio" value={formatEur(ec.avg_ticket)} delta={<Delta value={pctChange(ec.avg_ticket, prev?.avg_ticket)} />} hint={ec.avg_per_cover != null ? `${formatEur(ec.avg_per_cover)} a coperto` : `${ec.orders_closed} comande chiuse`} />
        <StatTile
          label="Food cost teorico"
          value={fmtPct(fc.food_cost_pct)}
          delta={<Delta value={fc.food_cost_pct != null && prev?.food_cost.food_cost_pct != null ? Math.round((fc.food_cost_pct - prev.food_cost.food_cost_pct) * 10) / 10 : null} goodWhenUp={false} suffix=" punti" />}
          hint={fc.coverage_pct != null ? `su ${fmtPct(fc.coverage_pct)} del venduto con ricetta` : "nessuna vendita con ricetta"}
        />
        <StatTile
          label="Costo personale"
          value={ec.labour.cost != null ? formatEur(ec.labour.cost) : "—"}
          delta={labourPct != null ? <Delta value={prevLabourPct != null ? Math.round((labourPct - prevLabourPct) * 10) / 10 : null} goodWhenUp={false} suffix=" punti" /> : undefined}
          hint={
            ec.labour.hours === 0
              ? "nessun turno pubblicato"
              : `${fmtNum(ec.labour.hours)} h${labourPct != null ? ` · ${fmtPct(Math.round(labourPct * 10) / 10)} degli incassi` : ""}${ec.labour.people_without_cost ? ` · ${ec.labour.people_without_cost} senza costo orario` : ""}`
          }
        />
      </div>

      {days > 1 && ec.revenue > 0 && (
        <Card className="mb-5">
          <CardHeader title="Incassi per giorno" hint="Cassa e spiaggia" />
          <ColumnChart
            ariaLabel="Incassi per giorno"
            data={ec.daily.map((d) => ({ key: d.d, label: dayLabel(d.d), value: d.pos + d.beach, display: formatEur(d.pos + d.beach) }))}
          />
        </Card>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <Card>
          <CardHeader title="Margine per voce di menu" hint="Ricavi netti IVA − costo teorico delle ricette, nel periodo" />
          {withMargin.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">Nessuna voce venduta con ricetta e costi completi.</p>
          ) : (
            <>
              <BarList
                data={[...withMargin]
                  .sort((a, b) => (b.margin ?? 0) - (a.margin ?? 0))
                  .slice(0, 10)
                  .map((i) => ({
                    key: i.menu_item_id ?? i.name,
                    label: i.name,
                    value: i.margin ?? 0,
                    display: formatEur(i.margin),
                    hint: `${fmtNum(i.qty, 0)} venduti · food cost ${fmtPct(i.food_cost_pct)}${i.target_food_cost_pct != null ? ` (obiettivo ${fmtPct(i.target_food_cost_pct)})` : ""}`,
                    href: i.menu_item_id ? `/servizio/menu/${i.menu_item_id}` : undefined,
                    flag: worst.some((w) => w.menu_item_id === i.menu_item_id) ? "margine più basso" : undefined,
                  }))}
              />
              <DecisionNote tone="danger">
                le 3 voci con il margine più basso sono {worst.map((w) => `${w.name} (${formatEur(w.margin)})`).join(", ")}: rivedi prezzo, porzione o ricetta.
              </DecisionNote>
            </>
          )}
          {fc.items_missing_costs > 0 && <p className="px-4 pb-4 text-xs text-warn">{fc.items_missing_costs} voci vendute hanno ingredienti senza costo: il loro margine non è mostrato.</p>}
        </Card>

        <Card>
          <CardHeader title="Ricavi per postazione" hint="IVA inclusa, per reparto di produzione" />
          <BarList
            data={ec.by_station.map((s) => ({
              key: s.station_id ?? "none",
              label: s.name,
              value: s.gross,
              display: formatEur(s.gross),
              hint: `${s.department ? `${s.department} · ` : ""}netto ${formatEur(s.net)}`,
            }))}
            emptyText="Nessuna vendita nel periodo."
          />
          {ec.by_station.length > 1 && <DecisionNote>concentra personale e attenzione sui reparti che portano più ricavi nelle ore di punta.</DecisionNote>}
        </Card>

        <Card>
          <CardHeader title="Spesa per fornitore" hint="Merce ricevuta e confermata nel periodo (IVA esclusa)" />
          <BarList
            data={ec.suppliers.map((s) => ({
              key: s.supplier_id,
              label: s.name,
              value: s.spend,
              display: formatEur(s.spend),
              hint: `${s.receipts} ricezioni${s.lines_without_price ? ` · ${s.lines_without_price} righe senza prezzo` : ""}`,
              href: `/acquisti/fornitori/${s.supplier_id}`,
            }))}
            emptyText="Nessuna ricezione confermata nel periodo."
          />
          {ec.suppliers.length > 0 && <DecisionNote>i primi fornitori pesano di più: è lì che una trattativa sul listino rende di più.</DecisionNote>}
        </Card>

        <Card>
          <CardHeader title="Aumenti di prezzo" hint="Listini aumentati nel periodo e impatto sui consumi" />
          <BarList
            data={ec.price_increases.slice(0, 8).map((p) => ({
              key: `${p.product_id}-${p.supplier_id}`,
              label: `${p.product} · ${p.supplier}`,
              value: p.impact,
              display: `+${fmtPct(p.increase_pct)}`,
              hint: `${formatEur(p.old_price)} → ${formatEur(p.new_price)} (${p.pack_label}) · impatto ${formatEur(p.impact)} su ${formatQty(p.consumed_qty, p.unit)} consumati`,
              href: `/acquisti/fornitori/${p.supplier_id}`,
              flag: p.increase_pct > 5 ? "oltre 5%" : undefined,
            }))}
            emptyText="Nessun aumento di listino nel periodo."
          />
          {ec.price_increases.length > 0 && <DecisionNote tone="danger">negozia o confronta altri fornitori per gli aumenti oltre il 5% con l'impatto più alto.</DecisionNote>}
        </Card>

        <Card>
          <CardHeader title="Valore degli sprechi" hint="Spreco e scaduto al costo medio" />
          <div className="px-4 pt-3">
            <p className="text-2xl font-extrabold text-night">{formatEur(ec.waste.value)}</p>
            <Delta value={pctChange(ec.waste.value, prev?.waste.value)} goodWhenUp={false} />
            {ec.waste.movements_without_cost > 0 && <p className="text-xs text-warn">{ec.waste.movements_without_cost} movimenti senza costo non sono valorizzati.</p>}
          </div>
          <BarList
            data={ec.waste.by_product.slice(0, 6).map((w, i) => ({
              key: w.product_id,
              label: w.name,
              value: w.value,
              display: formatEur(w.value),
              hint: formatQty(w.qty, w.unit),
              flag: i < 3 && w.value > 0 ? "da ridurre" : undefined,
            }))}
            emptyText="Nessuno spreco nel periodo."
          />
          {ec.adjustments_value !== 0 && <p className="px-4 pb-4 text-xs text-muted">Differenze di inventario valorizzate: {formatEur(ec.adjustments_value)}.</p>}
        </Card>
      </div>
    </>
  );
}
