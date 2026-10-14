// Logica di dominio del modulo Camere, housekeeping e manutenzione (pura e testabile):
// creazione camere in blocco, stati delle camere, priorità del giro di pulizia, importazione CSV dei soggiorni,
// stati degli interventi e manutenzione ricorrente.
// Le regole che contano per la sicurezza (sovrapposizioni, transizioni, idempotenza) sono replicate nel database
// (migrazione 1300), che resta l'autorità.

import { addDays, type CivilDate } from "./time";

// ---------------------------------------------------------------------------
// Stati
// ---------------------------------------------------------------------------
export type RoomStatus = "libera_pulita" | "libera_sporca" | "occupata" | "in_partenza" | "in_arrivo" | "da_controllare" | "fuori_servizio";
export type HkStatus = "pulita" | "sporca" | "in_pulizia" | "ispezionata";
export type StayStatus = "prevista" | "in_casa" | "partita" | "annullata";
export type RoomUnitKind = "camera" | "piazzola";

type Tone = "neutral" | "teal" | "warn" | "danger" | "ok" | "night";

export const ROOM_STATUS: Record<RoomStatus, { label: string; tone: Tone }> = {
  libera_pulita: { label: "Libera pulita", tone: "ok" },
  libera_sporca: { label: "Libera sporca", tone: "warn" },
  occupata: { label: "Occupata", tone: "night" },
  in_partenza: { label: "In partenza", tone: "teal" },
  in_arrivo: { label: "In arrivo", tone: "teal" },
  da_controllare: { label: "Da controllare", tone: "neutral" },
  fuori_servizio: { label: "Fuori servizio", tone: "danger" },
};

export const HK_STATUS: Record<HkStatus, { label: string; tone: Tone }> = {
  sporca: { label: "Sporca", tone: "warn" },
  in_pulizia: { label: "In pulizia", tone: "teal" },
  pulita: { label: "Pulita", tone: "ok" },
  ispezionata: { label: "Ispezionata", tone: "night" },
};

export const STAY_STATUS: Record<StayStatus, { label: string; tone: Tone }> = {
  prevista: { label: "Prevista", tone: "teal" },
  in_casa: { label: "In casa", tone: "ok" },
  partita: { label: "Partita", tone: "neutral" },
  annullata: { label: "Annullata", tone: "danger" },
};

/** Stati che occupano la camera (gli stessi del vincolo di esclusione nel database). */
export const ACTIVE_STAY_STATUSES: StayStatus[] = ["prevista", "in_casa"];

export interface StayLike {
  service_point_id: string;
  arrival_date: CivilDate;
  departure_date: CivilDate;
  status: StayStatus;
}

/** Soggiorni come intervalli [arrivo, partenza): chi parte oggi non si sovrappone a chi arriva oggi. */
export function staysOverlap(a: StayLike, b: StayLike): boolean {
  return (
    a.service_point_id === b.service_point_id &&
    ACTIVE_STAY_STATUSES.includes(a.status) &&
    ACTIVE_STAY_STATUSES.includes(b.status) &&
    a.arrival_date < b.departure_date &&
    b.arrival_date < a.departure_date
  );
}

export function nightsBetween(arrival: CivilDate, departure: CivilDate): number {
  const utc = (d: CivilDate) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((utc(departure) - utc(arrival)) / 86400000);
}

export interface RoomDayInfo {
  /** stato salvato (room_units.status) */
  status: RoomStatus;
  hkStatus: HkStatus;
  /** ospite in casa che parte oggi */
  departingToday: boolean;
  /** ospite in casa (qualsiasi partenza) */
  inHouse: boolean;
  /** arrivo previsto oggi, non ancora entrato */
  arrivingToday: boolean;
}

/**
 * Stato da mostrare oggi: «in partenza» e «in arrivo» si calcolano dai soggiorni del giorno,
 * «fuori servizio» vince sempre.
 */
export function effectiveRoomStatus(r: RoomDayInfo): RoomStatus {
  if (r.status === "fuori_servizio") return "fuori_servizio";
  if (r.inHouse && r.departingToday) return "in_partenza";
  if (r.inHouse) return "occupata";
  if (r.status === "occupata") return "occupata"; // stato da PMS senza soggiorno locale
  if (r.arrivingToday) {
    if (r.hkStatus === "sporca" || r.hkStatus === "in_pulizia") return "libera_sporca";
    return "in_arrivo";
  }
  return r.status === "in_arrivo" || r.status === "in_partenza" ? "libera_pulita" : r.status;
}

