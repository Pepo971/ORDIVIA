// Logica di dominio del Portale QR per gli ospiti (pura e testabile).
// Il database (public_portal_place_order) applica le regole ufficiali: queste funzioni servono per il carrello nel
// browser e per le anteprime, e devono restare allineate agli stessi limiti.

import { zonedParts } from "./time";

// ---------------------------------------------------------------------------
// Limiti (uguali a quelli delle RPC public_portal_*)
// ---------------------------------------------------------------------------
export const PORTAL_LIMITS = {
  maxLines: 30,
  maxQty: 20,
  maxLineNote: 200,
  maxGuestName: 60,
  maxNotes: 300,
  maxAllergies: 300,
  minMessage: 3,
  maxMessage: 1000,
  maxContact: 120,
} as const;

export type PortalLang = "it" | "en";
export const PORTAL_LANGS: PortalLang[] = ["it", "en"];
export const parseLang = (v: unknown): PortalLang => (v === "en" ? "en" : "it");

// ---------------------------------------------------------------------------
// Palette sicura del colore di marca (chiavi uguali al vincolo in portal_settings.accent)
// Tutti i colori hanno contrasto ≥ 4.5:1 con il bianco per testi e pulsanti.
// ---------------------------------------------------------------------------
export const PORTAL_ACCENTS = {
  turchese: { label: "Turchese", hex: "#0c7d72", soft: "#dcf3ef" },
  blu: { label: "Blu notte", hex: "#17344f", soft: "#e3eaf2" },
  corallo: { label: "Corallo", hex: "#b4401b", soft: "#fbe7df" },
  oliva: { label: "Oliva", hex: "#4d6b1f", soft: "#eaf1dc" },
  sabbia: { label: "Sabbia", hex: "#8a5a12", soft: "#f6ecd8" },
  bordeaux: { label: "Bordeaux", hex: "#7d1f3a", soft: "#f6e1e7" },
} as const;
export type PortalAccent = keyof typeof PORTAL_ACCENTS;
export const PORTAL_ACCENT_KEYS = Object.keys(PORTAL_ACCENTS) as PortalAccent[];
export function accentOf(v: string | null | undefined): (typeof PORTAL_ACCENTS)[PortalAccent] {
  return PORTAL_ACCENTS[(v && v in PORTAL_ACCENTS ? v : "turchese") as PortalAccent];
}

/** Tipi di punto da cui si può abilitare l'ordine dal QR. */
export const PORTAL_ORDER_KINDS = ["tavolo", "ombrellone", "lettino", "cabina", "gazebo", "camera", "piazzola", "piscina", "ritiro", "altro"] as const;

export const REQUEST_CATEGORIES = ["assistenza", "pulizia", "manutenzione", "room_service", "informazioni", "reclamo", "altro"] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Carrello
// ---------------------------------------------------------------------------
export interface CartMenuItem {
  id: string;
  name: string;
  price: number;
  sold_out: boolean;
}

export interface CartLine {
  menu_item_id: string;
  qty: number;
  notes?: string;
}

export interface CartTotals {
  lines: number;
  pieces: number;
  totalCents: number;
  total: number;
}

export type CartIssue =
  | { code: "empty" }
  | { code: "too_many_lines"; max: number }
  | { code: "bad_qty"; itemId: string; max: number }
  | { code: "unknown_item"; itemId: string }
  | { code: "sold_out"; itemId: string; name: string }
  | { code: "note_too_long"; itemId: string; max: number };

/** Aggiunge (o somma) un piatto nel carrello, senza superare la quantità massima. */
export function addToCart(cart: readonly CartLine[], itemId: string, qty = 1): CartLine[] {
  const i = cart.findIndex((l) => l.menu_item_id === itemId && !l.notes);
  if (i >= 0) {
    return cart.map((l, j) => (j === i ? { ...l, qty: Math.min(PORTAL_LIMITS.maxQty, l.qty + qty) } : l));
  }
  if (cart.length >= PORTAL_LIMITS.maxLines) return [...cart];
  return [...cart, { menu_item_id: itemId, qty: Math.max(1, Math.min(PORTAL_LIMITS.maxQty, qty)) }];
}

/** Imposta la quantità di una riga (0 = rimuove). */
export function setCartQty(cart: readonly CartLine[], index: number, qty: number): CartLine[] {
  if (qty <= 0) return cart.filter((_, j) => j !== index);
  return cart.map((l, j) => (j === index ? { ...l, qty: Math.min(PORTAL_LIMITS.maxQty, Math.floor(qty)) } : l));
}

