const eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
const num = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 3 });

export const formatEur = (v: number | string | null | undefined) => (v == null ? "—" : eur.format(Number(v)));
export const formatQty = (v: number | string | null | undefined, unit?: string) =>
  v == null ? "—" : `${num.format(Number(v))}${unit ? ` ${unit}` : ""}`;

export function formatDateTime(d: string | Date | null | undefined, tz = "Europe/Rome") {
  if (!d) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

export function formatDate(d: string | Date | null | undefined, tz = "Europe/Rome") {
  if (!d) return "—";
  const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return new Intl.DateTimeFormat("it-IT", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(date);
}

export function formatTime(d: string | Date | null | undefined, tz = "Europe/Rome") {
  if (!d) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

export function relativeFromNow(d: Date, now = new Date()) {
  const mins = Math.round((d.getTime() - now.getTime()) / 60000);
  const abs = Math.abs(mins);
  const txt = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} giorni`;
  return mins >= 0 ? `tra ${txt}` : `${txt} fa`;
}

export const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

export const FACILITY_TYPES: Record<string, string> = {
  lido: "Stabilimento balneare",
  ristorante: "Ristorante / pizzeria",
  hotel: "Hotel",
  camping: "Camping / villaggio",
  resort: "Resort",
  ibrida: "Struttura con più servizi",
};
