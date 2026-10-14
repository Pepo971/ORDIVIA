import Link from "next/link";
import { notFound } from "next/navigation";
import { BEACH_PERIODS, CONSENT_SOURCE_LABEL, CONSENT_SOURCES, frequencyLabel, RESERVATION_SOURCE_LABEL, type BeachPeriod } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import {
  CUSTOMER_COLUMNS,
  LANGUAGES,
  normReservation,
  RES_COLUMNS,
  UUID_RE,
  type Customer,
  type CustomerCard,
  type CustomerListRow,
} from "@/lib/reservations-queries";
import { anonymizeCustomer, mergeCustomers, saveCustomer, setConsent } from "../actions";
import { CustomerFields } from "../customer-fields";
import { StatusBadge } from "../../prenotazioni/res-ui";

export const dynamic = "force-dynamic";

const BEACH_STATUS: Record<string, string> = { prenotata: "Prenotata", presente: "Presente", uscito: "Uscito", annullata: "Annullata", no_show: "Non presentato" };

export default async function ClientePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string; unito?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("crm.view", "crm.manage", "reservations.manage");
  if (!UUID_RE.test(id)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", id).eq("org_id", ctx.org.id).maybeSingle();
  if (!data) notFound();
  const c = data as Customer;
  const manage = can(ctx, "crm.manage");
  const finance = can(ctx, "finance.view");
  const tz = ctx.facility.timezone;

  const [{ data: resRows }, { data: card }, { data: stats }, { data: others }, { data: services }, { data: facilities }] = await Promise.all([
    supabase.from("reservations").select(`${RES_COLUMNS}, facility_id`).eq("customer_id", id).order("starts_at", { ascending: false }).limit(100),
    supabase.rpc("crm_customer_card", { p_customer: id }),
    supabase.rpc("crm_customers", { p_org: ctx.org.id, p_customer: id, p_include_anonymized: true, p_limit: 1 }),
    manage && c.anonymized_at == null
      ? supabase.from("customers").select("id, full_name, phone, email").eq("org_id", ctx.org.id).is("anonymized_at", null).neq("id", id).order("full_name").limit(1000)
      : Promise.resolve({ data: [] }),
    supabase.from("reservation_services").select("id, name").eq("org_id", ctx.org.id),
    supabase.from("facilities").select("id, name").eq("org_id", ctx.org.id),
  ]);
  const reservations = (resRows ?? []).map((r) => ({ ...normReservation(r), facility_id: (r as { facility_id: string }).facility_id }));
  const cc = (card ?? { beach: [], orders: null, spend: null, consents: [] }) as CustomerCard;
  const row = ((stats ?? []) as CustomerListRow[])[0];
  const serviceName = new Map((services ?? []).map((s) => [s.id as string, s.name as string]));
  const facilityName = new Map((facilities ?? []).map((f) => [f.id as string, f.name as string]));
  const anonymized = c.anonymized_at != null;
  const totalSpend = cc.spend ? Number(cc.spend.orders) + Number(cc.spend.beach) : null;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={c.full_name}
        subtitle={anonymized ? `Anonimizzato il ${formatDateTime(c.anonymized_at, tz)}` : [c.phone, c.email].filter(Boolean).join(" · ") || "Senza recapiti"}
        action={
          <div className="flex flex-wrap gap-2">
            {!anonymized && can(ctx, "reservations.manage") && <LinkButton href={`/ospiti/prenotazioni/nuova?cliente=${c.id}`}>Prenota</LinkButton>}
            <LinkButton href="/ospiti/clienti" variant="secondary">Clienti</LinkButton>
          </div>
        }
      />
      {sp.nuovo && <div className="mb-4"><Notice tone="ok">Scheda creata.</Notice></div>}
      {sp.unito && <div className="mb-4"><Notice tone="ok">Schede unite: prenotazioni e storico ora sono qui.</Notice></div>}

      {/* Sintesi */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Frequenza" value={frequencyLabel(row?.visits ?? 0)} hint={`${row?.visits ?? 0} visite`} />
        <Stat label="Ultima visita" value={row?.last_visit ? formatDate(row.last_visit) : "—"} />
        <Stat label="Non presentato" value={String(row?.no_shows ?? 0)} tone={row && row.no_shows > 0 ? "warn" : undefined} />
        {finance ? <Stat label="Spesa" value={formatEur(totalSpend ?? 0)} hint="comande + spiaggia" /> : <Stat label="Cliente dal" value={formatDate(c.created_at, tz)} />}
      </div>

      {!anonymized && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap gap-2">
            {c.tags.map((t) => (
              <Badge key={t} tone="neutral">{t}</Badge>
            ))}
            <Badge tone="neutral">{LANGUAGES[c.language] ?? c.language}</Badge>
            {c.birthday && <Badge tone="teal">Compleanno {formatDate(c.birthday)}</Badge>}
          </div>
          {c.allergies.length > 0 && <p className="mt-3 font-bold text-danger">⚠ Allergie: {c.allergies.join(", ")}</p>}
          {c.preferences && <p className="mt-2 text-ink">Preferenze: {c.preferences}</p>}
          {c.notes && <p className="mt-1 text-sm text-muted">{c.notes}</p>}
        </Card>
      )}

      {/* Prenotazioni */}
      <Card className="mb-4 overflow-hidden">
        <CardHeader title={`Prenotazioni (${reservations.length})`} />
        {reservations.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted">Nessuna prenotazione.</p>
        ) : (
          <ul className="divide-y divide-sand">
            {reservations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="w-28 font-bold text-night">{formatDate(r.res_date)}</span>
                <span className="tabular-nums">{r.res_time}</span>
                {r.facility_id === ctx.facility.id && can(ctx, "reservations.manage") ? (
                  <Link href={`/ospiti/prenotazioni/${r.id}`} className="font-semibold text-night hover:underline">
                    {serviceName.get(r.service_id) ?? "—"} · {r.party_size} pers.
                  </Link>
                ) : (
                  <span className="font-semibold text-night">
                    {serviceName.get(r.service_id) ?? "—"} · {r.party_size} pers.
                    {facilityName.get(r.facility_id) && r.facility_id !== ctx.facility.id ? ` · ${facilityName.get(r.facility_id)}` : ""}
                  </span>
                )}
                <span className="text-muted">{RESERVATION_SOURCE_LABEL[r.source]}</span>
                <StatusBadge status={r.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Spiaggia */}
      {cc.beach.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title={`Spiaggia (${cc.beach.length})`} />
          <ul className="divide-y divide-sand">
            {cc.beach.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="font-bold text-night">
                  {formatDate(b.start_date)}
                  {b.end_date !== b.start_date ? ` – ${formatDate(b.end_date)}` : ""}
                </span>
                <span>
                  {b.point} · {BEACH_PERIODS[b.period as BeachPeriod]?.label ?? b.period}
                </span>
                <Badge tone="neutral">{BEACH_STATUS[b.status] ?? b.status}</Badge>
                {finance && b.paid != null && <span className="ml-auto font-bold text-night">{formatEur(b.paid)}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Comande (solo finanza) */}
      {finance && cc.orders && cc.orders.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title={`Conti (${cc.orders.length})`} hint="Comande chiuse collegate al cliente" />
          <ul className="divide-y divide-sand">
            {cc.orders.slice(0, 50).map((o) => (
              <li key={o.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                <span className="w-28 font-bold text-night">{formatDate(o.date)}</span>
                <span className="flex-1">{o.destination} · {o.facility}</span>
                <span className="font-bold">{formatEur(o.total)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Consensi */}
      <Card className="mb-4 overflow-hidden">
        <CardHeader title="Consensi" hint="Ogni variazione è registrata con fonte e data." />
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <div>
            <p className="text-sm font-bold text-night">Privacy</p>
            <p className="text-sm">{c.privacy_consent_at ? `Dato il ${formatDateTime(c.privacy_consent_at, tz)}` : "Non registrato"}</p>
          </div>
          <div>
            <p className="text-sm font-bold text-night">Marketing</p>
            <p className="text-sm">
              {c.marketing_consent ? "Sì" : "No"}
              {c.marketing_consent_at ? ` · ${formatDateTime(c.marketing_consent_at, tz)}` : ""}
              {c.consent_source ? ` · fonte: ${CONSENT_SOURCE_LABEL[c.consent_source as keyof typeof CONSENT_SOURCE_LABEL] ?? c.consent_source}` : ""}
            </p>
          </div>
        </div>
        {manage && !anonymized && (
          <ActionForm action={setConsent} className="grid gap-3 border-t border-sand p-4 sm:grid-cols-4 sm:items-end">
            <input type="hidden" name="customer_id" value={c.id} />
            <Field label="Consenso">
              <Select name="kind" defaultValue="marketing">
                <option value="marketing">Marketing</option>
                <option value="privacy">Privacy</option>
              </Select>
            </Field>
            <Field label="Valore">
              <Select name="granted" defaultValue="1">
                <option value="1">Concesso</option>
                <option value="0">Revocato</option>
              </Select>
            </Field>
            <Field label="Fonte">
              <Select name="source" required defaultValue="">
                <option value="" disabled>Scegli…</option>
                {CONSENT_SOURCES.map((s) => (
                  <option key={s} value={s}>{CONSENT_SOURCE_LABEL[s]}</option>
                ))}
              </Select>
            </Field>
            <SubmitButton variant="secondary" pendingText="…">Registra</SubmitButton>
          </ActionForm>
        )}
        {cc.consents.length > 0 && (
          <details className="border-t border-sand">
            <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-muted">Storico consensi ({cc.consents.length})</summary>
            <ul className="divide-y divide-sand">
              {cc.consents.map((k, i) => (
                <li key={i} className="flex flex-wrap gap-2 px-4 py-2 text-sm">
                  <span className="font-bold">{k.kind === "privacy" ? "Privacy" : "Marketing"}</span>
                  <span>{k.granted ? "concesso" : "revocato"}</span>
                  <span className="text-muted">{k.source ?? "—"}</span>
                  <span className="ml-auto text-muted">{formatDateTime(k.at, tz)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {/* Modifica */}
      {!anonymized && (
        <Card className="mb-4 overflow-hidden">
          <details>
            <summary className="cursor-pointer px-4 py-3 font-bold text-night">Modifica scheda</summary>
            <ActionForm action={saveCustomer} className="px-4 pb-4">
              <CustomerFields c={c} />
              <div className="mt-4">
                <SubmitButton pendingText="Salvataggio…">Salva</SubmitButton>
              </div>
            </ActionForm>
          </details>
        </Card>
      )}

      {/* GDPR */}
      {manage && (
        <Card className="overflow-hidden">
          <CardHeader title="Dati personali (GDPR)" />
          <div className="space-y-4 p-4">
            <div>
              <a href={`/ospiti/clienti/${c.id}/esporta`} className="inline-flex min-h-11 items-center rounded-xl border border-sand-deep bg-white px-4 text-sm font-bold text-night hover:border-night-3">
                Scarica i dati (JSON)
              </a>
              <p className="mt-1 text-xs text-muted">Per le richieste di accesso o portabilità. L'esportazione viene registrata.</p>
            </div>
            {!anonymized && (
              <details>
                <summary className="cursor-pointer text-sm font-bold text-night">Unisci con un'altra scheda</summary>
                <ActionForm action={mergeCustomers} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="keep_id" value={c.id} />
                  <div className="min-w-0 flex-1">
                    <Field label="Scheda da unire a questa" hint="Prenotazioni, spiaggia, conti e consensi passano qui; l'altra scheda viene eliminata.">
                      <Select name="merge_id" required defaultValue="">
                        <option value="" disabled>Scegli…</option>
                        {((others ?? []) as Pick<Customer, "id" | "full_name" | "phone" | "email">[]).map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.full_name}
                              {x.phone ? ` · ${x.phone}` : ""}
                              {x.email ? ` · ${x.email}` : ""}
                            </option>
                          ))}
                      </Select>
                    </Field>
                  </div>
                  <SubmitButton variant="secondary" pendingText="…" confirm="Unire le due schede? L'operazione non si può annullare.">Unisci</SubmitButton>
                </ActionForm>
              </details>
            )}
            {!anonymized && (
              <details>
                <summary className="cursor-pointer text-sm font-bold text-danger">Anonimizza (diritto all'oblio)</summary>
                <p className="mt-2 text-sm text-muted">
                  Toglie nome, recapiti, allergie, preferenze, note e consensi da scheda, prenotazioni e spiaggia, e li oscura nel registro operazioni. Restano date, coperti e importi per la contabilità.
                </p>
                <ActionForm action={anonymizeCustomer} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="customer_id" value={c.id} />
                  <div className="min-w-0 flex-1">
                    <Field label="Scrivi ANONIMIZZA per confermare">
                      <Input name="confirm" required autoComplete="off" />
                    </Field>
                  </div>
                  <SubmitButton variant="danger" pendingText="…">Anonimizza</SubmitButton>
                </ActionForm>
              </details>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <Card className="p-3">
      <p className="text-xs font-bold text-muted">{label}</p>
      <p className={tone === "warn" ? "text-lg font-extrabold text-warn" : "text-lg font-extrabold text-night"}>{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </Card>
  );
}
