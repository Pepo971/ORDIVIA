import { notFound } from "next/navigation";
import { addDays, todayIn } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate, WEEKDAY_LABELS } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { normService, SERVICE_COLUMNS, UUID_RE } from "@/lib/reservations-queries";
import { addException, addSlots, deleteException, deleteSlot, saveService } from "../../actions";
import { BASE } from "../../res-ui";
import { ServiceFields } from "../service-fields";

export const dynamic = "force-dynamic";

export default async function ServizioPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("reservations.manage");
  if (!UUID_RE.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("reservation_services").select(SERVICE_COLUMNS).eq("id", id).eq("facility_id", ctx.facility.id).maybeSingle();
  if (!data) notFound();
  const s = normService(data);
  const today = todayIn(ctx.facility.timezone);
  const [{ data: slots }, { data: exceptions }] = await Promise.all([
    supabase.from("reservation_slots").select("id, weekday, start_time, end_time, interval_min, capacity, max_party").eq("service_id", id).order("weekday").order("start_time"),
    supabase
      .from("reservation_exceptions")
      .select("id, service_id, on_date, closed, capacity, note")
      .eq("facility_id", ctx.facility.id)
      .gte("on_date", today)
      .or(`service_id.eq.${id},service_id.is.null`)
      .order("on_date"),
  ]);

  return (
    <div className="max-w-3xl">
      <PageHeader title={s.name} subtitle="Orari, capacità e date speciali." action={<LinkButton href={`${BASE}/servizi`} variant="secondary">Tutti i servizi</LinkButton>} />
      {sp.nuovo && <div className="mb-4"><Notice tone="ok">Servizio creato: ora aggiungi gli orari settimanali.</Notice></div>}

      {!s.event_date && (
        <Card className="mb-5 overflow-hidden">
          <CardHeader title="Orari settimanali" hint="Primo e ultimo arrivo, ogni quanti minuti, quanti posti per fascia." />
          {(slots ?? []).length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Nessun orario: il servizio non è prenotabile.</p>
          ) : (
            <ul className="divide-y divide-sand">
              {(slots ?? []).map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="w-10 font-bold text-night">{WEEKDAY_LABELS[(r.weekday as number) - 1]}</span>
                  <span className="flex-1 text-ink">
                    {String(r.start_time).slice(0, 5)}–{String(r.end_time).slice(0, 5)} ogni {r.interval_min} min · {r.capacity} {s.capacity_unit}
                    {r.max_party ? ` · max ${r.max_party} per gruppo` : ""}
                  </span>
                  <form action={deleteSlot}>
                    <input type="hidden" name="slot_id" value={r.id as string} />
                    <button className="min-h-9 rounded-lg px-2 font-bold text-danger hover:bg-danger-soft">Togli</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={addSlots} resetOnSuccess className="space-y-3 border-t border-sand p-4">
            <input type="hidden" name="service_id" value={s.id} />
            <fieldset>
              <legend className="mb-1 text-sm font-bold text-night">Giorni</legend>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABELS.map((l, i) => (
                  <label key={l} className="flex min-h-10 items-center gap-1.5 rounded-xl border border-sand-deep bg-white px-3 text-sm font-bold">
                    <input type="checkbox" name="weekdays" value={i + 1} defaultChecked className="h-4 w-4" /> {l}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Field label="Primo arrivo">
                <Input name="start_time" type="time" required defaultValue="19:30" />
              </Field>
              <Field label="Ultimo arrivo">
                <Input name="end_time" type="time" required defaultValue="22:00" />
              </Field>
              <Field label="Ogni (min)">
                <Input name="interval_min" type="number" min={5} max={240} required defaultValue={30} />
              </Field>
              <Field label={`${s.capacity_unit === "coperti" ? "Coperti" : "Posti"}`}>
                <Input name="capacity" type="number" min={1} max={5000} required />
              </Field>
              <Field label="Max gruppo">
                <Input name="max_party" type="number" min={1} max={500} placeholder={String(s.max_party_size)} />
              </Field>
            </div>
            <SubmitButton variant="secondary" pendingText="…">Aggiungi orari</SubmitButton>
          </ActionForm>
        </Card>
      )}

      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Date speciali" hint="Chiusure (anche dell'intera struttura) e capacità eccezionali." />
        {(exceptions ?? []).length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">Nessuna data speciale in programma.</p>
        ) : (
          <ul className="divide-y divide-sand">
            {(exceptions ?? []).map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-28 font-bold text-night">{formatDate(e.on_date as string)}</span>
                <span className="flex-1 text-ink">
                  {e.closed ? (e.service_id ? "Servizio chiuso" : "Struttura chiusa") : `Capacità ${e.capacity}`}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
                <form action={deleteException}>
                  <input type="hidden" name="exception_id" value={e.id as string} />
                  <button className="min-h-9 rounded-lg px-2 font-bold text-danger hover:bg-danger-soft">Togli</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={addException} resetOnSuccess className="grid gap-3 border-t border-sand p-4 sm:grid-cols-2">
          <Field label="Data">
            <Input name="on_date" type="date" required min={today} defaultValue={addDays(today, 1)} />
          </Field>
          <Field label="Cosa succede">
            <Select name="mode" defaultValue="chiuso">
              <option value="chiuso">Chiuso</option>
              <option value="capacita">Capacità diversa</option>
            </Select>
          </Field>
          <Field label="Vale per">
            <Select name="service_id" defaultValue={s.id}>
              <option value={s.id}>Solo {s.name}</option>
              <option value="">Tutta la struttura (solo chiusura)</option>
            </Select>
          </Field>
          <Field label="Capacità eccezionale">
            <Input name="capacity" type="number" min={1} max={5000} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Nota">
              <Input name="note" maxLength={300} placeholder="Ferragosto, evento privato…" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <SubmitButton variant="secondary" pendingText="…">Aggiungi data speciale</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Impostazioni del servizio" />
        <ActionForm action={saveService} className="p-4">
          <ServiceFields s={s} />
          <div className="mt-4">
            <SubmitButton pendingText="Salvataggio…">Salva</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
