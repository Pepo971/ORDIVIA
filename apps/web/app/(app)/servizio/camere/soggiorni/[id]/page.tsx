import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { nightsBetween, stayActions, STAY_STATUS, todayIn } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur, formatQty } from "@/lib/format";
import { getNames, getRooms, nameMap, roomName, STAY_COLUMNS, type RoomStay } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { cancelStay, checkInStay, checkOutStay, postCharge, priceCharge, voidCharge } from "../../actions";
import { RoomsTabs, guestsLabel } from "../../rooms-ui";
import { StayForm } from "../stay-form";

export const metadata = { title: "Soggiorno" };
export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { minibar: "Minibar", room_service: "Room service", altro: "Altro" };

export default async function StayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ nuovo?: string }> }) {
  const ctx = await requirePerm("rooms.operate", "rooms.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const manage = can(ctx, "rooms.manage");
  const seeMoney = can(ctx, "rooms.manage", "finance.view");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const supabase = await createClient();

  const { data: stayData } = await supabase.from("room_stays").select(STAY_COLUMNS).eq("id", id).eq("facility_id", ctx.facility.id).maybeSingle();
  if (!stayData) notFound();
  const stay = stayData as RoomStay;

  const [rooms, { data: charges }, { data: customers }] = await Promise.all([
    getRooms(ctx.facility.id, true),
    supabase.from("stay_charges").select("id, description, qty, source, posted_by, posted_at, voided_at, void_reason").eq("stay_id", id).order("posted_at"),
    manage ? supabase.from("customers").select("id, full_name").eq("org_id", ctx.org.id).is("anonymized_at", null).order("full_name").limit(500) : Promise.resolve({ data: [] }),
  ]);
  const chargeIds = (charges ?? []).map((c) => c.id as string);
  // Importi: RLS li restituisce solo con rooms.manage o finance.view
  const { data: prices } = seeMoney && chargeIds.length ? await supabase.from("stay_charge_prices").select("charge_id, unit_price, amount").in("charge_id", chargeIds) : { data: [] };
  const room = rooms.find((r) => r.id === stay.service_point_id);
  const priceBy = new Map((prices ?? []).map((p) => [p.charge_id as string, { unit: p.unit_price == null ? null : Number(p.unit_price), amount: Number(p.amount) }]));
  const people = nameMap(await getNames((charges ?? []).map((c) => c.posted_by as string)));
  const activeCharges = (charges ?? []).filter((c) => !c.voided_at);
  const total = activeCharges.reduce((s, c) => s + (priceBy.get(c.id as string)?.amount ?? 0), 0);
  const unpriced = activeCharges.filter((c) => priceBy.get(c.id as string)?.unit == null).length;
  const actions = manage ? stayActions(stay, today) : [];
  const nights = nightsBetween(stay.arrival_date, stay.departure_date);

  return (
    <div>
      <LiveRefresh tables={["room_stays", "stay_charges"]} facilityId={ctx.facility.id} />
      <PageHeader
        title={stay.guest_name}
        subtitle={`${room ? roomName(room) : "Camera"} · ${formatDate(stay.arrival_date, tz)} → ${formatDate(stay.departure_date, tz)} · ${nights} ${nights === 1 ? "notte" : "notti"} · ${guestsLabel(stay.adults, stay.children)}`}
        action={<Badge tone={STAY_STATUS[stay.status].tone}>{STAY_STATUS[stay.status].label}</Badge>}
      />
      <RoomsTabs ctx={ctx} active="soggiorni" />
      {sp.nuovo && (
        <div className="mb-4">
          <Notice tone="ok">Soggiorno creato.</Notice>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          {actions.some((a) => a === "checkin" || a === "checkout") && (
            <Card className="p-4">
              {actions.includes("checkin") && (
                <ActionForm action={checkInStay}>
                  <input type="hidden" name="stay_id" value={stay.id} />
                  <SubmitButton full className="min-h-14 bg-ok text-lg hover:bg-ok/90" pendingText="…">
                    Check-in
                  </SubmitButton>
                </ActionForm>
              )}
              {actions.includes("checkout") && (
                <ActionForm action={checkOutStay}>
                  <input type="hidden" name="stay_id" value={stay.id} />
                  <SubmitButton full className="min-h-14 text-lg" pendingText="…" confirm={`Check-out di ${stay.guest_name}? La camera passa a «libera sporca».`}>
                    Check-out
                  </SubmitButton>
                </ActionForm>
              )}
            </Card>
          )}

          <Card className="overflow-hidden" id="addebiti">
            <CardHeader
              title="Addebiti in camera"
              hint={seeMoney ? (unpriced ? `${unpriced} da prezzare` : undefined) : "Gli importi li vede la reception"}
              action={seeMoney ? <span className="font-display text-xl font-semibold text-night">{formatEur(total)}</span> : undefined}
            />
            {(charges ?? []).length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">Nessun addebito.</p>
            ) : (
              <ul className="divide-y divide-sand">
                {(charges ?? []).map((c) => {
                  const p = priceBy.get(c.id as string);
                  const voided = !!c.voided_at;
                  return (
                    <li key={c.id as string} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className={voided ? "text-muted line-through" : ""}>
                          <p className="font-bold text-night">
                            {formatQty(c.qty as number)} × {c.description as string}
                          </p>
                          <p className="text-xs text-muted">
                            {SOURCE_LABEL[c.source as string] ?? (c.source as string)} · {formatDateTime(c.posted_at as string, tz)} · {people.get(c.posted_by as string) ?? "—"}
                          </p>
                        </div>
                        {seeMoney && (
                          <span className="shrink-0 text-right font-bold text-night">
                            {p?.unit == null ? <Badge tone="warn">Da prezzare</Badge> : formatEur(p.amount)}
                          </span>
                        )}
                      </div>
                      {voided && <p className="mt-1 text-xs font-bold text-danger">Stornato: {c.void_reason as string}</p>}
                      {manage && !voided && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {p?.unit == null && (
                            <ActionForm action={priceCharge} className="flex gap-2">
                              <input type="hidden" name="charge_id" value={c.id as string} />
                              <Input name="unit_price" type="number" step="0.01" min={0} required placeholder="€ cad." className="w-28" inputMode="decimal" />
                              <SubmitButton variant="secondary" pendingText="…">
                                Prezza
                              </SubmitButton>
                            </ActionForm>
                          )}
                          <details>
                            <summary className="cursor-pointer py-2 text-sm font-bold text-danger">Storna</summary>
                            <ActionForm action={voidCharge} className="flex gap-2">
                              <input type="hidden" name="charge_id" value={c.id as string} />
                              <Input name="reason" required maxLength={300} placeholder="Motivo" className="w-48" />
                              <SubmitButton variant="danger" pendingText="…">
                                Conferma
                              </SubmitButton>
                            </ActionForm>
                          </details>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {manage && (stay.status === "in_casa" || stay.status === "partita") && (
              <ActionForm action={postCharge} resetOnSuccess className="grid grid-cols-2 gap-2 border-t border-sand bg-warm p-4 sm:grid-cols-[1fr_5rem_7rem_9rem_auto]">
                <input type="hidden" name="stay_id" value={stay.id} />
                <div className="col-span-2 sm:col-span-1">
                  <Field label="Descrizione">
                    <Input name="description" required maxLength={160} placeholder="Es. Colazione in camera" />
                  </Field>
                </div>
                <Field label="Q.tà">
                  <Input name="qty" type="number" min={0.001} step="any" defaultValue={1} inputMode="decimal" />
                </Field>
                <Field label="€ cad.">
                  <Input name="unit_price" type="number" min={0} step="0.01" required inputMode="decimal" />
                </Field>
                <Field label="Tipo">
                  <Select name="source" defaultValue="room_service">
                    <option value="room_service">Room service</option>
                    <option value="minibar">Minibar</option>
                    <option value="altro">Altro</option>
                  </Select>
                </Field>
                <div className="col-span-2 self-end sm:col-span-1">
                  <SubmitButton full pendingText="…">
                    Addebita
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
            <p className="border-t border-sand px-4 py-2 text-xs text-muted">Il conto si chiude nel PMS o in cassa: Ordivia non emette documenti fiscali.</p>
          </Card>

          <Card className="p-4 text-sm">
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5">
              <dt className="text-muted">Origine</dt>
              <dd className="font-bold text-night">{stay.source === "csv" ? "Importazione CSV" : stay.source === "pms" ? "PMS" : "Inserito a mano"}</dd>
              {stay.external_ref && (
                <>
                  <dt className="text-muted">Rif. PMS</dt>
                  <dd className="font-bold text-night">{stay.external_ref}</dd>
                </>
              )}
              {stay.checked_in_at && (
                <>
                  <dt className="text-muted">Check-in</dt>
                  <dd className="font-bold text-night">{formatDateTime(stay.checked_in_at, tz)}</dd>
                </>
              )}
              {stay.checked_out_at && (
                <>
                  <dt className="text-muted">Check-out</dt>
                  <dd className="font-bold text-night">{formatDateTime(stay.checked_out_at, tz)}</dd>
                </>
              )}
              {stay.cancel_reason && (
                <>
                  <dt className="text-muted">Annullato</dt>
                  <dd className="font-bold text-night">{stay.cancel_reason}</dd>
                </>
              )}
              {stay.notes && (
                <>
                  <dt className="text-muted">Note</dt>
                  <dd className="text-ink">{stay.notes}</dd>
                </>
              )}
            </dl>
            {room && (
              <Link href={`/servizio/camere/unita/${room.id}`} className="mt-3 inline-block font-bold text-teal-deep">
                Vai a {roomName(room)}
              </Link>
            )}
          </Card>
        </div>

        {actions.includes("modifica") && (
          <div className="space-y-5">
            <Card className="p-4">
              <h2 className="mb-3 font-bold text-night">Modifica</h2>
              <StayForm
                rooms={rooms.filter((r) => r.active || r.id === stay.service_point_id)}
                customers={(customers ?? []) as { id: string; full_name: string }[]}
                stay={stay}
                defaultArrival={stay.arrival_date}
                defaultDeparture={stay.departure_date}
              />
            </Card>
            {actions.includes("annulla") && (
              <Card className="p-4">
                <ActionForm action={cancelStay} className="space-y-2">
                  <input type="hidden" name="stay_id" value={stay.id} />
                  <Input name="reason" maxLength={300} placeholder="Motivo (facoltativo)" />
                  <SubmitButton variant="danger" full pendingText="…" confirm="Annullare il soggiorno?">
                    Annulla soggiorno
                  </SubmitButton>
                </ActionForm>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
