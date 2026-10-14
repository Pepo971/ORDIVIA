// Logica di dominio del modulo Menu, ricette, food cost e HACCP (pura e testabile).
// Il database calcola i valori ufficiali (menu_food_cost, haccp_create_label): queste funzioni servono per
// anteprime in interfaccia e devono restare allineate alle stesse formule.

// ---------------------------------------------------------------------------
// Allergeni UE (Reg. UE 1169/2011, allegato II) — chiavi uguali a app.eu_allergens()
// ---------------------------------------------------------------------------
export const EU_ALLERGENS = [
  "glutine",
  "crostacei",
  "uova",
  "pesce",
  "arachidi",
  "soia",
  "latte",
  "frutta_a_guscio",
  "sedano",
  "senape",
  "sesamo",
  "solfiti",
  "lupini",
  "molluschi",
] as const;
export type Allergen = (typeof EU_ALLERGENS)[number];

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  glutine: "Glutine",
  crostacei: "Crostacei",
  uova: "Uova",
  pesce: "Pesce",
  arachidi: "Arachidi",
  soia: "Soia",
  latte: "Latte",
  frutta_a_guscio: "Frutta a guscio",
  sedano: "Sedano",
  senape: "Senape",
  sesamo: "Sesamo",
  solfiti: "Solfiti",
  lupini: "Lupini",
  molluschi: "Molluschi",
};

export function isAllergen(v: string): v is Allergen {
  return (EU_ALLERGENS as readonly string[]).includes(v);
}

/** Normalizza un elenco di allergeni: solo chiavi valide, senza doppioni, nell'ordine ufficiale. */
export function normalizeAllergens(list: readonly string[]): Allergen[] {
  const set = new Set(list);
  return EU_ALLERGENS.filter((a) => set.has(a));
}

export const MENU_COURSES: { value: number; label: string }[] = [
  { value: 1, label: "Antipasti" },
  { value: 2, label: "Primi" },
  { value: 3, label: "Secondi" },
  { value: 4, label: "Contorni" },
  { value: 5, label: "Pizze" },
  { value: 6, label: "Piatti unici" },
  { value: 7, label: "Formaggi" },
  { value: 8, label: "Dessert" },
  { value: 9, label: "Bar e bevande" },
];

// ---------------------------------------------------------------------------
// Arrotondamenti e IVA
// ---------------------------------------------------------------------------
/** Arrotonda a n decimali evitando gli errori binari tipici (1.005 → 1.01). */
export function roundTo(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  // toPrecision(12) elimina il rumore binario (8.675 × 100 = 867.4999999999999 → 867.5) prima di arrotondare
  return Math.round(Number((v * f).toPrecision(12))) / f;
}

/** Arrotonda per eccesso al multiplo di `step` (es. 0,10 € o 0,50 €). */
export function roundUpTo(v: number, step = 0.1): number {
  if (step <= 0) return v;
  // l'arrotondamento a 6 decimali prima del ceil evita che 12.2000000001 diventi 12.30
  return roundTo(Math.ceil(roundTo(v / step, 6)) * step, 4);
}

/** Prezzo IVA esclusa da un prezzo IVA inclusa. */
export function netOfVat(gross: number, vatRatePct: number): number {
  return gross / (1 + vatRatePct / 100);
}

/** Prezzo IVA inclusa da un prezzo netto. */
export function grossOfVat(net: number, vatRatePct: number): number {
  return net * (1 + vatRatePct / 100);
}

// ---------------------------------------------------------------------------
// Ricetta e food cost
// ---------------------------------------------------------------------------
export interface RecipeLineInput {
  /** quantità lorda nell'unità base del prodotto, per la resa indicata */
  qty: number;
  /** scarto di lavorazione in % (0–99,99): la quantità acquistata è qty / (1 − scarto) */
  wastePct?: number;
  /** costo per unità base (medio ponderato, altrimenti ultimo); null = sconosciuto */
  unitCost: number | null;
}

/** Quantità da acquistare per ottenere `qty` utilizzabile con uno scarto del `wastePct`%. */
export function grossQty(qty: number, wastePct = 0): number {
  if (wastePct < 0 || wastePct >= 100) throw new RangeError("Scarto non valido");
  return qty / (1 - wastePct / 100);
}

export interface PortionCost {
  cost: number;
  missingCosts: number;
}

/** Costo di una porzione: Σ quantità lorda × costo unitario / porzioni prodotte. */
export function portionCost(lines: readonly RecipeLineInput[], yieldPortions = 1): PortionCost {
  if (!(yieldPortions > 0)) throw new RangeError("La resa deve essere maggiore di zero");
  let cost = 0;
  let missingCosts = 0;
  for (const l of lines) {
    if (l.unitCost == null) {
      missingCosts++;
      continue;
    }
    cost += grossQty(l.qty, l.wastePct ?? 0) * l.unitCost;
  }
  return { cost: cost / yieldPortions, missingCosts };
}

/** Food cost % sul prezzo netto. null se il prezzo netto è zero. */
export function foodCostPct(cost: number, netPrice: number): number | null {
  if (!(netPrice > 0)) return null;
  return (cost / netPrice) * 100;
}

/**
 * Prezzo di vendita consigliato IVA inclusa per raggiungere il food cost target,
 * arrotondato per eccesso al passo indicato (default 0,10 €).
 */
