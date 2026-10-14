import Link from "next/link";
import { compareFloors, groupByFloor, hkActions, housekeepingPlan, todayIn, zonedParts, type HkRoomInput } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select, Tabs, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatTime } from "@/lib/format";
import { getPeopleWith, getRooms, getRoomSettings, getStaysAround, nameMap, roomName, type RoomUnit } from "@/lib/rooms-queries";
import { assignRooms, finishCleaning, inspectRoom, startCleaning } from "../actions";
import { HkBadge, RoomsTabs } from "../rooms-ui";

export const metadata = { title: "Pulizie camere" };
export const dynamic = "force-dynamic";

type Room = RoomUnit & HkRoomInput;

export default async function PuliziePage({ searchParams }: { searchParams: Promise<{ chi?: string; vista?: string }> }) {
  const ctx = await requirePerm("rooms.operate", "rooms.manage");
  const sp = await searchParams;
  const manage = can(ctx, "rooms.manage");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const now = zonedParts(new Date(), tz);
  const nowTime = `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`;
  const [rooms, stays, settings, housekeepers] = await Promise.all([
    getRooms(ctx.facility.id),
    getStaysAround(ctx.facility.id, today),
    getRoomSettings(ctx.facility.id),
    manage ? getPeopleWith(ctx, ["rooms.operate"]) : Promise.resolve([]),
  ]);
  const assignees = nameMap(housekeepers.length ? housekeepers : []);

  const input: Room[] = rooms.map((r) => {
    const rs = stays.filter((s) => s.service_point_id === r.id);
    const dep = rs.find((s) => s.departure_date === today && (s.status === "in_casa" || s.status === "partita"));
    const arr = rs.find((s) => s.status === "prevista" && s.arrival_date <= today);
    const stayOver = rs.some((s) => s.status === "in_casa" && s.departure_date > today);
    return {
      ...r,
      departure: dep ? { checkedOut: dep.status === "partita" } : null,
      arrival: arr ? { eta: arr.eta ? arr.eta.slice(0, 5) : null } : null,
      stayOver,
      hkStatus: r.hk_status,
    };
  });
  const plan = housekeepingPlan(input, { checkinTime: settings.checkin_time, nowTime });

  const assignedToday = (r: RoomUnit) => (r.hk_assigned_on === today ? r.hk_assignee : null);
  const mineCount = plan.filter((p) => assignedToday(p.room) === ctx.userId).length;
  const who = sp.chi === "tutte" || (sp.chi !== "mie" && (manage || mineCount === 0)) ? "tutte" : "mie";
  const visible = who === "mie" ? plan.filter((p) => assignedToday(p.room) === ctx.userId) : plan;
  const todo = visible.filter((p) => !p.done && p.room.status !== "fuori_servizio");
  const byFloor = sp.vista === "piani";

  return (
    <div>
      <LiveRefresh tables={["room_units", "room_stays"]} facilityId={ctx.facility.id} intervalMs={20000} />
      <PageHeader title="Pulizie" subtitle={`Oggi · prima le partenze, poi gli arrivi entro le ${settings.checkin_time}, poi le fermate.`} />
      <RoomsTabs ctx={ctx} active="pulizie" />

      {rooms.length === 0 ? (
        <Card>
          <EmptyState title="Nessuna camera" text={manage ? "Crea prima le camere." : "Il responsabile non ha ancora configurato le camere."} action={manage ? <LinkButton href="/servizio/camere/configura">Crea le camere</LinkButton> : undefined} />
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tabs
              active={`${who}-${byFloor ? "piani" : "ordine"}`}
              items={[
                { key: `mie-${byFloor ? "piani" : "ordine"}`, label: "Le mie", href: `/servizio/camere/pulizie?chi=mie${byFloor ? "&vista=piani" : ""}`, count: mineCount },
                { key: `tutte-${byFloor ? "piani" : "ordine"}`, label: "Tutte", href: `/servizio/camere/pulizie?chi=tutte${byFloor ? "&vista=piani" : ""}` },
              ]}
            />
            <Link href={`/servizio/camere/pulizie?chi=${who}${byFloor ? "" : "&vista=piani"}`} className="mb-4 rounded-xl border border-sand-deep bg-white px-3 py-2 text-sm font-bold text-night">
              {byFloor ? "Ordina per priorità" : "Raggruppa per piano"}
            </Link>
          </div>

          <p className="mb-3 text-sm font-bold text-night">
            {todo.length === 0 ? "Tutto fatto per ora." : `${todo.length} ${todo.length === 1 ? "camera da fare" : "camere da fare"}`}
            {who === "mie" && mineCount === 0 && " Nessuna camera assegnata a te oggi."}
          </p>

          {visible.length === 0 ? (
            <Card>
              <EmptyState title="Nessuna camera assegnata a te" text="Guarda «Tutte» o chiedi al responsabile di assegnarti le camere." />
            </Card>
          ) : byFloor ? (
            <div className="space-y-5">
              {groupByFloor(visible.map((p) => ({ ...p, floor: p.room.floor, label: p.room.label }))).map((g) => (
                <section key={g.floor ?? "-"}>
                  <h2 className="mb-2 font-display text-lg font-semibold text-night">{g.floor ? `Piano ${g.floor}` : "Senza piano"}</h2>
                  <div className="space-y-2">
                    {g.rooms.map((p) => (
                        <RoomCard key={p.room.id} p={p} manage={manage} tz={tz} assignee={assignedToday(p.room) ? assignees.get(assignedToday(p.room)!) : undefined} />
                      ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {visible.map((p) => (
                <RoomCard key={p.room.id} p={p} manage={manage} tz={tz} assignee={assignedToday(p.room) ? assignees.get(assignedToday(p.room)!) : undefined} />
              ))}
            </div>
          )}

          {manage && <AssignPanel rooms={plan.map((p) => p.room)} people={housekeepers} today={today} assignees={assignees} />}
        </>
      )}
    </div>
  );
}

function RoomCard({
  p,
  manage,
  tz,
  assignee,
}: {
  p: ReturnType<typeof housekeepingPlan<Room>>[number];
  manage: boolean;
  tz: string;
  assignee?: string;
}) {
  const r = p.room;
  const oos = r.status === "fuori_servizio";
  const actions = hkActions(r.hk_status, { manage, outOfService: oos });
  const waitingGuest = p.kind === "partenza" && r.departure && !r.departure.checkedOut;
  return (
    <Card className={cx("p-3", p.urgent && "border-danger/60", p.done && "opacity-70")}>
      <div className="flex items-start gap-3">
        <Link href={`/servizio/camere/unita/${r.id}`} className="flex h-14 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-night text-warm">
          <span className="text-xl leading-none font-extrabold">{r.label}</span>
          {r.floor && <span className="text-[0.65rem] font-bold opacity-80">piano {r.floor}</span>}
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-bold text-night">{p.reason}</span>
            {p.urgent && <Badge tone="danger">Arrivo vicino</Badge>}
            <HkBadge status={r.hk_status} />
            {oos && <Badge tone="danger">Fuori servizio</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {r.kind === "piazzola" ? "Piazzola" : (r.room_type ?? "Camera")}
            {assignee && ` · ${assignee}`}
            {r.last_cleaned_at && ` · ultima pulizia ${formatTime(r.last_cleaned_at, tz)}`}
          </p>
          {r.status_note && <p className="mt-1 text-sm font-semibold text-warn">«{r.status_note}»</p>}
          {waitingGuest && <p className="mt-1 text-sm font-semibold text-muted">Ospite ancora in camera: attendi il check-out.</p>}
        </div>
      </div>
      {actions.length > 0 && !waitingGuest && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {actions.includes("inizia") && (
            <ActionForm action={startCleaning} className="col-span-2">
              <input type="hidden" name="point_id" value={r.id} />
              <SubmitButton full className="min-h-12" pendingText="…" variant={p.done ? "secondary" : "primary"}>
                {p.done ? "Pulizia extra" : "Inizia pulizia"}
              </SubmitButton>
            </ActionForm>
          )}
          {actions.includes("finisci") && (
            <ActionForm action={finishCleaning} className="col-span-2 flex gap-2">
              <input type="hidden" name="point_id" value={r.id} />
              <Input name="note" placeholder="Nota (facoltativa)" maxLength={500} className="min-w-0 flex-1" />
              <SubmitButton className="min-h-12 bg-ok hover:bg-ok/90" pendingText="…">
                Finita
              </SubmitButton>
            </ActionForm>
          )}
          {actions.includes("ispeziona") && (
            <>
              <ActionForm action={inspectRoom}>
                <input type="hidden" name="point_id" value={r.id} />
                <input type="hidden" name="ok" value="1" />
                <SubmitButton full className="min-h-12" pendingText="…">
                  Ispezione ok
                </SubmitButton>
              </ActionForm>
              <details className="col-span-2 sm:col-span-1">
                <summary className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border border-danger/40 bg-white px-3 text-sm font-bold text-danger">Da rifare…</summary>
                <ActionForm action={inspectRoom} className="mt-2 flex gap-2">
                  <input type="hidden" name="point_id" value={r.id} />
                  <input type="hidden" name="ok" value="0" />
                  <Input name="note" required placeholder="Cosa va rifatto" maxLength={500} className="min-w-0 flex-1" />
                  <SubmitButton variant="danger" pendingText="…">
                    Rimanda
                  </SubmitButton>
                </ActionForm>
              </details>
            </>
          )}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-sm font-bold">
        <Link href={`/servizio/camere/unita/${r.id}#minibar`} className="text-teal-deep">Minibar</Link>
        <Link href={`/servizio/camere/unita/${r.id}#guasto`} className="text-teal-deep">Segnala guasto</Link>
      </div>
    </Card>
  );
}

function AssignPanel({
  rooms,
  people,
  today,
  assignees,
}: {
  rooms: RoomUnit[];
  people: { id: string; name: string }[];
  today: string;
  assignees: Map<string, string>;
}) {
  const sorted = [...rooms].sort((a, b) => compareFloors(a.floor, b.floor));
  const groups = groupByFloor(sorted);
  const load = new Map<string, number>();
  for (const r of rooms) if (r.hk_assigned_on === today && r.hk_assignee) load.set(r.hk_assignee, (load.get(r.hk_assignee) ?? 0) + 1);
  return (
    <Card className="mt-6 overflow-hidden" id="assegna">
      <CardHeader
        title="Assegna le camere di oggi"
        hint={people.length ? people.map((p) => `${p.name}: ${load.get(p.id) ?? 0}`).join(" · ") : "Nessun collega con il permesso di housekeeping."}
      />
      {people.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">Dai a qualcuno il ruolo «Housekeeping» dalla sezione Team.</p>
      ) : (
        <ActionForm action={assignRooms} className="space-y-4 p-4">
          <input type="hidden" name="date" value={today} />
          {groups.map((g) => (
            <fieldset key={g.floor ?? "-"}>
              <legend className="mb-2 text-sm font-bold text-night">{g.floor ? `Piano ${g.floor}` : "Senza piano"}</legend>
              <div className="flex flex-wrap gap-2">
                {g.rooms.map((r) => {
                  const who = r.hk_assigned_on === today && r.hk_assignee ? assignees.get(r.hk_assignee) : null;
                  return (
                    <label key={r.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-sand-deep bg-white px-3 has-checked:border-teal has-checked:bg-teal-soft">
                      <input type="checkbox" name="point_id" value={r.id} className="h-5 w-5 accent-teal" aria-label={roomName(r)} />
                      <span className="font-extrabold text-night">{r.label}</span>
                      {who && <span className="max-w-24 truncate text-xs text-muted">{who}</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="A chi">
              <Select name="user_id" defaultValue="" className="min-w-48">
                <option value="">Nessuno (togli assegnazione)</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <SubmitButton pendingText="Assegno…">Assegna selezionate</SubmitButton>
          </div>
        </ActionForm>
      )}
    </Card>
  );
}
