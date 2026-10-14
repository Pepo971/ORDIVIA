// Logica di dominio del modulo Sala, cassa, comande, KDS e pass (pura e testabile).
// Tutti i calcoli di denaro sono in centesimi interi per evitare errori di arrotondamento.
// Il database resta la fonte di verità (totali, pagamenti, chiusura): qui ci sono anteprime e regole di presentazione.

export const toCents = (eur: number | string | null | undefined): number => Math.round(Number(eur ?? 0) * 100);
export const fromCents = (c: number): number => c / 100;

// ---------------------------------------------------------------------------
// Conto: totali, sconti, IVA
// ---------------------------------------------------------------------------
export interface BillLine {
  unitPrice: number | string;
  qty: number;
  vatRate: number | string;
  status?: string;
}

export type DiscountKind = "percentuale" | "importo";
export interface Discount {
  kind: DiscountKind;
  value: number;
}

export interface VatBucket {
  rate: number;
  gross: number;
  net: number;
  vat: number;
}

export interface BillTotals {
  subtotal: number;
  discount: number;
  total: number;
  vat: VatBucket[];
}

const active = (l: BillLine) => l.status !== "annullata";

/** Sconto in centesimi: percentuale arrotondata al centesimo, importo mai oltre il subtotale (come in pos_recalc). */
export function discountCents(subtotalCents: number, discount: Discount | null | undefined): number {
  if (!discount || !(discount.value > 0) || subtotalCents <= 0) return 0;
  if (discount.kind === "percentuale") return Math.round((subtotalCents * Math.min(discount.value, 100)) / 100);
  return Math.min(toCents(discount.value), subtotalCents);
}

/** Ripartisce `amount` centesimi in proporzione ai pesi, con il metodo dei resti maggiori (somma esatta). */
export function allocateCents(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || amount === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const base = raw.map(Math.floor);
  let rest = amount - base.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    base[i]! += 1;
    rest -= 1;
  }
  return base;
}

/** Totali del conto con scorporo IVA per aliquota (prezzi IVA inclusa); lo sconto è ripartito sulle aliquote. */
export function billTotals(lines: BillLine[], discount?: Discount | null): BillTotals {
  const byRate = new Map<number, number>();
  for (const l of lines.filter(active)) {
    const rate = Number(l.vatRate);
    byRate.set(rate, (byRate.get(rate) ?? 0) + toCents(l.unitPrice) * l.qty);
  }
  const rates = [...byRate.keys()].sort((a, b) => a - b);
  const grossByRate = rates.map((r) => byRate.get(r)!);
  const subtotal = grossByRate.reduce((s, v) => s + v, 0);
  const disc = discountCents(subtotal, discount);
  const discByRate = allocateCents(disc, grossByRate);
  const vat = rates.map((rate, i) => {
    const gross = grossByRate[i]! - discByRate[i]!;
    const net = Math.round(gross / (1 + rate / 100));
    return { rate, gross: fromCents(gross), net: fromCents(net), vat: fromCents(gross - net) };
  });
  return { subtotal: fromCents(subtotal), discount: fromCents(disc), total: fromCents(subtotal - disc), vat };
}

// ---------------------------------------------------------------------------
// Divisione del conto e resto
// ---------------------------------------------------------------------------

/** Divide un importo in N quote uguali al centesimo: le prime quote assorbono i centesimi in più. */
export function splitEqual(amountEur: number, parts: number): number[] {
  const n = Math.max(1, Math.floor(parts));
  const cents = toCents(amountEur);
  const base = Math.floor(cents / n);
  const extra = cents - base * n;
  return Array.from({ length: n }, (_, i) => fromCents(base + (i < extra ? 1 : 0)));
}

/** Importo da pagare per alcuni piatti: lordo dei piatti × (totale scontato / subtotale), come calcola il database. */
export function splitByItems(selectedGrossEur: number, subtotalEur: number, totalEur: number, remainingEur?: number): number {
  const sel = toCents(selectedGrossEur);
  const sub = toCents(subtotalEur);
  if (sel <= 0 || sub <= 0) return 0;
  const amount = Math.round((sel * toCents(totalEur)) / sub);
  return fromCents(remainingEur == null ? amount : Math.min(amount, toCents(remainingEur)));
}

