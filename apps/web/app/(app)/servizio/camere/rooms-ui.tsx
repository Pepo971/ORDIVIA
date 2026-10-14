import { HK_STATUS, ROOM_STATUS, type HkStatus, type RoomStatus } from "@ordivia/domain";
import { Badge, Tabs, cx } from "@/components/ui";
import { can, type AppContext } from "@/lib/context";

/** Schede interne di Camere: l'housekeeping vede le pulizie, la reception tutto. */
export function RoomsTabs({ ctx, active }: { ctx: AppContext; active: string }) {
  const manage = can(ctx, "rooms.manage");
  const items = [
    ...(manage ? [{ key: "oggi", label: "Oggi", href: "/servizio/camere" }] : []),
    { key: "pulizie", label: "Pulizie", href: "/servizio/camere/pulizie" },
    { key: "soggiorni", label: "Soggiorni", href: "/servizio/camere/soggiorni" },
    ...(manage ? [{ key: "configura", label: "Configura", href: "/servizio/camere/configura" }] : []),
  ];
  return <Tabs items={items} active={active} />;
}

// Colori ad alto contrasto per il colpo d'occhio sul telefono.
export const ROOM_TILE: Record<RoomStatus, string> = {
  libera_pulita: "bg-ok-soft text-ok border-2 border-ok/50",
  libera_sporca: "bg-warn-soft text-warn border-2 border-warn/60",
  occupata: "bg-night text-warm border-2 border-night",
  in_partenza: "bg-teal text-white border-2 border-teal-deep",
  in_arrivo: "bg-teal-soft text-teal-deep border-2 border-teal",
  da_controllare: "bg-white text-night border-2 border-dashed border-night/60",
  fuori_servizio: "bg-danger-soft text-danger border-2 border-dashed border-danger",
};

export function RoomStatusBadge({ status }: { status: RoomStatus }) {
  const s = ROOM_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function HkBadge({ status }: { status: HkStatus }) {
  const s = HK_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function StatusLegend({ counts }: { counts: Partial<Record<RoomStatus, number>> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm font-bold text-night" aria-label="Legenda">
      {(Object.keys(ROOM_TILE) as RoomStatus[]).map((s) => (
        <li key={s} className={cx("flex items-center gap-1.5", !counts[s] && "opacity-50")}>
          <span className={cx("inline-block h-5 w-5 rounded-md", ROOM_TILE[s])} aria-hidden />
          {ROOM_STATUS[s].label}
          <span className="text-muted">{counts[s] ?? 0}</span>
        </li>
      ))}
    </ul>
  );
}

export function guestsLabel(adults: number, children: number) {
  const a = `${adults} ${adults === 1 ? "adulto" : "adulti"}`;
  return children > 0 ? `${a}, ${children} ${children === 1 ? "bambino" : "bambini"}` : a;
}
