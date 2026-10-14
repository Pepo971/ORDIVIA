import { SERVICE_KIND_LABEL } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Row } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatEur } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getServices } from "@/lib/reservations-queries";
import { saveService } from "../actions";
import { BASE, ResTabs } from "../res-ui";
import { ServiceFields } from "./service-fields";

export const metadata = { title: "Servizi prenotabili" };
export const dynamic = "force-dynamic";

export default async function ServiziPage() {
  const ctx = await requirePerm("reservations.manage");
  const supabase = await createClient();
  const [services, { data: slotRows }, { data: fac }] = await Promise.all([
    getServices(ctx.facility.id, true),
    supabase.from("reservation_slots").select("service_id").eq("facility_id", ctx.facility.id),
    supabase.from("facilities").select("public_token").eq("id", ctx.facility.id).maybeSingle(),
  ]);
  const slotCount = new Map<string, number>();
  for (const r of slotRows ?? []) slotCount.set(r.service_id as string, (slotCount.get(r.service_id as string) ?? 0) + 1);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Servizi e orari" subtitle="Ristorante, aperitivo, eventi, degustazioni, pacchetti e servizi della struttura (spa, piscina, navetta…)." />
      <ResTabs active="servizi" />

      <Card className="mb-5 overflow-hidden">
        {services.length === 0 ? (
          <EmptyState title="Nessun servizio" text="Crea il primo servizio qui sotto, poi aggiungi gli orari settimanali." />
        ) : (
          services.map((s) => (
            <Row key={s.id} href={`${BASE}/servizi/${s.id}`}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                  {s.name}
                  <Badge tone="neutral">{SERVICE_KIND_LABEL[s.kind]}</Badge>
                  {!s.active && <Badge tone="danger">Disattivato</Badge>}
                  {s.public_bookable && s.active && <Badge tone="teal">Online</Badge>}
                </p>
                <p className="text-sm text-muted">
                  {s.event_date
                    ? `Evento ${s.event_date} alle ${s.event_time} · ${s.event_capacity} posti`
                    : slotCount.get(s.id)
                      ? `${slotCount.get(s.id)} fasce settimanali`
                      : "Nessun orario: aggiungine uno"}
                  {` · ${s.duration_min} min · max ${s.max_party_size} pers.`}
                  {s.deposit_amount ? ` · acconto ${formatEur(s.deposit_amount)}` : ""}
                  {s.price_per_person ? ` · ${formatEur(s.price_per_person)}/pers.` : ""}
                </p>
              </div>
              <span className="text-muted" aria-hidden>›</span>
            </Row>
          ))
        )}
      </Card>

      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Nuovo servizio" />
        <ActionForm action={saveService} className="p-4">
          <ServiceFields />
          <div className="mt-4">
            <SubmitButton pendingText="Creazione…">Crea servizio</SubmitButton>
          </div>
        </ActionForm>
      </Card>

      {fac?.public_token && (
        <Card className="p-4">
          <p className="font-bold text-night">Prenotazioni online</p>
          <p className="mt-1 text-sm text-muted">
            Portale QR, sito e receptionist automatico usano il codice pubblico della struttura (non rivela dati interni). Le richieste arrivano come «Da confermare».
          </p>
          <code className="mt-2 block overflow-x-auto rounded-lg bg-warm px-3 py-2 text-xs text-ink">{fac.public_token}</code>
        </Card>
      )}
    </div>
  );
}