export interface ChangeResult {
  change: number;
  short: number;
}

/** Resto da dare (o quanto manca) dato l'importo da pagare e il contante ricevuto. */
export function changeDue(amountEur: number, tenderedEur: number): ChangeResult {
  const diff = toCents(tenderedEur) - toCents(amountEur);
  return diff >= 0 ? { change: fromCents(diff), short: 0 } : { change: 0, short: fromCents(-diff) };
}

/** Banconote utili per arrivare rapidamente a una cifra tonda sopra l'importo (suggerimenti di contante ricevuto). */
export function cashSuggestions(amountEur: number): number[] {
  const c = toCents(amountEur);
  if (c <= 0) return [];
  const out = new Set<number>([c]);
  for (const step of [100, 500, 1000, 5000, 10000]) {
    const v = Math.ceil(c / step) * step;
    if (v > c) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 5).map(fromCents);
}

// ---------------------------------------------------------------------------
// Stati delle righe di comanda
// ---------------------------------------------------------------------------
export const LINE_STATUSES = ["inviata", "in_preparazione", "pronta", "servita", "annullata"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

/** Prossimo stato «naturale» di una riga (tap sul KDS o sul pass). */
export function nextLineStatus(status: string, hasPrepStation = true): LineStatus | null {
  switch (status) {
    case "inviata":
      return hasPrepStation ? "in_preparazione" : "servita";
    case "in_preparazione":
      return "pronta";
    case "pronta":
      return "servita";
    default:
      return null;
  }
}

/** Una riga è ancora «in lavorazione» per cucina/bar. */
export const isInProduction = (status: string) => status === "inviata" || status === "in_preparazione";

// ---------------------------------------------------------------------------
// KDS: età del ticket
// ---------------------------------------------------------------------------
export type AgeTone = "fresh" | "warn" | "late";
export interface TicketAge {
  minutes: number;
  tone: AgeTone;
  label: string;
}

export function ticketAge(sentAt: Date | string, now: Date = new Date(), thresholds = { warn: 10, late: 20 }): TicketAge {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(sentAt).getTime()) / 60000));
  const tone: AgeTone = minutes >= thresholds.late ? "late" : minutes >= thresholds.warn ? "warn" : "fresh";
  const label = minutes < 1 ? "ora" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
  return { minutes, tone, label };
}

// ---------------------------------------------------------------------------
// Incastri: piatti uguali inviati da più comande negli ultimi minuti
// ---------------------------------------------------------------------------
export interface KdsLine {
  id: string;
  orderId: string;
  destination: string;
  destinationKind?: string;
  menuItemId: string | null;
  name: string;
  qty: number;
  status: string;
  sentAt: string | Date;
  notes?: string | null;
  without?: string[] | null;
  allergy?: boolean | null;
}

export interface Incastro {
  menuItemId: string;
  name: string;
  totalQty: number;
  orders: number;
  destinations: string[];
  lineIds: string[];
  oldestSentAt: Date;
  allTables: boolean;
}

/** Una riga è «incastrabile» se è ancora da iniziare e non ha varianti, note o allergie. */
export function isPlainLine(l: KdsLine): boolean {
  return l.status === "inviata" && !l.allergy && !(l.notes && l.notes.trim()) && !(l.without && l.without.length > 0) && !!l.menuItemId;
}

/**
 * Suggerimenti di incastro: raggruppa le righe identiche (stesso piatto, senza note/allergie) inviate negli ultimi
 * `windowMinutes` da almeno due comande diverse. È un suggerimento: decide lo chef.
 */