export function recommendedPrice(cost: number, targetPct: number, vatRatePct: number, step = 0.1): number | null {
  if (!(cost > 0) || !(targetPct > 0)) return null;
  return roundUpTo(grossOfVat(cost / (targetPct / 100), vatRatePct), step);
}

export interface MenuEconomicsInput {
  price: number; // IVA inclusa
  vatRate: number;
  cost: number; // costo porzione
  targetPct: number;
}

export interface MenuEconomics {
  netPrice: number;
  foodCostPct: number | null;
  /** margine di contribuzione unitario: prezzo netto − costo porzione */
  margin: number;
  marginPct: number | null;
  recommendedPrice: number | null;
  overTarget: boolean;
  /** differenza tra prezzo consigliato e prezzo attuale (positiva = alzare) */
  priceGap: number | null;
}

export function menuEconomics({ price, vatRate, cost, targetPct }: MenuEconomicsInput): MenuEconomics {
  // come numeric in Postgres: 13,20 / 1,10 = 12 esatto, non 11.999999999999998
  const net = roundTo(netOfVat(price, vatRate), 6);
  const fc = foodCostPct(cost, net);
  const rec = recommendedPrice(cost, targetPct, vatRate);
  return {
    netPrice: roundTo(net, 2),
    foodCostPct: fc == null ? null : roundTo(fc, 1),
    margin: roundTo(net - cost, 2),
    marginPct: net > 0 ? roundTo(((net - cost) / net) * 100, 1) : null,
    recommendedPrice: rec,
    overTarget: fc == null ? cost > 0 : fc > targetPct,
    priceGap: rec == null ? null : roundTo(rec - price, 2),
  };
}

export interface RankableItem {
  id: string;
  margin: number;
  foodCostPct: number | null;
  /** porzioni vendute nel periodo, se disponibili: il ranking usa margine × vendite */
  sold?: number;
}

/**
 * Ordina dal più al meno redditizio. Con le vendite usa il margine totale (margine × porzioni),
 * a parità di valore preferisce il food cost più basso.
 */
export function rankByProfit<T extends RankableItem>(items: readonly T[]): T[] {
  const value = (x: T) => (x.sold != null ? x.margin * x.sold : x.margin);
  return [...items].sort((a, b) => value(b) - value(a) || (a.foodCostPct ?? Infinity) - (b.foodCostPct ?? Infinity));
}

/** Impatto € per porzione di una variazione di costo unitario. */
export function costIncreaseImpact(qtyPerPortion: number, oldUnitCost: number, newUnitCost: number): number {
  return qtyPerPortion * (newUnitCost - oldUnitCost);
}

// ---------------------------------------------------------------------------
// HACCP
// ---------------------------------------------------------------------------
export function isOutOfRange(value: number, min: number, max: number): boolean {
  return value < min || value > max;
}

export interface LabelExpiryInput {
  kind: "preparazione" | "apertura";
  preparedAt: Date;
  openedAt?: Date | null;
  shelfLifeDays: number;
  /** scadenze (giorno civile AAAA-MM-GG) dei lotti di origine: la preparazione non può durare di più */
  sourceExpiries?: (string | null | undefined)[];
  /** fuso della struttura, per la fine giornata delle scadenze dei lotti */
  timeZone?: string;
}

/** Fine del giorno civile (mezzanotte del giorno dopo) nel fuso indicato, in UTC. */
function endOfCivilDay(day: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const asUtc = Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
  // offset del fuso a quell'ora
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(asUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(asUtc - (local - asUtc));
}

/** Scadenza dell'etichetta: dalla preparazione o dall'apertura + giorni di conservazione, mai oltre i lotti di origine. */
export function labelExpiry(input: LabelExpiryInput): { expiresAt: Date; capped: boolean } {
  if (input.shelfLifeDays < 0) throw new RangeError("Durata di conservazione non valida");
  const base = input.kind === "apertura" ? (input.openedAt ?? input.preparedAt) : input.preparedAt;
  const computed = new Date(base.getTime() + input.shelfLifeDays * 86_400_000);
  const tz = input.timeZone ?? "Europe/Rome";
  const caps = (input.sourceExpiries ?? [])
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map((d) => endOfCivilDay(d, tz).getTime());
  if (caps.length === 0) return { expiresAt: computed, capped: false };
  const cap = Math.min(...caps);
  return cap < computed.getTime() ? { expiresAt: new Date(cap), capped: true } : { expiresAt: computed, capped: false };
}

export type ExpiryState = "scaduta" | "oggi" | "presto" | "ok";

/** Stato di una scadenza: già passata, entro 12 ore, entro `soonHours` (default 48), oltre. */
export function expiryState(expiresAt: Date, now: Date = new Date(), soonHours = 48): ExpiryState {
  const h = (expiresAt.getTime() - now.getTime()) / 3_600_000;
  if (h <= 0) return "scaduta";
  if (h <= 12) return "oggi";
  if (h <= soonHours) return "presto";
  return "ok";
}

/** Formato del lotto interno: L + AAMMGG + progressivo a 3 cifre (come haccp_create_label). */
export function internalLotCode(day: string, seq: number): string {
  const [y, m, d] = day.split("-");
  return `L${y!.slice(2)}${m}${d}-${String(seq).padStart(3, "0")}`;
}
