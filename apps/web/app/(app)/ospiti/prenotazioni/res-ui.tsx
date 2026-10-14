import Link from "next/link";
import { addDays, RESERVATION_STATUS_LABEL, loadLevel, type ReservationStatus } from "@ordivia/domain";
import { Badge, Tabs, cx } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { RES_STATUS_TONE } from "@/lib/reservations-queries";

export const BASE = "/ospiti/prenotazioni";

export function ResTabs({ active }: { active: "giorno" | "settimana" | "promemoria" | "servizi" }) {
  return (
    <Tabs
      active={active}
      items={[
        { key: "giorno", label: "Giornata", href: BASE },
        { key: "settimana", label: "Settimana", href: `${BASE}/settimana` },
        { key: "promemoria", label: "Da ricordare", href: `${BASE}/promemoria` },
        { key: "servizi", label: "Servizi e orari", href: `${BASE}/servizi` },
      ]}
    />
  );
}

export function StatusBadge({ status }: { status: ReservationStatus }) {
  return <Badge tone={RES_STATUS_TONE[status]}>{RESERVATION_STATUS_LABEL[status]}</Badge>;
}

export function DateNav({ date, today, basePath, step = 1, extra = "" }: { date: string; today: string; basePath: string; step?: number; extra?: string }) {
  const link = (d: string) => `${basePath}?data=${d}${extra}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={link(addDays(date, -step))} className="flex h-11 w-11 items-center justify-center rounded-xl border border-sand-deep bg-white text-xl font-bold text-night" aria-label="Indietro">
        ‹
      </Link>
      <form action={basePath} className="flex items-center gap-2">
        <label className="sr-only" htmlFor="res-date">Data</label>
        <input id="res-date" type="date" name="data" defaultValue={date} className="h-11 rounded-xl border border-sand-deep bg-white px-3 font-bold text-night" />
        <button className="h-11 rounded-xl bg-night px-4 font-bold text-warm">Vai</button>
      </form>
      <Link href={link(addDays(date, step))} className="flex h-11 w-11 items-center justify-center rounded-xl border border-sand-deep bg-white text-xl font-bold text-night" aria-label="Avanti">
        ›
      </Link>
      {date !== today && (
        <Link href={link(today)} className="flex h-11 items-center rounded-xl bg-sand px-4 font-bold text-night">
          Oggi
        </Link>
      )}
      <span className="font-display text-lg font-semibold text-night">
        {date === today ? "Oggi, " : ""}
        {formatDate(date)}
      </span>
    </div>
  );
}

const LEVEL_CLASS: Record<ReturnType<typeof loadLevel>, string> = {
  vuoto: "bg-sand",
  basso: "bg-teal-soft",
  medio: "bg-teal",
  alto: "bg-warn",
  pieno: "bg-danger",
};

/** Barra di riempimento: coperti prenotati su capacità. */
export function LoadBar({ booked, capacity }: { booked: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min(100, Math.round((booked / capacity) * 100)) : 100;
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-sand" aria-hidden>
      <div className={cx("h-full rounded-full", LEVEL_CLASS[loadLevel(booked, capacity)])} style={{ width: `${Math.max(pct, booked > 0 ? 6 : 0)}%` }} />
    </div>
  );
}

export function AllergyBadges({ allergies }: { allergies: string[] }) {
  if (allergies.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {allergies.map((a) => (
        <Badge key={a} tone="danger">
          ⚠ {a}
        </Badge>
      ))}
    </span>
  );
}
