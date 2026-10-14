import Link from "next/link";
import { addDays, compareRoomLabels, STAY_STATUS, todayIn, type StayStatus } from "@ordivia/domain";
import { LiveRefresh } from "@/components/live-refresh";
import { Badge, Card, EmptyState, Input, LinkButton, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { getRooms, STAY_COLUMNS, type RoomStay } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { RoomsTabs, guestsLabel } from "../rooms-ui";

export const metadata = { title: "Soggiorni" };
export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export default async function SoggiorniPage({ searchParams }: { searchParams: Promise<{ dal?: string; al?: string; stato?: string; q?: string }> }) {
  const ctx = await requirePerm("rooms.operate", "rooms.manage");
  const sp = await searchParams;
  const manage = can(ctx, "rooms.manage");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const from = sp.dal && ISO.test(sp.dal) ? sp.dal : today;
  const to = sp.al && ISO.test(sp.al) && sp.al >= from ? sp.al : addDays(from, 7);
  const status = (["prevista", "in_casa", "partita", "annullata"] as const).includes(sp.stato as StayStatus) ? (sp.stato as StayStatus) : null;
  const q = (sp.q ?? "").trim().slice(0, 60);

  const supabase = await createClient();
  let query = supabase
    .from("room_stays")
    .select(STAY_COLUMNS)
    .eq("facility_id", ctx.facility.id)
    .lte("arrival_date", to)
    .gte("departure_date", from)
    .order("arrival_date")
    .limit(300);
  if (status) query = query.eq("status", status);
  if (q) query = query.ilike("guest_name", `%${q.replace(/[%_]/g, "")}%`);
  const [{ data }, rooms] = await Promise.all([query, getRooms(ctx.facility.id, true)]);
  const stays = (data ?? []) as RoomStay[];
  const roomLabel = new Map(rooms.map((r) => [r.id, r.label]));
  stays.sort((a, b) => a.arrival_date.localeCompare(b.arrival_date) || compareRoomLabels(roomLabel.get(a.service_point_id) ?? "", roomLabel.get(b.service_point_id) ?? ""));

  return (
    <div>
      <LiveRefresh tables={["room_stays"]} facilityId={ctx.facility.id} intervalMs={60000} />
      <PageHeader
        title="Soggiorni"
        subtitle="Arrivi e partenze: inseriti a mano o importati dal PMS (CSV)."
        action={
          manage ? (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/servizio/camere/soggiorni/importa" variant="secondary">
                Importa CSV
              </LinkButton>
              <LinkButton href="/servizio/camere/soggiorni/nuovo">Nuovo</LinkButton>
            </div>
          ) : undefined
        }
      />
      <RoomsTabs ctx={ctx} active="soggiorni" />

      <form className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]" action="/servizio/camere/soggiorni">
        <label className="text-xs font-bold text-muted">
          Dal
          <Input type="date" name="dal" defaultValue={from} />
        </label>
        <label className="text-xs font-bold text-muted">
          Al
          <Input type="date" name="al" defaultValue={to} />
        </label>
        <label className="text-xs font-bold text-muted">
          Stato
          <Select name="stato" defaultValue={status ?? ""}>
            <option value="">Tutti</option>
            {Object.entries(STAY_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs font-bold text-muted">
          Ospite
          <Input name="q" defaultValue={q} placeholder="Cerca per nome" />
        </label>
        <button className="col-span-2 min-h-11 self-end rounded-xl bg-night px-4 font-bold text-warm sm:col-span-1">Filtra</button>
      </form>

      <Card className="overflow-hidden">
        {stays.length === 0 ? (
          <EmptyState
            title="Nessun soggiorno in questo periodo"
            text={manage ? "Inserisci un soggiorno o importa l'elenco degli arrivi dal PMS." : "La reception non ha ancora inserito arrivi per questo periodo."}
            action={manage ? <LinkButton href="/servizio/camere/soggiorni/importa">Importa CSV</LinkButton> : undefined}
          />
        ) : (
          <ul className="divide-y divide-sand">
            {stays.map((s) => (
              <li key={s.id}>
                <Link href={`/servizio/camere/soggiorni/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-warm">
                  <span className="inline-block min-w-14 rounded-lg bg-sand px-2 py-1 text-center font-extrabold text-night">{roomLabel.get(s.service_point_id) ?? "—"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-night">{s.guest_name}</span>
                    <span className="block text-sm text-muted">
                      {formatDate(s.arrival_date, tz)} → {formatDate(s.departure_date, tz)} · {guestsLabel(s.adults, s.children)}
                      {s.external_ref && ` · ${s.external_ref}`}
                    </span>
                  </span>
                  <Badge tone={STAY_STATUS[s.status].tone}>{STAY_STATUS[s.status].label}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