/** Una camera è pronta per l'arrivo quando è libera e ispezionata (o almeno pulita, se non si ispeziona). */
export function isReadyForArrival(r: Pick<RoomDayInfo, "status" | "hkStatus" | "inHouse">, requireInspection = true): boolean {
  if (r.status === "fuori_servizio" || r.inHouse) return false;
  return requireInspection ? r.hkStatus === "ispezionata" : r.hkStatus === "ispezionata" || r.hkStatus === "pulita";
}

// ---------------------------------------------------------------------------
// Azioni di soggiorno e housekeeping (per mostrare solo i pulsanti possibili)
// ---------------------------------------------------------------------------
export type StayAction = "checkin" | "checkout" | "annulla" | "modifica";

export function stayActions(s: { status: StayStatus; arrival_date: CivilDate; departure_date: CivilDate }, today: CivilDate): StayAction[] {
  switch (s.status) {
    case "prevista":
      return [
        ...(s.arrival_date <= today && s.departure_date >= today ? (["checkin"] as StayAction[]) : []),
        "modifica",
        "annulla",
      ];
    case "in_casa":
      return ["checkout", "modifica"];
    default:
      return [];
  }
}

export type HkAction = "inizia" | "finisci" | "ispeziona";

export function hkActions(hk: HkStatus, opts: { manage: boolean; outOfService?: boolean }): HkAction[] {
  if (hk === "sporca") return ["inizia"];
  if (hk === "in_pulizia") return ["finisci"];
  if (hk === "pulita") return opts.manage ? ["ispeziona"] : [];
  // ispezionata: si può comunque ripassare (pulizia extra)
  return opts.outOfService ? [] : ["inizia"];
}

// ---------------------------------------------------------------------------
// Camere in blocco: «101-120, piano 1; 201-215, piano 2»
// ---------------------------------------------------------------------------
export interface RoomBlock {
  floor: string | null;
  labels: string[];
}
export type RoomBlocksResult = { ok: true; blocks: RoomBlock[]; total: number } | { ok: false; error: string };

/**
 * Interpreta l'elenco delle camere da creare. Gruppi separati da «;» o a capo; dentro un gruppo, elementi
 * separati da virgola: intervalli (101-120, P1-P9), etichette singole e opzionalmente «piano X».
 * Senza «piano» esplicito, `defaultFloor` (se indicato).
 */
