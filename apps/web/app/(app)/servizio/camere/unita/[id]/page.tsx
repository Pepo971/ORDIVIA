import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { TICKET_CATEGORIES, TICKET_PRIORITY, TICKET_STATUS, STAY_STATUS, todayIn, type TicketStatus } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatDateTime, formatEur, formatQty } from "@/lib/format";
import { getRooms, roomName, STAY_COLUMNS, type RoomStay } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { postMinibar, reportRoomIssue, setRoomStatus } from "../../actions";
import { HkBadge, RoomStatusBadge, RoomsTabs, guestsLabel } from "../../rooms-ui";

export const metadata = { title: "Camera" };
export const dynamic = "force-dynamic";

interface MinibarProduct {
  warehouse_id: string;
  product_id: string;
  name: string;
  base_unit: string;
  qty: number;
  price: number | null;
}

export default async function UnitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ mag?: string }> }) {
  const ctx = await requirePerm("rooms.operate", "rooms.manage");
  const { id } = await params;
  const sp = await searchParams;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const manage = can(ctx, "rooms.manage");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const supabase = await createClient();

  const rooms = await getRooms(ctx.facility.id, true);
  const room = rooms.find((r) => r.id === id);
  if (!room) notFound();

  const wantedWh = sp.mag && z.string().uuid().safeParse(sp.mag).success ? sp.mag : null;
  const [{ data: staysData }, { data: cleanings }, { data: warehouses }, { data: tickets }] = await Promise.all([
    supabase.from("room_stays").select(STAY_COLUMNS).eq("service_point_id", id).order("arrival_date", { ascending: false }).limit(8),
    supabase
      .from("room_cleanings")
      .select("id, cleaning_date, kind, started_at, finished_at, note, inspected_at, inspection_ok, inspection_note")
      .eq("service_point_id", id)
      .order("started_at", { ascending: false })
      .limit(6),
    supabase.from("warehouses").select("id, name").eq("facility_id", ctx.facility.id).order("name"),
    supabase
      .from("maintenance_tickets")
      .select("id, number, status, priority, description, created_at")
      .eq("service_point_id", id)
      .not("status", "in", "(verificato,annullato)")
      .order("created_at", { ascending: false }),
  ]);
  const stays = (staysData ?? []) as RoomStay[];
  const current = stays.find((s) => s.status === "in_casa") ?? stays.find((s) => s.status === "partita" && s.checked_out_at && todayIn(tz, new Date(s.checked_out_at)) === today) ?? null;
  const next = stays.filter((s) => s.status === "prevista").sort((a, b) => a.arrival_date.localeCompare(b.arrival_date))[0] ?? null;
  const minibarWh = (warehouses ?? []).find((w) => /minibar/i.test(w.name as string));
  const whId = wantedWh ?? (minibarWh?.id as string | undefined) ?? null;
  const { data: mbData, error: mbErr } = whId
    ? await supabase.rpc("minibar_products", { p_facility: ctx.facility.id, p_warehouse: whId })
    : { data: [], error: null };
  const products = ((mbData ?? []) as MinibarProduct[]).map((p) => ({ ...p, qty: Number(p.qty), price: p.price == null ? null : Number(p.price) }));

  const { data: charges } = current
    ? await supabase.from("stay_charges").select("id, description, qty, source, posted_at, voided_at").eq("stay_id", current.id).order("posted_at", { ascending: false })
    : { data: [] };

  return (
    <div>
      <LiveRefresh tables={["room_units", "room_stays", "stay_charges"]} facilityId={ctx.facility.id} />
      <PageHeader
        title={roomName(room)}
        subtitle={[room.floor ? `Piano ${room.floor}` : null, room.room_type, room.capacity != null ? `${room.capacity} posti` : null].filter(Boolean).join(" · ") || undefined}
        action={
          <div className="flex gap-2">
            <RoomStatusBadge status={room.status} />
            <HkBadge status={room.hk_status} />
          </div>
        }
      />
      <RoomsTabs ctx={ctx} active={manage ? "oggi" : "pulizie"} />
      {!room.active && <p className="mb-3 rounded-xl bg-sand px-4 py-3 text-sm font-bold text-night">Unità disattivata.</p>}
      {room.status_note && <p className="mb-3 rounded-xl bg-warn-soft px-4 py-3 text-sm font-bold text-warn">{room.status_note}</p>}

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title="Ospiti" />
            <div className="space-y-3 p-4">
              {current ? (
                <StayLine stay={current} tz={tz} label={current.status === "in_casa" ? "In camera" : "Partito oggi"} />
              ) : (
                <p className="text-sm text-muted">Nessun ospite in camera.</p>
              )}
              {next && <StayLine stay={next} tz={tz} label="Prossimo arrivo" />}
              {manage && (
                <Link href={`/servizio/camere/soggiorni/nuovo?camera=${room.id}`} className="inline-block text-sm font-bold text-teal-deep">
                  + Nuovo soggiorno in questa camera
                </Link>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden" id="minibar">
            <CardHeader title="Minibar" hint={current ? `Addebito a ${current.guest_name}` : "Serve un ospite in camera (o partito oggi)"} />
            <div className="p-4">
              {(warehouses ?? []).length > 0 && (
                <form className="mb-3 flex items-end gap-2" action={`/servizio/camere/unita/${room.id}#minibar`}>
                  <Field label="Magazzino" hint={minibarWh ? undefined : "Nessun magazzino «minibar»: scegli da quale scaricare."}>
                    <Select name="mag" defaultValue={whId ?? ""}>
                      <option value="" disabled>
                        Scegli…
                      </option>
                      {(warehouses ?? []).map((w) => (
                        <option key={w.id as string} value={w.id as string}>
                          {w.name as string}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <button className="min-h-11 rounded-xl border border-sand-deep bg-white px-3 text-sm font-bold text-night">Cambia</button>
                </form>
              )}
              {mbErr ? (
                <p className="text-sm text-danger">Impossibile caricare i prodotti del minibar.</p>
              ) : !whId ? (
                <p className="text-sm text-muted">Nessun magazzino disponibile.</p>
              ) : products.length === 0 ? (
                <p className="text-sm text-muted">Nessun prodotto in questo magazzino. Carica la merce da Scorte.</p>
              ) : !current ? (
                <ul className="divide-y divide-sand text-sm">
                  {products.map((p) => (
                    <li key={p.product_id} className="flex justify-between py-2">
                      <span>{p.name}</span>
                      <span className="text-muted">{formatQty(p.qty, p.base_unit)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <ActionForm action={postMinibar} resetOnSuccess className="space-y-2">
                  <input type="hidden" name="point_id" value={room.id} />
                  <input type="hidden" name="warehouse_id" value={whId} />
                  <ul className="divide-y divide-sand">
                    {products.map((p) => (
                      <li key={p.product_id} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-bold text-night">{p.name}</p>
                          <p className="text-xs text-muted">
                            In magazzino {formatQty(p.qty, p.base_unit)}
                            {p.price != null && ` · ${formatEur(p.price)}`}
                            {manage && p.price == null && " · senza prezzo"}
                          </p>
                        </div>
                        <Input name={`qty_${p.product_id}`} type="number" inputMode="numeric" min={0} max={99} step={1} placeholder="0" aria-label={`Quantità ${p.name}`} className="w-20 text-center text-lg" />
                      </li>
                    ))}
                  </ul>
                  <SubmitButton full className="min-h-12" pendingText="Registro…">
                    Registra consumo
                  </SubmitButton>
                </ActionForm>
              )}
              {current && (charges ?? []).length > 0 && (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-bold text-muted uppercase">Addebiti del soggiorno</p>
                  <ul className="space-y-1 text-sm">
                    {(charges ?? []).map((c) => (
                      <li key={c.id as string} className={c.voided_at ? "text-muted line-through" : "text-ink"}>
                        {formatQty(c.qty as number)} × {c.description as string} · {formatDateTime(c.posted_at as string, tz)}
                      </li>
                    ))}
                  </ul>
                  {manage && (
                    <Link href={`/servizio/camere/soggiorni/${current.id}#addebiti`} className="mt-2 inline-block text-sm font-bold text-teal-deep">
                      Conto camera e importi
                    </Link>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="overflow-hidden" id="guasto">
            <CardHeader title="Segnala un guasto" hint="Arriva subito alla manutenzione" />
            <ActionForm action={reportRoomIssue} resetOnSuccess className="space-y-3 p-4">
              <input type="hidden" name="point_id" value={room.id} />
              <Field label="Cosa non va">
                <Textarea name="description" required minLength={3} maxLength={2000} rows={2} placeholder="Es. il condizionatore gocciola" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tipo">
                  <Select name="category" defaultValue="altro">
                    {Object.entries(TICKET_CATEGORIES).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Priorità">
                  <Select name="priority" defaultValue="media">
                    {Object.entries(TICKET_PRIORITY).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Foto (facoltativa)">
                <Input name="photo" type="file" accept="image/*" capture="environment" className="py-2" />
              </Field>
              <SubmitButton full pendingText="Invio…">
                Invia segnalazione
              </SubmitButton>
            </ActionForm>
            {(tickets ?? []).length > 0 && (
              <ul className="border-t border-sand px-4 py-3 text-sm">
                {(tickets ?? []).map((t) => (
                  <li key={t.id as string} className="flex items-center justify-between gap-2 py-1">
                    <Link href={`/servizio/manutenzione/${t.id as string}`} className="min-w-0 truncate font-bold text-night hover:underline">
                      #{t.number as number} {t.description as string}
                    </Link>
                    <Badge tone={TICKET_STATUS[t.status as TicketStatus].tone}>{TICKET_STATUS[t.status as TicketStatus].label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {manage && (
            <Card className="overflow-hidden">
              <CardHeader title="Stato della camera" hint="Arrivi e partenze aggiornano lo stato da soli" />
              <ActionForm action={setRoomStatus} className="space-y-3 p-4">
                <input type="hidden" name="point_id" value={room.id} />
                <Field label="Nuovo stato">
                  <Select name="status" defaultValue={room.status === "fuori_servizio" ? "libera_sporca" : "fuori_servizio"}>
                    <option value="libera_pulita">Libera pulita</option>
                    <option value="libera_sporca">Libera sporca</option>
                    <option value="da_controllare">Da controllare</option>
                    <option value="fuori_servizio">Fuori servizio</option>
                  </Select>
                </Field>
                <Input name="note" maxLength={300} placeholder="Motivo (obbligatorio per il fuori servizio)" defaultValue={room.status_note ?? ""} />
                <SubmitButton variant="secondary" pendingText="…">
                  Aggiorna stato
                </SubmitButton>
              </ActionForm>
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Ultime pulizie" />
            {(cleanings ?? []).length === 0 ? (
              <EmptyState title="Nessuna pulizia registrata" />
            ) : (
              <ul className="divide-y divide-sand text-sm">
                {(cleanings ?? []).map((c) => (
                  <li key={c.id as string} className="px-4 py-2.5">
                    <p className="font-bold text-night">
                      {formatDate(c.cleaning_date as string, tz)} · {c.kind as string}
                      {c.inspected_at ? (c.inspection_ok ? " · ispezionata" : " · da rifare") : ""}
                    </p>
                    <p className="text-muted">
                      {formatDateTime(c.started_at as string, tz)}
                      {c.finished_at ? ` → ${formatDateTime(c.finished_at as string, tz)}` : " · in corso"}
                      {c.note ? ` · «${c.note as string}»` : ""}
                      {c.inspection_note ? ` · ispezione: «${c.inspection_note as string}»` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function StayLine({ stay, tz, label }: { stay: RoomStay; tz: string; label: string }) {
  return (
    <Link href={`/servizio/camere/soggiorni/${stay.id}`} className="block rounded-xl bg-warm p-3 hover:bg-sand">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className="font-bold text-night">
        {stay.guest_name} <Badge tone={STAY_STATUS[stay.status].tone}>{STAY_STATUS[stay.status].label}</Badge>
      </p>
      <p className="text-sm text-muted">
        {formatDate(stay.arrival_date, tz)} → {formatDate(stay.departure_date, tz)} · {guestsLabel(stay.adults, stay.children)}
      </p>
      {stay.notes && <p className="text-sm text-ink">«{stay.notes}»</p>}
    </Link>
  );
}
