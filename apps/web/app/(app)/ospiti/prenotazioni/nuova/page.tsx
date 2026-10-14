import Link from "next/link";
import { RESERVATION_SOURCE_LABEL, RESERVATION_SOURCES, todayIn } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, EmptyState, Field, Input, LinkButton, Notice, PageHeader, Select, Textarea, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { formatEur } from "@/lib/format";
import { getServices, getSlots, getTables, resDate, UUID_RE, type Customer } from "@/lib/reservations-queries";
import { addToWaitlist, createReservation } from "../actions";
import { BASE, DateNav } from "../res-ui";

export const metadata = { title: "Nuova prenotazione" };
export const dynamic = "force-dynamic";

export default async function NuovaPrenotazione({
  searchParams,
}: {
  searchParams: Promise<{ data?: string; s?: string; ora?: string; persone?: string; cliente?: string }>;
}) {
  const ctx = await requirePerm("reservations.manage");
  const sp = await searchParams;
  const today = todayIn(ctx.facility.timezone);
  const date = resDate(ctx, sp.data) < today ? today : resDate(ctx, sp.data);
  const services = await getServices(ctx.facility.id);
  const service = services.find((s) => s.id === sp.s) ?? services[0];
  const party = Math.min(Math.max(Number(sp.persone) || 2, 1), 500);

  if (!service) {
    return (
      <div className="max-w-2xl">
        <PageHeader title="Nuova prenotazione" />
        <Card>
          <EmptyState title="Nessun servizio prenotabile" text="Crea prima un servizio con orari e capacità." action={<LinkButton href={`${BASE}/servizi`}>Crea un servizio</LinkButton>} />
        </Card>
      </div>
    );
  }

  const supabase = await createClient();
  const [slots, tables, customerRes] = await Promise.all([
    getSlots(service.id, date),
    getTables(ctx.facility.id),
    sp.cliente && UUID_RE.test(sp.cliente)
      ? supabase.from("customers").select("id, full_name, phone, email, allergies, anonymized_at").eq("id", sp.cliente).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const customer = customerRes.data as Pick<Customer, "id" | "full_name" | "phone" | "email" | "allergies" | "anonymized_at"> | null;
  const chosen = slots.find((s) => s.slot_time === sp.ora) ?? null;
  const extra = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ s: service.id, persone: String(party), ...(customer ? { cliente: customer.id } : {}) });
    for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
    return p.toString();
  };
  const nowMs = Date.now();
  const fits = slots.filter((s) => s.available >= party && s.max_party >= party && new Date(s.starts_at).getTime() > nowMs - 30 * 60000);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Nuova prenotazione" subtitle="Scegli servizio, data e orario: i posti liberi sono calcolati sulla durata del servizio." />

      {/* 1. Servizio, persone, data */}
      <Card className="mb-4 p-4">
        <form action={`${BASE}/nuova`} className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
          <input type="hidden" name="data" value={date} />
          {customer && <input type="hidden" name="cliente" value={customer.id} />}
          <Field label="Servizio">
            <Select name="s" defaultValue={service.id}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.event_date ? ` · ${s.event_date}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Persone">
            <Input name="persone" type="number" min={1} max={500} defaultValue={party} inputMode="numeric" />
          </Field>
          <button className="h-11 rounded-xl bg-night px-4 font-bold text-warm">Mostra orari</button>
        </form>
        <div className="mt-3">
          <DateNav date={date} today={today} basePath={`${BASE}/nuova`} extra={`&${extra({})}`} />
        </div>
      </Card>

      {/* 2. Orario */}
      <Card className="mb-4 overflow-hidden">
        <CardHeader
          title="Orario"
          hint={`${service.name}: ${service.duration_min} min, max ${service.max_party_size} persone${service.deposit_amount ? ` · acconto ${formatEur(service.deposit_amount)}` : ""}`}
        />
        {slots.length === 0 ? (
          <p className="px-4 py-4 text-sm font-bold text-muted">Il servizio è chiuso in questa data.</p>
        ) : (
          <div className="flex flex-wrap gap-2 p-4">
            {slots.map((s) => {
              const ok = fits.includes(s);
              return ok ? (
                <Link
                  key={s.slot_time}
                  href={`${BASE}/nuova?data=${date}&${extra({ ora: s.slot_time })}#dati`}
                  className={cx(
                    "flex min-h-12 min-w-[4.5rem] flex-col items-center justify-center rounded-xl border px-3 py-1 font-bold",
                    chosen?.slot_time === s.slot_time ? "border-night bg-night text-warm" : "border-sand-deep bg-white text-night hover:border-night-3",
                  )}
                >
                  <span className="tabular-nums">{s.slot_time}</span>
                  <span className="text-[0.7rem] font-semibold opacity-80">{s.available} liberi</span>
                </Link>
              ) : (
                <span key={s.slot_time} className="flex min-h-12 min-w-[4.5rem] flex-col items-center justify-center rounded-xl bg-sand px-3 py-1 font-bold text-muted line-through decoration-2">
                  <span className="tabular-nums">{s.slot_time}</span>
                  <span className="text-[0.7rem] font-semibold no-underline">{s.available === 0 ? "pieno" : `${s.available} liberi`}</span>
                </span>
              );
            })}
          </div>
        )}
        {slots.length > 0 && fits.length === 0 && (
          <div className="border-t border-sand p-4">
            <Notice tone="warn">Nessun orario con {party} posti liberi. Puoi mettere il cliente in lista d'attesa.</Notice>
            <ActionForm action={addToWaitlist} className="mt-3 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="service_id" value={service.id} />
              <input type="hidden" name="wait_date" value={date} />
              <input type="hidden" name="party_size" value={party} />
              {customer && <input type="hidden" name="customer_id" value={customer.id} />}
              {!customer && (
                <>
                  <Field label="Nome">
                    <Input name="name" required maxLength={120} />
                  </Field>
                  <Field label="Telefono">
                    <Input name="phone" type="tel" required maxLength={40} />
                  </Field>
                </>
              )}
              <Field label="Ora preferita">
                <Input name="preferred_time" type="time" />
              </Field>
              <Field label="Note">
                <Input name="notes" maxLength={500} />
              </Field>
              <input type="hidden" name="notify" value="1" />
              <div className="sm:col-span-2">
                <SubmitButton variant="secondary" pendingText="…">Metti in lista d'attesa</SubmitButton>
              </div>
            </ActionForm>
          </div>
        )}
      </Card>

      {/* 3. Cliente e dettagli */}
      {chosen && fits.includes(chosen) && (
        <Card id="dati" className="scroll-mt-4 overflow-hidden">
          <CardHeader title={`Dati della prenotazione · ${chosen.slot_time}, ${party} persone`} />
          <ActionForm action={createReservation} className="space-y-4 p-4">
            <input type="hidden" name="service_id" value={service.id} />
            <input type="hidden" name="res_date" value={date} />
            <input type="hidden" name="res_time" value={chosen.slot_time} />
            <input type="hidden" name="party_size" value={party} />
            {customer ? (
              <div className="rounded-xl bg-warm p-3">
                <input type="hidden" name="customer_id" value={customer.id} />
                <p className="font-bold text-night">{customer.full_name}</p>
                <p className="text-sm text-muted">{[customer.phone, customer.email].filter(Boolean).join(" · ") || "Senza recapiti"}</p>
                {customer.allergies.length > 0 && <p className="mt-1 text-sm font-bold text-danger">Allergie: {customer.allergies.join(", ")}</p>}
                <Link href={`${BASE}/nuova?data=${date}&s=${service.id}&persone=${party}&ora=${chosen.slot_time}#dati`} className="mt-1 inline-block text-sm font-bold text-teal-deep">
                  Cambia cliente
                </Link>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted">
                  Se il telefono o l'email sono già in archivio la prenotazione si collega alla scheda esistente, senza doppioni.{" "}
                  <Link href={`/ospiti/clienti?scegli=1&ritorno=${encodeURIComponent(`${BASE}/nuova?data=${date}&s=${service.id}&persone=${party}&ora=${chosen.slot_time}`)}`} className="font-bold text-teal-deep">
                    Cerca in archivio
                  </Link>
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Nome e cognome">
                    <Input name="name" required maxLength={120} autoComplete="off" />
                  </Field>
                  <Field label="Telefono" hint="Anche senza +39">
                    <Input name="phone" type="tel" maxLength={40} autoComplete="off" />
                  </Field>
                  <Field label="Email (facoltativa)">
                    <Input name="email" type="email" maxLength={160} autoComplete="off" />
                  </Field>
                </div>
              </>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Canale">
                <Select name="source" defaultValue="telefono">
                  {RESERVATION_SOURCES.filter((s) => s !== "portale").map((s) => (
                    <option key={s} value={s}>{RESERVATION_SOURCE_LABEL[s]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Stato">
                <Select name="status" defaultValue="confermata">
                  <option value="confermata">Confermata</option>
                  <option value="in_attesa_conferma">Da confermare</option>
                </Select>
              </Field>
              {tables.length > 0 && (
                <Field label="Tavolo" hint="Si può assegnare anche dopo">
                  <Select name="table_id" defaultValue="">
                    <option value="">Da assegnare</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                        {t.seats ? ` (${t.seats} posti)` : ""}
                        {t.zone ? ` · ${t.zone}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Acconto richiesto (€)" hint={service.deposit_amount ? `Predefinito ${formatEur(service.deposit_amount)}` : "Lascia vuoto se non serve"}>
                <Input name="deposit" inputMode="decimal" placeholder={service.deposit_amount ? String(service.deposit_amount) : "0"} />
              </Field>
            </div>
            <Field label="Allergie e intolleranze" hint="Separate da virgola; vengono salvate anche sulla scheda cliente">
              <Input name="allergies" maxLength={600} defaultValue={customer?.allergies.join(", ") ?? ""} />
            </Field>
            <Field label="Richieste speciali" hint="Seggiolone, torta, tavolo all'aperto…">
              <Textarea name="special_requests" maxLength={1000} rows={2} />
            </Field>
            <Field label="Note interne">
              <Textarea name="notes" maxLength={1000} rows={2} />
            </Field>
            {service.cancellation_policy && <p className="text-xs text-muted">Politica di cancellazione: {service.cancellation_policy}</p>}
            <SubmitButton full pendingText="Salvataggio…">Salva prenotazione</SubmitButton>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