export function parseRoomBlocks(spec: string, defaultFloor: string | null = null, max = 300): RoomBlocksResult {
  const groups = spec
    .split(/[;\n]/)
    .map((g) => g.trim())
    .filter(Boolean);
  if (groups.length === 0) return { ok: false, error: "Indica le camere, ad esempio 101-120, piano 1" };
  const blocks: RoomBlock[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const g of groups) {
    let floor: string | null = defaultFloor?.trim() || null;
    const labels: string[] = [];
    for (const raw of g.split(",").map((p) => p.trim()).filter(Boolean)) {
      const fm = raw.match(/^piano\s+(.{1,20})$/i);
      if (fm) {
        floor = fm[1]!.trim();
        continue;
      }
      const m = raw.match(/^([A-Za-z]*)\s*(\d+)\s*[-–—]\s*([A-Za-z]*)\s*(\d+)$/);
      if (m) {
        const [, pre1 = "", a, pre2 = "", b] = m;
        if (pre2 && pre2.toLowerCase() !== pre1.toLowerCase()) return { ok: false, error: `Intervallo non valido: ${raw}` };
        const from = Number(a);
        const to = Number(b);
        if (to < from) return { ok: false, error: `Intervallo al contrario: ${raw}` };
        if (total + labels.length + (to - from + 1) > max) return { ok: false, error: `Troppe camere: massimo ${max} per volta` };
        const width = a!.length > 1 && a!.startsWith("0") ? a!.length : 0;
        for (let n = from; n <= to; n++) labels.push(`${pre1}${width ? String(n).padStart(width, "0") : n}`);
      } else {
        if (raw.length > 40) return { ok: false, error: `Etichetta troppo lunga: ${raw.slice(0, 20)}…` };
        if (/\s/.test(raw)) return { ok: false, error: `Non capisco «${raw}»: usa ad esempio 101-120, piano 1` };
        labels.push(raw);
      }
    }
    const unique = labels.filter((l) => !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
    if (unique.length) blocks.push({ floor, labels: unique });
    total += unique.length;
    if (total > max) return { ok: false, error: `Troppe camere: massimo ${max} per volta` };
  }
  if (total === 0) return { ok: false, error: "Nessuna camera indicata" };
  return { ok: true, blocks, total };
}

/** Ordinamento naturale delle etichette (102 prima di 1010, A2 prima di A10). */
export function compareRoomLabels(a: string, b: string): number {
  return a.localeCompare(b, "it", { numeric: true, sensitivity: "base" });
}

/** Ordinamento dei piani: numerici in ordine, poi gli altri (terra, attico…), poi senza piano. */
export function compareFloors(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return compareRoomLabels(a, b);
}

export function groupByFloor<T extends { floor: string | null; label: string }>(rooms: T[]): { floor: string | null; rooms: T[] }[] {
  const map = new Map<string | null, T[]>();
  for (const r of rooms) {
    const k = r.floor ?? null;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()]
    .sort(([a], [b]) => compareFloors(a, b))
    .map(([floor, list]) => ({ floor, rooms: list.sort((x, y) => compareRoomLabels(x.label, y.label)) }));
}

// ---------------------------------------------------------------------------
// Priorità del giro di pulizia
// ---------------------------------------------------------------------------
export type HkTaskKind = "partenza" | "arrivo" | "fermata" | "extra" | "nessuna";

export interface HkRoomInput {
  id: string;
  label: string;
  floor: string | null;
  status: RoomStatus;
  hkStatus: HkStatus;
  /** soggiorno che parte oggi: già partito (true) o ancora in casa (false); null = nessuna partenza oggi */
  departure: { checkedOut: boolean } | null;
  /** arrivo previsto oggi (non ancora entrato), con orario stimato «HH:MM» se noto */
  arrival: { eta: string | null } | null;
  /** ospite in casa che resta (fermata) */
  stayOver: boolean;
}

export interface HkPlanItem<T extends HkRoomInput = HkRoomInput> {
  room: T;
  kind: HkTaskKind;
  /** 0 = più urgente */
  rank: number;
  /** arrivo vicino o passato l'orario di check-in e camera non pronta */
  urgent: boolean;
  /** si può pulire adesso (camera libera o ospite che resta) */
  workable: boolean;
  done: boolean;
  reason: string;
}

function minutesOf(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Ordina le camere del giorno per il giro di pulizia:
 * 1. partenze (prima quelle con un arrivo nello stesso giorno, poi quelle già liberate),
 * 2. arrivi da preparare prima dell'orario di check-in (per orario di arrivo),
 * 3. fermate,
 * 4. altre camere sporche; in fondo quelle già fatte e quelle fuori servizio.
 * A parità: piano e numero di camera.
 */
export function housekeepingPlan<T extends HkRoomInput>(
  rooms: T[],
  opts: { checkinTime?: string; nowTime?: string } = {},
): HkPlanItem<T>[] {
  const checkin = minutesOf(opts.checkinTime ?? "14:00") ?? 14 * 60;
  const now = minutesOf(opts.nowTime ?? null);
  const items = rooms.map((room): HkPlanItem<T> & { sub: number } => {
    const clean = room.hkStatus === "pulita" || room.hkStatus === "ispezionata";
    const oos = room.status === "fuori_servizio";
    let kind: HkTaskKind = "nessuna";
    let rank = 9;
    let sub = 0;
    let reason = "";
    if (room.departure) {
      kind = "partenza";
      rank = 0;
      sub = (room.arrival ? 0 : 2) + (room.departure.checkedOut ? 0 : 1);
      reason = room.arrival ? "Partenza con arrivo oggi" : room.departure.checkedOut ? "Partita, da rifare" : "In partenza";
    } else if (room.arrival) {
      kind = "arrivo";
      rank = 1;
      sub = minutesOf(room.arrival.eta) ?? checkin;
      reason = room.arrival.eta ? `Arrivo previsto alle ${room.arrival.eta}` : "Arrivo oggi";
    } else if (room.stayOver) {
      kind = "fermata";
      rank = 2;
      reason = "Fermata";
    } else if (!clean) {
      kind = "extra";
      rank = 3;
      reason = room.status === "libera_sporca" ? "Libera sporca" : "Da pulire";
    }
    // Fatte (pulite e senza ospite ancora da far partire) e fuori servizio in fondo
    const done = clean && !(room.departure && !room.departure.checkedOut);
    if (done) rank = 10;
    if (oos) rank = 11;
    const workable = !oos && !done && kind !== "nessuna" && (kind !== "partenza" || room.departure!.checkedOut);
    const arrivalMin = room.arrival ? (minutesOf(room.arrival.eta) ?? checkin) : null;
    const urgent = !oos && !done && arrivalMin != null && now != null && now >= Math.min(arrivalMin, checkin) - 60;
    return { room, kind, rank, sub, urgent, workable, done, reason: oos ? "Fuori servizio" : done ? "Fatta" : reason };
  });
  items.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.urgent) - Number(a.urgent) ||
      a.sub - b.sub ||
      compareFloors(a.room.floor, b.room.floor) ||
      compareRoomLabels(a.room.label, b.room.label),
  );
  return items.map(({ sub: _sub, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Importazione CSV dei soggiorni: camera;nome;arrivo;partenza;adulti[;bambini[;riferimento]]
// ---------------------------------------------------------------------------
export interface StayCsvRow {
  line: number;
  room: string;
  guest_name: string;
  arrival: CivilDate;
  departure: CivilDate;
  adults: number;
  children: number;
  external_ref: string | null;
}
export interface StayCsvError {
  line: number;
  raw: string;
  error: string;
}
export interface StayCsvResult {
  rows: StayCsvRow[];
  errors: StayCsvError[];
  skippedHeader: boolean;
}

/** Data «gg/mm/aaaa», «gg-mm-aa», «gg.mm.aaaa» o ISO «aaaa-mm-gg» → ISO; null se non valida. */
export function parseItalianDate(raw: string): CivilDate | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else {
    const it = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
    if (!it) return null;
    d = Number(it[1]);
    m = Number(it[2]);
    y = Number(it[3]);
    if (y < 100) y += 2000;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === "") {
      quoted = true;
      cur = "";
    } else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

function detectSeparator(lines: string[]): string {
  const sample = lines.slice(0, 5).join("\n");
  const counts: [string, number][] = [";", "\t", ","].map((s) => [s, sample.split(s).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ";";
}

/**
 * Interpreta il testo incollato (da Excel o da un export del PMS) e valida ogni riga.
 * `rooms`: etichette delle camere esistenti (confronto senza maiuscole). Le righe con errori non bloccano le altre
 * nell'anteprima; l'importazione vera parte solo senza errori.
 */
export function parseStaysCsv(text: string, rooms: string[], opts: { maxRows?: number } = {}): StayCsvResult {
  const maxRows = opts.maxRows ?? 500;
  const known = new Map(rooms.map((r) => [r.trim().toLowerCase(), r.trim()]));
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  const sep = detectSeparator(nonEmpty);
  const rows: StayCsvRow[] = [];
  const errors: StayCsvError[] = [];
  let skippedHeader = false;
  let seenData = false;

  lines.forEach((rawLine, idx) => {
    const line = idx + 1;
    if (rawLine.trim() === "") return;
    const cols = splitCsvLine(rawLine, sep);
    if (!seenData && !skippedHeader && cols.length >= 4 && !parseItalianDate(cols[2] ?? "") && /camera|room|nome|arrivo/i.test(rawLine)) {
      skippedHeader = true;
      return;
    }
    seenData = true;
    const fail = (error: string) => errors.push({ line, raw: rawLine, error });
    if (rows.length + errors.length >= maxRows) {
      fail(`Troppe righe: massimo ${maxRows} per importazione`);
      return;
    }
    if (cols.length < 4) return fail("Servono almeno camera, nome, arrivo e partenza");
    const [roomRaw = "", name = "", arrRaw = "", depRaw = "", adultsRaw = "", childrenRaw = "", refRaw = ""] = cols;
    const room = known.get(roomRaw.toLowerCase());
    if (!roomRaw) return fail("Manca la camera");
    if (!room) return fail(`Camera «${roomRaw}» inesistente`);
    if (!name) return fail("Manca il nome dell'ospite");
    if (name.length > 160) return fail("Nome troppo lungo");
    const arrival = parseItalianDate(arrRaw);
    if (!arrival) return fail(`Data di arrivo non valida: «${arrRaw}»`);
    const departure = parseItalianDate(depRaw);
    if (!departure) return fail(`Data di partenza non valida: «${depRaw}»`);
    if (departure <= arrival) return fail("La partenza deve essere dopo l'arrivo");
    if (nightsBetween(arrival, departure) > 366) return fail("Soggiorno troppo lungo");
    const adults = adultsRaw === "" ? 1 : Number(adultsRaw);
    if (!Number.isInteger(adults) || adults < 0 || adults > 50) return fail(`Adulti non validi: «${adultsRaw}»`);
    const children = childrenRaw === "" ? 0 : Number(childrenRaw);
    if (!Number.isInteger(children) || children < 0 || children > 50) return fail(`Bambini non validi: «${childrenRaw}»`);
    const ref = refRaw.trim() || null;
    if (ref && ref.length > 80) return fail("Riferimento troppo lungo");
    const row: StayCsvRow = { line, room, guest_name: name, arrival, departure, adults, children, external_ref: ref };
    const clash = rows.find((r) => r.room === room && r.arrival < departure && arrival < r.departure);
    if (clash) return fail(`Si sovrappone alla riga ${clash.line} sulla camera ${room}`);
    rows.push(row);
  });
  return { rows, errors, skippedHeader };
}

// ---------------------------------------------------------------------------
// Manutenzione
// ---------------------------------------------------------------------------
export type TicketStatus = "aperto" | "assegnato" | "in_corso" | "in_attesa_ricambi" | "risolto" | "verificato" | "annullato";
export type TicketPriority = "bassa" | "media" | "alta" | "urgente";

export const TICKET_STATUS: Record<TicketStatus, { label: string; tone: Tone }> = {
  aperto: { label: "Aperto", tone: "warn" },
  assegnato: { label: "Assegnato", tone: "teal" },
  in_corso: { label: "In corso", tone: "teal" },
  in_attesa_ricambi: { label: "Attesa ricambi", tone: "neutral" },
  risolto: { label: "Risolto", tone: "ok" },
  verificato: { label: "Verificato", tone: "night" },
  annullato: { label: "Annullato", tone: "danger" },
};

export const TICKET_PRIORITY: Record<TicketPriority, { label: string; tone: Tone; weight: number }> = {
  urgente: { label: "Urgente", tone: "danger", weight: 0 },
  alta: { label: "Alta", tone: "warn", weight: 1 },
  media: { label: "Media", tone: "neutral", weight: 2 },
  bassa: { label: "Bassa", tone: "neutral", weight: 3 },
};

export const TICKET_CATEGORIES: Record<string, string> = {
  elettrico: "Elettrico",
  idraulico: "Idraulico",
  climatizzazione: "Clima e riscaldamento",
  arredi: "Arredi",
  elettrodomestici: "Elettrodomestici",
  informatica: "TV, Wi-Fi, informatica",
  struttura: "Struttura e infissi",
  piscina: "Piscina",
  giardino: "Giardino ed esterni",
  pulizia: "Pulizia straordinaria",
  altro: "Altro",
};

export const OPEN_TICKET_STATUSES: TicketStatus[] = ["aperto", "assegnato", "in_corso", "in_attesa_ricambi"];

export type TicketAction = "assegna" | "inizia" | "attesa_ricambi" | "riprendi" | "risolvi" | "verifica" | "riapri" | "annulla";

/** Azioni possibili (stessa macchina a stati di maintenance_transition nel database). */
export function ticketActions(status: TicketStatus, who: { manage: boolean; reporter: boolean }): TicketAction[] {
  const a: TicketAction[] = [];
  if (who.manage) {
    if (["aperto", "assegnato", "in_corso", "in_attesa_ricambi"].includes(status)) a.push("assegna");
    if (status === "aperto" || status === "assegnato") a.push("inizia");
    if (status === "in_attesa_ricambi") a.push("riprendi");
    if (status === "assegnato" || status === "in_corso") a.push("attesa_ricambi");
    if (["assegnato", "in_corso", "in_attesa_ricambi"].includes(status)) a.push("risolvi");
  }
  if ((who.manage || who.reporter) && status === "risolto") a.push("verifica", "riapri");
  if (status !== "verificato" && status !== "annullato" && (who.manage || (who.reporter && status === "aperto"))) a.push("annulla");
  return a;
}

/** Stato di destinazione di un'azione (per la RPC). */
export const TICKET_ACTION_TARGET: Record<TicketAction, TicketStatus> = {
  assegna: "assegnato",
  inizia: "in_corso",
  attesa_ricambi: "in_attesa_ricambi",
  riprendi: "in_corso",
  risolvi: "risolto",
  verifica: "verificato",
  riapri: "in_corso",
  annulla: "annullato",
};

/** Interventi aperti in ordine: priorità, poi i più vecchi. */
export function sortTickets<T extends { priority: TicketPriority; status: TicketStatus; created_at: string }>(list: T[]): T[] {
  const open = (s: TicketStatus) => (OPEN_TICKET_STATUSES.includes(s) ? 0 : s === "risolto" ? 1 : 2);
  return [...list].sort(
    (a, b) =>
      open(a.status) - open(b.status) ||
      TICKET_PRIORITY[a.priority].weight - TICKET_PRIORITY[b.priority].weight ||
      (open(a.status) === 0 ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at)),
  );
}

/** Durata leggibile tra due istanti (es. «2 h 15 min», «3 g»). */
export function elapsedLabel(from: string | Date, to: string | Date = new Date()): string {
  const mins = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(mins / 1440)} g`;
}

// ---------------------------------------------------------------------------
// Manutenzione ricorrente (ogni N giorni)
// ---------------------------------------------------------------------------
/**
 * Prossima scadenza dopo aver generato l'intervento del giorno `date`: la prima data della serie
 * (due, due+N, due+2N…) successiva a `date`. Stessa regola di app.next_due_after() nel database.
 */
export function nextDueAfter(due: CivilDate, everyDays: number, date: CivilDate): CivilDate {
  if (!Number.isInteger(everyDays) || everyDays < 1) throw new Error("Intervallo non valido");
  if (due > date) return due;
  const steps = Math.floor(nightsBetween(due, date) / everyDays) + 1;
  return addDays(due, steps * everyDays);
}

/** Scadenze della serie comprese tra `from` e `to` (inclusi), per un calendario. */
export function recurrenceDates(start: CivilDate, everyDays: number, from: CivilDate, to: CivilDate, max = 366): CivilDate[] {
  if (!Number.isInteger(everyDays) || everyDays < 1 || to < from) return [];
  let d = start;
  if (d < from) {
    const steps = Math.ceil(nightsBetween(d, from) / everyDays);
    d = addDays(d, steps * everyDays);
  }
  const out: CivilDate[] = [];
  while (d <= to && out.length < max) {
    out.push(d);
    d = addDays(d, everyDays);
  }
  return out;
}

/** È dovuto (o in ritardo) alla data indicata? */
export function isPlanDue(nextDue: CivilDate, date: CivilDate): boolean {
  return nextDue <= date;
}

/** Garanzia: scaduta, in scadenza (entro `soonDays`) o valida. */
export function warrantyState(until: CivilDate | null, today: CivilDate, soonDays = 30): "nessuna" | "scaduta" | "in_scadenza" | "valida" {
  if (!until) return "nessuna";
  if (until < today) return "scaduta";
  return until <= addDays(today, soonDays) ? "in_scadenza" : "valida";
}

// ---------------------------------------------------------------------------
// Richieste degli ospiti
// ---------------------------------------------------------------------------
export type GuestRequestStatus = "nuova" | "presa_in_carico" | "risolta" | "annullata";
export type GuestRequestCategory = "assistenza" | "pulizia" | "manutenzione" | "room_service" | "informazioni" | "reclamo" | "altro";

export const GUEST_REQUEST_STATUS: Record<GuestRequestStatus, { label: string; tone: Tone }> = {
  nuova: { label: "Nuova", tone: "warn" },
  presa_in_carico: { label: "In carico", tone: "teal" },
  risolta: { label: "Risolta", tone: "ok" },
  annullata: { label: "Annullata", tone: "neutral" },
};

export const GUEST_REQUEST_CATEGORY: Record<GuestRequestCategory, string> = {
  assistenza: "Assistenza",
  pulizia: "Pulizia",
  manutenzione: "Manutenzione",
  room_service: "Room service",
  informazioni: "Informazioni",
  reclamo: "Reclamo",
  altro: "Altro",
};

export const GUEST_REQUEST_SOURCE: Record<string, string> = {
  portale: "Portale QR",
  staff: "Staff",
  telefono: "Telefono",
  whatsapp: "WhatsApp",
  email: "Email",
};

/** Conversioni possibili di una richiesta aperta (stesse regole delle RPC). */
export function requestConversions(category: GuestRequestCategory, status: GuestRequestStatus): ("intervento" | "housekeeping")[] {
  if (status !== "nuova" && status !== "presa_in_carico") return [];
  const out: ("intervento" | "housekeeping")[] = [];
  if (["manutenzione", "reclamo", "assistenza", "altro"].includes(category)) out.push("intervento");
  if (["pulizia", "room_service", "assistenza", "altro"].includes(category)) out.push("housekeeping");
  // l'azione principale per categoria va per prima
  return category === "pulizia" || category === "room_service" ? out.filter((c) => c === "housekeeping") : category === "manutenzione" ? ["intervento"] : out;
}
