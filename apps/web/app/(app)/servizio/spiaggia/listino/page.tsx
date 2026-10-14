import { BEACH_KIND_LABEL, BEACH_PERIODS, todayIn, type BeachKind, type BeachPeriod } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { getBeachPoints, getRates } from "@/lib/beach-queries";
import { createRate, toggleRate, updateRatePrice } from "../actions";
import { BeachTabs } from "../beach-ui";

export const metadata = { title: "Listino spiaggia" };
export const dynamic = "force-dynamic";

export default async function ListinoPage() {
  const ctx = await requirePerm("beach.manage");
  const [rates, points] = await Promise.all([getRates(ctx.facility.id), getBeachPoints(ctx.facility.id, true)]);
  const today = todayIn(ctx.facility.timezone);
  const zones = [...new Set(points.map((p) => p.zone).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
  const year = today.slice(0, 4);

  return (
    <div>
      <PageHeader title="Listino" subtitle="Per tipo di postazione, settore o fila, periodo e date di validità. Vince la tariffa più specifica." />
      <BeachTabs ctx={ctx} active="listino" />

      <div className="grid gap-5 lg:grid-cols-[22rem_1fr] lg:items-start">
        <Card>
          <CardHeader title="Nuova tariffa" hint="Es. prima fila del settore A più cara, alta stagione ad agosto" />
          <ActionForm action={createRate} className="space-y-3 p-4" resetOnSuccess>
            <Field label="Nome" hint="Facoltativo, es. Alta stagione">
              <Input name="name" maxLength={80} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Elemento">
                <Select name="kind" defaultValue="ombrellone">
                  {(Object.keys(BEACH_KIND_LABEL) as BeachKind[]).map((k) => (
                    <option key={k} value={k}>{BEACH_KIND_LABEL[k]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Periodo">
                <Select name="period" defaultValue="giornata">
                  {(Object.keys(BEACH_PERIODS) as BeachPeriod[]).map((p) => (
                    <option key={p} value={p}>{BEACH_PERIODS[p].label}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Settore">
                <Select name="zone" defaultValue="">
                  <option value="">Tutti</option>
                  {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                </Select>
              </Field>
              <Field label="Fila" hint="Vuoto = tutte">
                <Input name="row_label" maxLength={20} placeholder="es. 1" />
              </Field>
              <Field label="Valida dal">
                <Input name="valid_from" type="date" defaultValue={`${year}-05-01`} required />
              </Field>
              <Field label="al">
                <Input name="valid_to" type="date" defaultValue={`${year}-09-30`} required />
              </Field>
              <Field label="Prezzo €">
                <Input name="price" type="number" min={0} step="0.01" inputMode="decimal" required />
              </Field>
              <Field label="Lettini inclusi">
                <Input name="included_lettini" type="number" min={0} max={20} defaultValue={2} required />
              </Field>
              <Field label="Lettino extra €" hint="Per giorno (o per periodo)">
                <Input name="extra_lettino_price" type="number" min={0} step="0.01" defaultValue={0} inputMode="decimal" required />
              </Field>
            </div>
            <SubmitButton full>Aggiungi tariffa</SubmitButton>
          </ActionForm>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Tariffe" hint="Giornata e mezze giornate si sommano giorno per giorno; settimana, mese e stagione sono a prezzo fisso." />
          {rates.length === 0 ? (
            <EmptyState title="Listino vuoto" text="Senza tariffe le prenotazioni non hanno un prezzo: aggiungi almeno la giornata dell'ombrellone." />
          ) : (
            <div className="divide-y divide-sand">
              {rates.map((r) => {
                const current = r.active && r.valid_from <= today && today <= r.valid_to;
                return (
                  <div key={r.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                        {BEACH_KIND_LABEL[r.kind]} · {BEACH_PERIODS[r.period].label}
                        {r.name && <span className="font-semibold text-muted">«{r.name}»</span>}
                        {!r.active ? <Badge tone="neutral">Disattivata</Badge> : current ? <Badge tone="ok">In vigore</Badge> : null}
                      </p>
                      <p className="text-sm text-muted">
                        {r.zone ? `Settore ${r.zone}` : "Tutti i settori"}
                        {r.row_label ? `, fila ${r.row_label}` : ""} · {formatDate(r.valid_from)} → {formatDate(r.valid_to)} · {r.included_lettini} lettini inclusi, extra {formatEur(r.extra_lettino_price)}
                      </p>
                    </div>
                    <div className="flex items-start gap-2">
                      <ActionForm action={updateRatePrice} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="extra_lettino_price" value={r.extra_lettino_price} />
                        <label className="sr-only" htmlFor={`r-${r.id}`}>Prezzo</label>
                        <Input id={`r-${r.id}`} name="price" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={r.price} className="w-24 text-right font-bold" />
                        <SubmitButton variant="secondary" pendingText="…">Salva</SubmitButton>
                      </ActionForm>
                      <form action={toggleRate}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="active" value={r.active ? "0" : "1"} />
                        <button className="min-h-11 rounded-xl px-3 text-sm font-bold text-muted hover:bg-sand">{r.active ? "Disattiva" : "Riattiva"}</button>
                      </form>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