export function groupIncastri(lines: KdsLine[], now: Date = new Date(), windowMinutes = 5): Incastro[] {
  const since = now.getTime() - windowMinutes * 60000;
  const groups = new Map<string, KdsLine[]>();
  for (const l of lines) {
    if (!isPlainLine(l) || new Date(l.sentAt).getTime() < since) continue;
    const list = groups.get(l.menuItemId!) ?? [];
    list.push(l);
    groups.set(l.menuItemId!, list);
  }
  const out: Incastro[] = [];
  for (const [menuItemId, list] of groups) {
    const orders = new Set(list.map((l) => l.orderId));
    if (orders.size < 2) continue;
    const destinations = [...new Set(list.map((l) => l.destination))];
    out.push({
      menuItemId,
      name: list[0]!.name,
      totalQty: list.reduce((s, l) => s + l.qty, 0),
      orders: orders.size,
      destinations,
      lineIds: list.map((l) => l.id),
      oldestSentAt: new Date(Math.min(...list.map((l) => new Date(l.sentAt).getTime()))),
      allTables: list.every((l) => l.destinationKind === "tavolo"),
    });
  }
  return out.sort((a, b) => b.totalQty - a.totalQty || a.oldestSentAt.getTime() - b.oldestSentAt.getTime());
}

/** «6× Spaghetti vongole su 4 tavoli» */
export function incastroLabel(g: Incastro): string {
  const word = g.allTables ? (g.orders === 1 ? "tavolo" : "tavoli") : g.orders === 1 ? "comanda" : "comande";
  return `${g.totalQty}× ${g.name} su ${g.orders} ${word}`;
}

// ---------------------------------------------------------------------------
// Punti di servizio
// ---------------------------------------------------------------------------
const KIND_LABEL: Record<string, string> = {
  tavolo: "Tavolo",
  ombrellone: "Ombrellone",
  lettino: "Lettino",
  cabina: "Cabina",
  gazebo: "Gazebo",
  camera: "Camera",
  piazzola: "Piazzola",
  piscina: "Piscina",
  ritiro: "Ritiro",
  altro: "Punto",
  asporto: "Asporto",
  banco: "Banco",
};

export const servicePointKindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

/** Etichetta della destinazione come la scrive il database (pos_open_order). */
export function destinationLabel(kind: string, label?: string | null): string {
  const k = servicePointKindLabel(kind);
  return label ? `${k} ${label}` : k;
}

export type RangeResult = { ok: true; labels: string[] } | { ok: false; error: string };

/**
 * Espande una descrizione di tavoli in etichette: «1-20», «1–20», «T1-T8», «T1–8», «A, B, Bar», «1-5, 10».
 * Massimo 200 etichette, ciascuna lunga al massimo 40 caratteri.
 */
export function expandLabelRange(spec: string, max = 200): RangeResult {
  const parts = spec
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "Indica i tavoli, ad esempio 1-20 oppure T1-T8" };
  const labels: string[] = [];
  for (const p of parts) {
    const m = p.match(/^([^\d\s\-–—]*)\s*(\d+)\s*[\-–—]\s*([^\d\s\-–—]*)\s*(\d+)$/);
    if (m) {
      const [, pre1 = "", a, pre2 = "", b] = m;
      if (pre2 && pre2 !== pre1) return { ok: false, error: `Intervallo non valido: ${p}` };
      const from = Number(a);
      const to = Number(b);
      if (to < from) return { ok: false, error: `Intervallo al contrario: ${p}` };
      if (to - from + 1 + labels.length > max) return { ok: false, error: `Troppi elementi: massimo ${max}` };
      for (let n = from; n <= to; n++) labels.push(`${pre1}${n}`);
    } else {
      if (p.length > 40) return { ok: false, error: `Etichetta troppo lunga: ${p.slice(0, 20)}…` };
      labels.push(p);
    }
    if (labels.length > max) return { ok: false, error: `Troppi elementi: massimo ${max}` };
  }
  const unique = [...new Set(labels)];
  return { ok: true, labels: unique };
}

/** Ordinamento naturale delle etichette (T2 prima di T10). */
export function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, "it", { numeric: true, sensitivity: "base" });
}

export function courseLabel(course: number): string {
  return `Uscita ${course}`;
}
