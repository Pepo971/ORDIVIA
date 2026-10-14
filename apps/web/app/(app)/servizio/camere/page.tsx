import Link from "next/link";
import { redirect } from "next/navigation";
import { effectiveRoomStatus, groupByFloor, isReadyForArrival, type RoomStatus } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatTime } from "@/lib/format";
import { getRooms, getRoomSettings, getStaysAround, roomName, roomsDate, type RoomStay, type RoomUnit } from "@/lib/rooms-queries";
import { checkInStay, checkOutStay } from "./actions";
import { HkBadge, ROOM_TILE, RoomsTabs, StatusLegend, guestsLabel } from "./rooms-ui";

export const metadata = { title: "Camere" };
export const dynamic = "force-dynamic";

export default async function CamerePage({ searchParams }: { searchParams: Promise<{ data?: string }> }) {
  const ctx = await requirePerm("rooms.operate", "rooms.manage");
  if (!can(ctx, "rooms.manage")) redirect("/servizio/camere/pulizie");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const today = roomsDate(ctx);
  const date = roomsDate(ctx, sp.data);
  const [rooms, stays, settings] = await Promise.all([getRooms(ctx.facility.id), getStaysAround(ctx.facility.id, date), getRoomSettings(ctx.facility.id)]);

  const byRoom = new Map<string, RoomStay[]>();
  for (const s of stays) byRoom.set(s.service_point_id, [...(byRoom.get(s.service_point_id) ?? []), s]);
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  const arrivals = stays.filter((s) => s.arrival_date === date && s.status !== "partita");
  const lateArrivals = date === today ? stays.filter((s) => s.status === "prevista" && s.arrival_date < date) : [];
  const departures = stays.filter((s) => s.departure_date === date && (s.status === "in_casa" || s.status === "partita"));
  const inHouse = stays.filter((s) => s.status === "in_casa");

  const view = rooms.map((r) => {
    const rs = byRoom.get(r.id) ?? [];
    const guest = rs.find((s) => s.status === "in_casa") ?? null;
    const arriving = rs.find((s) => s.status === "prevista" && s.arrival_date <= date) ?? null;
    const status: RoomStatus =
      date === today
        ? effectiveRoomStatus({
            status: r.status,
            hkStatus: r.hk_status,
            inHouse: !!guest,
            departingToday: !!guest && guest.departure_date === date,
            arrivingToday: !!arriving,
          })
        : r.status;
    return { ...r, effective: status, guest, arriving };
  });
  const counts: Partial<Record<RoomStatus, number>> = {};
  for (const v of view) counts[v.effective] = (counts[v.effective] ?? 0) + 1;
  const ready = view.filter((v) => v.arriving && isReadyForArrival({ status: v.status, hkStatus: v.hk_status, inHouse: !!v.guest })).length;

  return (
    <div>
      <LiveRefresh tables={["room_units", "room_stays"]} facilityId={ctx.facility.id} intervalMs={30000} />
      <PageHeader
        title="Camere"
        subtitle={`${date === today ? "Oggi, " : ""}${formatDate(date, tz)} · check-in dalle ${settings.checkin_time}, check-out entro le ${settings.checkout_time}`}
        action={<LinkButton href="/servizio/camere/soggiorni/nuovo">Nuovo soggiorno</LinkButton>}
      />
      <RoomsTabs ctx={ctx} active="oggi" />

      {rooms.length === 0 ? (
        <Card>
          <EmptyState
            title="Nessuna camera configurata"
            text="Crea le camere o le piazzole in blocco (es. 101-120, piano 1): poi potrai registrare arrivi e partenze."
            action={<LinkButton href="/servizio/camere/configura">Crea le camere</LinkButton>}
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Arrivi" value={arrivals.length} hint={`${arrivals.filter((s) => s.status === "in_casa").length} entrati · ${ready} camere pronte`} />
            <Stat label="Partenze" value={departures.length} hint={`${departures.filter((s) => s.status === "partita").length} partiti`} />
            <Stat label="In casa" value={inHouse.length} hint={`${inHouse.reduce((n, s) => n + s.adults + s.children, 0)} ospiti`} />
            <Stat label="Da pulire" value={view.filter((v) => v.hk_status === "sporca" || v.hk_status === "in_pulizia").length} hint={`${counts.da_controllare ?? 0} da controllare`} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <StayList
              title={`Arrivi (${arrivals.length + lateArrivals.length})`}
              empty="Nessun arrivo previsto."
              stays={[...lateArrivals, ...arrivals]}
              rooms={roomById}
              date={date}
              today={today}
              tz={tz}
              mode="arrivo"
              view={new Map(view.map((v) => [v.id, v]))}
            />
            <StayList
              title={`Partenze (${departures.length})`}
              empty="Nessuna partenza prevista."
              stays={departures}
              rooms={roomById}
              date={date}
              today={today}
              tz={tz}
              mode="partenza"
              view={new Map(view.map((v) => [v.id, v]))}
            />
          </div>

          <Card className="mt-5 p-3 sm:p-4">
            <div className="mb-3">
              <StatusLegend counts={counts} />
            </div>
            <div className="space-y-5">
              {groupByFloor(view).map((g) => (
                <section key={g.floor ?? "-"} aria-label={g.floor ? `Piano ${g.floor}` : "Senza piano"}>
                  <h2 className="mb-2 font-display text-lg font-semibold text-night">{g.floor ? `Piano ${g.floor}` : "Senza piano"}</h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
                    {g.rooms.map((r) => (
                      <Link
                        key={r.id}
                        href={`/servizio/camere/unita/${r.id}`}
                        className={cx("flex min-h-20 flex-col justify-between rounded-xl p-2", ROOM_TILE[r.effective])}
                        aria-label={`${roomName(r)}: ${r.effective.replace("_", " ")}`}
                      >
                        <span className="text-lg leading-none font-extrabold">{r.label}</span>
                        <span className="truncate text-[0.7rem] font-bold opacity-90">{r.guest?.guest_name ?? r.arriving?.guest_name ?? r.room_type ?? ""}</span>
                        <span className="text-[0.65rem] font-bold uppercase opacity-80">{r.hk_status === "in_pulizia" ? "in pulizia" : r.hk_status === "sporca" ? "sporca" : ""}</span>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className="font-display text-3xl font-semibold text-night">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </Card>
  );
}

function StayList({
  title,
  empty,
  stays,
  rooms,
  view,
  date,
  today,
  tz,
  mode,
}: {
  title: string;
  empty: string;
  stays: RoomStay[];
  rooms: Map<string, RoomUnit>;
  view: Map<string, RoomUnit & { guest: RoomStay | null; effective: RoomStatus }>;
  date: string;
  today: string;
  tz: string;
  mode: "arrivo" | "partenza";
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title={title} />
      {stays.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-sand">
          {stays.map((s) => {
            const r = rooms.get(s.service_point_id);
            const v = view.get(s.service_point_id);
            const occupiedByOther = mode === "arrivo" && v?.guest && v.guest.id !== s.id;
            const ready = v ? isReadyForArrival({ status: v.status, hkStatus: v.hk_status, inHouse: !!v.guest }) : false;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Link href={`/servizio/camere/soggiorni/${s.id}`} className="min-w-0 flex-1">
                  <p className="font-bold text-night">
                    <span className="mr-2 inline-block min-w-12 rounded-lg bg-sand px-2 text-center">{r?.label ?? "—"}</span>
                    {s.guest_name}
                  </p>
                  <p className="text-sm text-muted">
                    {guestsLabel(s.adults, s.children)}
                    {mode === "arrivo" && s.arrival_date < date && <span className="font-bold text-danger"> · arrivo previsto {formatDate(s.arrival_date, tz)}</span>}
                    {mode === "arrivo" && s.eta && ` · ore ${s.eta.slice(0, 5)}`}
                    {mode === "arrivo" && s.status === "in_casa" && s.checked_in_at && ` · entrato alle ${formatTime(s.checked_in_at, tz)}`}
                    {mode === "partenza" && s.status === "partita" && s.checked_out_at && ` · uscito alle ${formatTime(s.checked_out_at, tz)}`}
                    {s.notes && ` · «${s.notes}»`}
                  </p>
                </Link>
                {v && mode === "arrivo" && s.status === "prevista" && <HkBadge status={v.hk_status} />}
                {date === today && mode === "arrivo" && s.status === "prevista" && !occupiedByOther && (
                  <ActionForm action={checkInStay}>
                    <input type="hidden" name="stay_id" value={s.id} />
                    <SubmitButton pendingText="…" variant={ready ? "primary" : "secondary"} confirm={ready ? undefined : "La camera non risulta pronta. Fare comunque il check-in?"}>
                      Check-in
                    </SubmitButton>
                  </ActionForm>
                )}
                {occupiedByOther && <Badge tone="warn">Camera ancora occupata</Badge>}
                {mode === "arrivo" && s.status === "in_casa" && <Badge tone="ok">Entrato</Badge>}
                {date === today && mode === "partenza" && s.status === "in_casa" && (
                  <ActionForm action={checkOutStay}>
                    <input type="hidden" name="stay_id" value={s.id} />
                    <SubmitButton pendingText="…" confirm={`Check-out di ${s.guest_name}?`}>
                      Check-out
                    </SubmitButton>
                  </ActionForm>
                )}
                {mode === "partenza" && s.status === "partita" && <Badge tone="neutral">Partito</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