/** Totali del carrello in centesimi (prezzi IVA inclusa). Righe di piatti sconosciuti non contano. */
export function cartTotals(cart: readonly CartLine[], menu: ReadonlyMap<string, CartMenuItem> | readonly CartMenuItem[]): CartTotals {
  const byId = menuMap(menu);
  let totalCents = 0;
  let pieces = 0;
  let lines = 0;
  for (const l of cart) {
    const item = byId.get(l.menu_item_id);
    if (!item) continue;
    totalCents += Math.round(item.price * 100) * l.qty;
    pieces += l.qty;
    lines += 1;
  }
  return { lines, pieces, totalCents, total: totalCents / 100 };
}

/** Verifica il carrello come farà il database: restituisce l'elenco dei problemi (vuoto = ok). */
export function validateCart(cart: readonly CartLine[], menu: ReadonlyMap<string, CartMenuItem> | readonly CartMenuItem[]): CartIssue[] {
  const byId = menuMap(menu);
  const issues: CartIssue[] = [];
  if (cart.length === 0) return [{ code: "empty" }];
  if (cart.length > PORTAL_LIMITS.maxLines) issues.push({ code: "too_many_lines", max: PORTAL_LIMITS.maxLines });
  for (const l of cart) {
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > PORTAL_LIMITS.maxQty) issues.push({ code: "bad_qty", itemId: l.menu_item_id, max: PORTAL_LIMITS.maxQty });
    const item = byId.get(l.menu_item_id);
    if (!item) issues.push({ code: "unknown_item", itemId: l.menu_item_id });
    else if (item.sold_out) issues.push({ code: "sold_out", itemId: item.id, name: item.name });
    if (l.notes && l.notes.trim().length > PORTAL_LIMITS.maxLineNote) issues.push({ code: "note_too_long", itemId: l.menu_item_id, max: PORTAL_LIMITS.maxLineNote });
  }
  return issues;
}

/** Ripulisce un carrello salvato nel browser: solo righe ben formate e piatti ancora ordinabili. */
export function sanitizeCart(raw: unknown, menu: ReadonlyMap<string, CartMenuItem> | readonly CartMenuItem[]): CartLine[] {
  if (!Array.isArray(raw)) return [];
  const byId = menuMap(menu);
  const out: CartLine[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { menu_item_id, qty, notes } = r as Record<string, unknown>;
    if (typeof menu_item_id !== "string") continue;
    const item = byId.get(menu_item_id);
    if (!item || item.sold_out) continue;
    const q = Math.floor(Number(qty));
    if (!Number.isFinite(q) || q < 1) continue;
    const n = typeof notes === "string" ? notes.trim().slice(0, PORTAL_LIMITS.maxLineNote) : "";
    out.push({ menu_item_id, qty: Math.min(PORTAL_LIMITS.maxQty, q), ...(n ? { notes: n } : {}) });
    if (out.length >= PORTAL_LIMITS.maxLines) break;
  }
  return out;
}

function menuMap(menu: ReadonlyMap<string, CartMenuItem> | readonly CartMenuItem[]): ReadonlyMap<string, CartMenuItem> {
  return Array.isArray(menu) ? new Map((menu as readonly CartMenuItem[]).map((m) => [m.id, m])) : (menu as ReadonlyMap<string, CartMenuItem>);
}

// ---------------------------------------------------------------------------
// Orari d'ordine nel fuso della struttura (stessa regola di app.portal_within_hours)
// ---------------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(?::\d{2})?$/;

