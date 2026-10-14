import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkRequest,
  cleanList,
  findDuplicates,
  formatHm,
  generateDaySlots,
  intervalsOverlap,
  loadLevel,
  matchCustomer,
  nameKey,
  normalizeEmail,
  normalizePhone,
  parseHm,
  parseSegmentFilters,
  peakLoad,
  reminderMailtoLink,
  reminderText,
  reminderWhatsappLink,
  segmentQuery,
  slotAvailability,
  waDigits,
  type WeeklySlotRule,
} from "./reservations";

// 2026-10-15 è un giovedì
const THU = "2026-10-15";
const rules: WeeklySlotRule[] = [
  { weekday: 4, start_time: "19:00", end_time: "22:00", interval_min: 30, capacity: 10 },
  { weekday: 5, start_time: "19:00", end_time: "21:00", interval_min: 60, capacity: 20 },
];
const cena = { id: "cena", duration_min: 120, max_party_size: 8 };

describe("orari", () => {
  it("HH:MM ↔ minuti", () => {
    expect(parseHm("19:30")).toBe(1170);
    expect(parseHm("19:30:00")).toBe(1170);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("7:5")).toBeNull();
    expect(formatHm(1170)).toBe("19:30");
    expect(formatHm(1440 + 30)).toBe("00:30");
  });
});

describe("generazione fasce", () => {
  it("giovedì: dalle 19:00 alle 22:00 ogni 30 minuti", () => {
    const s = generateDaySlots(cena, rules, THU);
    expect(s.map((x) => x.time)).toEqual(["19:00", "19:30", "20:00", "20:30", "21:00", "21:30", "22:00"]);
    expect(s[0]).toMatchObject({ capacity: 10, maxParty: 8 });
  });
  it("giorno senza regole: chiuso", () => {
    expect(generateDaySlots(cena, rules, "2026-10-19")).toEqual([]);
  });
  it("chiusura della struttura o del servizio", () => {
    expect(generateDaySlots(cena, rules, THU, [{ service_id: null, on_date: THU, closed: true, capacity: null }])).toEqual([]);
    expect(generateDaySlots(cena, rules, THU, [{ service_id: "cena", on_date: THU, closed: true, capacity: null }])).toEqual([]);
    expect(generateDaySlots(cena, rules, THU, [{ service_id: "altro", on_date: THU, closed: true, capacity: null }])).toHaveLength(7);
  });
  it("capacità eccezionale e gruppo massimo limitato dalla capacità", () => {
    const s = generateDaySlots(cena, rules, THU, [{ service_id: "cena", on_date: THU, closed: false, capacity: 4 }]);
    expect(s.every((x) => x.capacity === 4 && x.maxParty === 4)).toBe(true);
  });
  it("evento a data unica", () => {
    const evt = { id: "e", duration_min: 150, max_party_size: 4, event_date: THU, event_time: "20:30:00", event_capacity: 30 };
    expect(generateDaySlots(evt, [], THU)).toEqual([{ time: "20:30", minutes: 1230, capacity: 30, maxParty: 4 }]);
    expect(generateDaySlots(evt, [], "2026-10-16")).toEqual([]);
  });
  it("regole sovrapposte: vale la capacità maggiore, senza doppioni", () => {
    const s = generateDaySlots(cena, [...rules, { weekday: 4, start_time: "21:00", end_time: "21:00", interval_min: 30, capacity: 15 }], THU);
    expect(s.filter((x) => x.time === "21:00")).toHaveLength(1);
    expect(s.find((x) => x.time === "21:00")?.capacity).toBe(15);
  });
});

describe("capacità e sovrapposizioni", () => {
  const at = (hm: string) => parseHm(hm)!;
  const bookings = [
    { start: at("20:00"), end: at("22:00"), party: 6 },
    { start: at("21:00"), end: at("23:00"), party: 4 },
  ];
  it("intervalli semiaperti", () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 11, 10, 20)).toBe(true);
  });
  it("picco di presenze contemporanee", () => {
    expect(peakLoad(bookings, at("19:00"), at("21:00"))).toBe(6);
    expect(peakLoad(bookings, at("19:30"), at("21:30"))).toBe(10);
    expect(peakLoad(bookings, at("22:00"), 1440)).toBe(4);
    expect(peakLoad([], 0, 100)).toBe(0);
  });
  it("disponibilità per fascia come nel database", () => {
    const a = slotAvailability(generateDaySlots(cena, rules, THU), bookings, 120);
    expect(Object.fromEntries(a.map((x) => [x.time, x.available]))).toEqual({
      "19:00": 4, "19:30": 0, "20:00": 0, "20:30": 0, "21:00": 0, "21:30": 0, "22:00": 6,
    });
  });
  it("verifica richiesta: chiuso, gruppo, pieno, ok", () => {
    const slots = generateDaySlots(cena, rules, THU);
    expect(checkRequest(slots, bookings, 120, at("18:00"), 2)).toEqual({ ok: false, reason: "chiuso" });
    expect(checkRequest(slots, bookings, 120, at("22:00"), 9)).toEqual({ ok: false, reason: "gruppo" });
    expect(checkRequest(slots, bookings, 120, at("21:30"), 1)).toEqual({ ok: false, reason: "pieno", available: 0 });
    expect(checkRequest(slots, bookings, 120, at("22:00"), 6)).toEqual({ ok: true });
    // walk-in alle 23:15: dentro la durata dell'ultima fascia (22:00 + 120 min)
    expect(checkRequest(slots, [], 120, at("23:15"), 2)).toEqual({ ok: true });
  });
  it("livello di riempimento", () => {
    expect(loadLevel(0, 10)).toBe("vuoto");
    expect(loadLevel(3, 10)).toBe("basso");
    expect(loadLevel(7, 10)).toBe("medio");
    expect(loadLevel(9, 10)).toBe("alto");
    expect(loadLevel(10, 10)).toBe("pieno");
  });
  it("transizioni di stato", () => {
    expect(canTransition("confermata", "arrivata")).toBe(true);
    expect(canTransition("confermata", "completata")).toBe(false);
    expect(canTransition("annullata", "confermata")).toBe(true);
  });
});