export function parseHhmm(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = HHMM.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Vero se `now` (istante) cade nella fascia [from, to) dell'ora locale della struttura.
 * Senza fascia = sempre aperto. Una fascia con from > to attraversa la mezzanotte (es. 22:00–02:00).
 */
export function isWithinOrderingHours(from: string | null | undefined, to: string | null | undefined, tz: string, now: Date = new Date()): boolean {
  const f = parseHhmm(from);
  const t = parseHhmm(to);
  if (f == null || t == null || f === t) return true;
  const p = zonedParts(now, tz);
  const cur = p.hour * 60 + p.minute;
  return f < t ? cur >= f && cur < t : cur >= f || cur < t;
}

// ---------------------------------------------------------------------------
// Link di contatto
// ---------------------------------------------------------------------------
/** Numero per wa.me: solo cifre, con prefisso internazionale (default Italia 39). */
export function whatsappNumber(raw: string | null | undefined, defaultCc = "39"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (trimmed.startsWith("+")) return digits.length >= 8 ? digits : null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (!digits.startsWith(defaultCc) || digits.length <= 10) digits = defaultCc + digits;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function whatsappLink(raw: string | null | undefined, text?: string): string | null {
  const n = whatsappNumber(raw);
  if (!n) return null;
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

export function telLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.trim().replace(/[^\d+]/g, "");
  return clean.replace(/\D/g, "").length >= 5 ? `tel:${clean}` : null;
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
/** Testo nella lingua scelta, con ripiego sull'italiano. */
export function pickLang(lang: PortalLang, it: string | null | undefined, en: string | null | undefined): string {
  const v = lang === "en" ? en?.trim() || it?.trim() : it?.trim() || en?.trim();
  return v ?? "";
}

const DICT = {
  it: {
    menu: "Menu",
    order: "Ordina",
    book: "Prenota",
    assistance: "Assistenza",
    offers: "Offerte",
    info: "Informazioni",
    contacts: "Contatti",
    hours: "Orari",
    soldOut: "Esaurito",
    add: "Aggiungi",
    cart: "Il tuo ordine",
    cartEmpty: "Il carrello è vuoto: tocca «Aggiungi» sui piatti.",
    total: "Totale",
    guestName: "Il tuo nome (facoltativo)",
    notes: "Note per il personale",
    allergies: "Allergie o intolleranze",
    allergiesHint: "Le segnaliamo in cucina. In caso di dubbi chiedi sempre al personale.",
    send: "Invia ordine",
    sending: "Invio…",
    payAtTable: "Si paga al tavolo o in cassa.",
    orderSent: "Ordine inviato!",
    orderWaiting: "Il personale lo conferma a breve.",
    orderAccepted: "Ordine confermato: è in preparazione.",
    orderRejected: "Il personale non ha potuto accettare l'ordine. Chiedi informazioni.",
    orderMore: "Ordina altro",
    orderClosed: "Gli ordini dal QR sono chiusi in questo momento.",
    orderHours: (from: string, to: string) => `Ordini dal QR dalle ${from} alle ${to}.`,
    orderNotHere: "Da qui non si ordina dal QR: chiedi al personale o scansiona il QR del tuo tavolo/ombrellone.",
    allergens: "Allergeni",
    requestTitle: "Richiedi assistenza",
    category: "Tipo di richiesta",
    message: "Messaggio",
    contact: "Telefono o email (facoltativo)",
    sendRequest: "Invia richiesta",
    requestSent: "Richiesta inviata: arriviamo appena possibile.",
    bookText: "Per prenotare scrivici o chiamaci:",
    call: "Chiama",
    whatsapp: "WhatsApp",
    email: "Email",
    map: "Mappa",
    validUntil: (d: string) => `Valida fino al ${d}`,
    from: "da",
    youAreAt: "Sei a",
    closedPortal: "Il portale di questa struttura non è ancora attivo.",
    invalidQr: "Questo QR non è valido o non è più attivo.",
    remove: "Togli",
    lineNote: "Nota sul piatto",
    item: "piatto",
    items: "piatti",
    viewCart: "Vedi ordine",
    language: "Lingua",
    poweredBy: "Con Ordivia",
  },
  en: {
    menu: "Menu",
    order: "Order",
    book: "Book",
    assistance: "Assistance",
    offers: "Offers",
    info: "Information",
    contacts: "Contacts",
    hours: "Opening hours",
    soldOut: "Sold out",
    add: "Add",
    cart: "Your order",
    cartEmpty: "Your cart is empty: tap «Add» on a dish.",
    total: "Total",
    guestName: "Your name (optional)",
    notes: "Notes for the staff",
    allergies: "Allergies or intolerances",
    allergiesHint: "We flag them to the kitchen. If in doubt, always ask the staff.",
    send: "Send order",
    sending: "Sending…",
    payAtTable: "You pay at the table or at the till.",
    orderSent: "Order sent!",
    orderWaiting: "The staff will confirm it shortly.",
    orderAccepted: "Order confirmed: it is being prepared.",
    orderRejected: "The staff could not accept the order. Please ask for details.",
    orderMore: "Order more",
    orderClosed: "QR ordering is closed right now.",
    orderHours: (from: string, to: string) => `QR ordering from ${from} to ${to}.`,
    orderNotHere: "Ordering is not available here: ask the staff or scan the QR on your table/umbrella.",
    allergens: "Allergens",
    requestTitle: "Request assistance",
    category: "Request type",
    message: "Message",
    contact: "Phone or email (optional)",
    sendRequest: "Send request",
    requestSent: "Request sent: we will be with you shortly.",
    bookText: "To book, message or call us:",
    call: "Call",
    whatsapp: "WhatsApp",
    email: "Email",
    map: "Map",
    validUntil: (d: string) => `Valid until ${d}`,
    from: "from",
    youAreAt: "You are at",
    closedPortal: "This venue's guest portal is not active yet.",
    invalidQr: "This QR code is not valid or no longer active.",
    remove: "Remove",
    lineNote: "Note for this dish",
    item: "item",
    items: "items",
    viewCart: "View order",
    language: "Language",
    poweredBy: "Powered by Ordivia",
  },
} as const;

export type PortalDict = (typeof DICT)["it"];
export function portalText(lang: PortalLang): PortalDict {
  return DICT[lang] as PortalDict;
}

export const REQUEST_CATEGORY_LABEL: Record<PortalLang, Record<RequestCategory, string>> = {
  it: {
    assistenza: "Assistenza",
    pulizia: "Pulizia",
    manutenzione: "Qualcosa non funziona",
    room_service: "Servizio in camera",
    informazioni: "Informazioni",
    reclamo: "Segnalazione",
    altro: "Altro",
  },
  en: {
    assistenza: "Assistance",
    pulizia: "Cleaning",
    manutenzione: "Something is broken",
    room_service: "Room service",
    informazioni: "Information",
    reclamo: "Complaint",
    altro: "Other",
  },
};

const POINT_KIND: Record<PortalLang, Record<string, string>> = {
  it: { tavolo: "Tavolo", ombrellone: "Ombrellone", lettino: "Lettino", cabina: "Cabina", gazebo: "Gazebo", camera: "Camera", piazzola: "Piazzola", piscina: "Piscina", ritiro: "Punto ritiro", altro: "Punto" },
  en: { tavolo: "Table", ombrellone: "Umbrella", lettino: "Sunbed", cabina: "Cabin", gazebo: "Gazebo", camera: "Room", piazzola: "Pitch", piscina: "Pool", ritiro: "Pick-up point", altro: "Spot" },
};
export function pointKindLabel(lang: PortalLang, kind: string): string {
  return POINT_KIND[lang][kind] ?? kind;
}

const ALLERGEN_EN: Record<string, string> = {
  glutine: "Gluten",
  crostacei: "Crustaceans",
  uova: "Eggs",
  pesce: "Fish",
  arachidi: "Peanuts",
  soia: "Soy",
  latte: "Milk",
  frutta_a_guscio: "Tree nuts",
  sedano: "Celery",
  senape: "Mustard",
  sesamo: "Sesame",
  solfiti: "Sulphites",
  lupini: "Lupin",
  molluschi: "Molluscs",
};
const ALLERGEN_IT: Record<string, string> = {
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
export function allergenLabel(lang: PortalLang, key: string): string {
  return (lang === "en" ? ALLERGEN_EN : ALLERGEN_IT)[key] ?? key;
}

/** Messaggio leggibile per un problema del carrello. */
export function cartIssueText(lang: PortalLang, issue: CartIssue): string {
  const en = lang === "en";
  switch (issue.code) {
    case "empty":
      return en ? "Your cart is empty." : "Il carrello è vuoto.";
    case "too_many_lines":
      return en ? `At most ${issue.max} lines per order.` : `Massimo ${issue.max} righe per ordine.`;
    case "bad_qty":
      return en ? `Quantity must be between 1 and ${issue.max}.` : `La quantità va da 1 a ${issue.max}.`;
    case "unknown_item":
      return en ? "A dish is no longer on the menu." : "Un piatto non è più nel menu.";
    case "sold_out":
      return en ? `«${issue.name}» is sold out.` : `«${issue.name}» è esaurito.`;
    case "note_too_long":
      return en ? `Dish notes: at most ${issue.max} characters.` : `Nota sul piatto: massimo ${issue.max} caratteri.`;
  }
}

/** Formato prezzo per l'ospite (euro, separatori della lingua). */
export function formatPortalPrice(lang: PortalLang, eur: number | string | null | undefined): string {
  if (eur == null) return "";
  return new Intl.NumberFormat(lang === "en" ? "en-IE" : "it-IT", { style: "currency", currency: "EUR" }).format(Number(eur));
}