describe("recapiti e doppioni", () => {
  it("telefoni italiani e internazionali (stessa regola di app.norm_phone)", () => {
    expect(normalizePhone("333 123 4567")).toBe("+393331234567");
    expect(normalizePhone("+39 333-123.4567")).toBe("+393331234567");
    expect(normalizePhone("0039 333 1234567")).toBe("+393331234567");
    expect(normalizePhone("393331234567")).toBe("+393331234567");
    expect(normalizePhone("06 1234567")).toBe("+39061234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(waDigits("333 123 4567")).toBe("393331234567");
  });
  it("email", () => {
    expect(normalizeEmail(" Mario@Rossi.IT ")).toBe("mario@rossi.it");
    expect(normalizeEmail("mario@")).toBeNull();
  });
  it("chiave del nome: accenti, ordine e punteggiatura", () => {
    expect(nameKey("Niccolò  De Luca")).toBe(nameKey("de luca, niccolo"));
  });
  const list = [
    { id: "1", full_name: "Mario Rossi", phone: "+393331234567", email: null },
    { id: "2", full_name: "M. Rossi", phone: "333 1234567", email: "m@r.it" },
    { id: "3", full_name: "Giulia Bianchi", phone: null, email: "Giulia@b.it" },
    { id: "4", full_name: "Bianchi Giulia", phone: null, email: "giulia@b.it" },
    { id: "5", full_name: "Rossi Mario", phone: null, email: null },
    { id: "6", full_name: "Ugo", phone: null, email: null },
    { id: "7", full_name: "Ugo", phone: null, email: null },
  ];
  it("trova doppioni per telefono, email e nome", () => {
    const d = findDuplicates(list).map((x) => `${x.a.id}-${x.b.id}:${x.reason}`);
    expect(d).toContain("1-2:telefono");
    expect(d).toContain("3-4:email");
    expect(d).toContain("1-5:nome");
    expect(d).not.toContain("6-7:nome"); // nomi troppo corti
  });
  it("collega il cliente esistente (prima il telefono, poi l'email)", () => {
    expect(matchCustomer(list, "0039 333 123 4567")?.id).toBe("1");
    expect(matchCustomer(list, null, "GIULIA@B.IT")?.id).toBe("3");
    expect(matchCustomer(list, "3400000000", "x@y.it")).toBeNull();
  });
  it("elenchi puliti", () => {
    expect(cleanList(["Glutine", " glutine ", "", "Frutta a guscio"])).toEqual(["glutine", "frutta a guscio"]);
    expect(cleanList("lattosio, sedano;lattosio")).toEqual(["lattosio", "sedano"]);
  });
});

describe("segmenti", () => {
  it("filtri validati e serializzati", () => {
    const f = parseSegmentFilters({ tags: "Abituale, vip", marketing: "1", minVisits: "5", lastVisitAfter: "2026-01-01", lastVisitBefore: "boh", minSpend: "-3" });
    expect(f).toEqual({ tags: ["abituale", "vip"], marketing: true, minVisits: 5, lastVisitAfter: "2026-01-01" });
    expect(parseSegmentFilters(Object.fromEntries(new URLSearchParams(segmentQuery(f))))).toEqual(f);
    expect(parseSegmentFilters({ tags: ["a"], marketing: false })).toEqual({ tags: ["a"], marketing: false });
  });
});

describe("promemoria", () => {
  const text = reminderText({
    guestName: "Mario Rossi",
    facilityName: "Osteria del Porto",
    serviceName: "Cena",
    date: THU,
    time: "20:00",
    partySize: 4,
    depositDue: 20,
    cancellationPolicy: "Cancellazione gratuita fino a 24 ore prima.",
    confirmNeeded: true,
  });
  it("testo in italiano con data, ora, persone e acconto", () => {
    expect(text).toContain("Buongiorno Mario,");
    expect(text).toContain("giovedì 15 ottobre alle 20:00, per 4 persone");
    expect(text).toContain("20,00");
    expect(text).toContain("confermarci");
  });
  it("link WhatsApp ed email", () => {
    expect(reminderWhatsappLink("333 123 4567", "Ciao a tutti")).toBe("https://wa.me/393331234567?text=Ciao%20a%20tutti");
    expect(reminderWhatsappLink("x", "t")).toBeNull();
    expect(reminderMailtoLink("A@B.it", "Prenotazione", "t")).toBe("mailto:a@b.it?subject=Prenotazione&body=t");
  });
});
