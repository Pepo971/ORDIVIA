import { describe, expect, it } from "vitest";
import {
  effectiveRoomStatus,
  elapsedLabel,
  groupByFloor,
  hkActions,
  housekeepingPlan,
  isReadyForArrival,
  nextDueAfter,
  nightsBetween,
  parseItalianDate,
  parseRoomBlocks,
  parseStaysCsv,
  recurrenceDates,
  requestConversions,
  sortTickets,
  stayActions,
  staysOverlap,
  ticketActions,
  warrantyState,
  type HkRoomInput,
} from "./rooms";

describe("parseRoomBlocks", () => {
  it("espande intervalli con piano", () => {
    const r = parseRoomBlocks("101-105, piano 1");
    expect(r).toEqual({ ok: true, total: 5, blocks: [{ floor: "1", labels: ["101", "102", "103", "104", "105"] }] });
  });
  it("più gruppi e etichette singole", () => {
    const r = parseRoomBlocks("101-102, piano 1; 201, 205, Suite, piano 2\nP1-P3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocks).toEqual([
      { floor: "1", labels: ["101", "102"] },
      { floor: "2", labels: ["201", "205", "Suite"] },
      { floor: null, labels: ["P1", "P2", "P3"] },
    ]);
  });
  it("piano predefinito e zeri iniziali", () => {
    const r = parseRoomBlocks("01-03", "terra");
    expect(r.ok && r.blocks[0]).toEqual({ floor: "terra", labels: ["01", "02", "03"] });
  });
  it("rifiuta intervalli al contrario, prefissi diversi, troppi elementi, testo libero", () => {
    expect(parseRoomBlocks("120-101").ok).toBe(false);
    expect(parseRoomBlocks("A1-B3").ok).toBe(false);
    expect(parseRoomBlocks("1-400").ok).toBe(false);
    expect(parseRoomBlocks("camera bella").ok).toBe(false);
    expect(parseRoomBlocks("  ").ok).toBe(false);
  });
  it("ignora i doppioni", () => {
    const r = parseRoomBlocks("101-103; 102, 104");
    expect(r.ok && r.total).toBe(4);
  });
});

describe("stati e soggiorni", () => {
  it("sovrapposizione [arrivo, partenza): chi parte e chi arriva lo stesso giorno convivono", () => {
    const a = { service_point_id: "r", arrival_date: "2026-10-10", departure_date: "2026-10-14", status: "in_casa" as const };
    expect(staysOverlap(a, { ...a, arrival_date: "2026-10-14", departure_date: "2026-10-16", status: "prevista" })).toBe(false);
    expect(staysOverlap(a, { ...a, arrival_date: "2026-10-13", departure_date: "2026-10-16", status: "prevista" })).toBe(true);
    expect(staysOverlap(a, { ...a, arrival_date: "2026-10-13", departure_date: "2026-10-16", status: "annullata" })).toBe(false);
    expect(staysOverlap(a, { ...a, service_point_id: "x" })).toBe(false);
  });
  it("notti", () => {
    expect(nightsBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(nightsBetween("2026-03-28", "2026-03-30")).toBe(2); // ora legale
  });
  it("stato del giorno", () => {
    const base = { status: "occupata" as const, hkStatus: "sporca" as const, inHouse: true, departingToday: false, arrivingToday: false };
    expect(effectiveRoomStatus(base)).toBe("occupata");
    expect(effectiveRoomStatus({ ...base, departingToday: true })).toBe("in_partenza");
    expect(effectiveRoomStatus({ ...base, status: "fuori_servizio", departingToday: true })).toBe("fuori_servizio");
    expect(effectiveRoomStatus({ ...base, inHouse: false, status: "libera_pulita", hkStatus: "ispezionata", arrivingToday: true })).toBe("in_arrivo");
    expect(effectiveRoomStatus({ ...base, inHouse: false, status: "libera_sporca", arrivingToday: true })).toBe("libera_sporca");
    expect(effectiveRoomStatus({ ...base, inHouse: false, status: "da_controllare", hkStatus: "pulita" })).toBe("da_controllare");
  });
  it("pronta per l'arrivo", () => {
    expect(isReadyForArrival({ status: "libera_pulita", hkStatus: "ispezionata", inHouse: false })).toBe(true);
    expect(isReadyForArrival({ status: "da_controllare", hkStatus: "pulita", inHouse: false })).toBe(false);
    expect(isReadyForArrival({ status: "da_controllare", hkStatus: "pulita", inHouse: false }, false)).toBe(true);
    expect(isReadyForArrival({ status: "fuori_servizio", hkStatus: "ispezionata", inHouse: false })).toBe(false);
  });
  it("azioni sul soggiorno", () => {
    const s = { status: "prevista" as const, arrival_date: "2026-10-14", departure_date: "2026-10-16" };
    expect(stayActions(s, "2026-10-14")).toEqual(["checkin", "modifica", "annulla"]);
    expect(stayActions(s, "2026-10-13")).toEqual(["modifica", "annulla"]);
    expect(stayActions({ ...s, status: "in_casa" }, "2026-10-15")).toEqual(["checkout", "modifica"]);
    expect(stayActions({ ...s, status: "partita" }, "2026-10-15")).toEqual([]);
  });
  it("azioni di housekeeping", () => {
    expect(hkActions("sporca", { manage: false })).toEqual(["inizia"]);
    expect(hkActions("in_pulizia", { manage: false })).toEqual(["finisci"]);
    expect(hkActions("pulita", { manage: false })).toEqual([]);
    expect(hkActions("pulita", { manage: true })).toEqual(["ispeziona"]);
  });
});

describe("housekeepingPlan", () => {
  const room = (o: Partial<HkRoomInput> & { id: string }): HkRoomInput => ({
    label: o.id,
    floor: "1",
    status: "occupata",
    hkStatus: "sporca",
    departure: null,
    arrival: null,
    stayOver: false,
    ...o,
  });
  it("partenze, poi arrivi per orario, poi fermate, poi il resto", () => {
    const plan = housekeepingPlan([
      room({ id: "105", stayOver: true }),
      room({ id: "104", status: "libera_pulita", hkStatus: "ispezionata", arrival: { eta: "16:00" } }),
      room({ id: "103", status: "libera_sporca", arrival: { eta: "12:00" } }),
      room({ id: "102", departure: { checkedOut: false } }),
      room({ id: "101", status: "libera_sporca", departure: { checkedOut: true } }),
      room({ id: "106", status: "libera_sporca", departure: { checkedOut: true }, arrival: { eta: null } }),
      room({ id: "107", status: "fuori_servizio" }),
      room({ id: "108", status: "libera_sporca" }),
    ]);
    expect(plan.map((p) => p.room.id)).toEqual(["106", "101", "102", "103", "105", "108", "104", "107"]);
    expect(plan.map((p) => p.kind)).toEqual(["partenza", "partenza", "partenza", "arrivo", "fermata", "extra", "arrivo", "extra"]);
    expect(plan.find((p) => p.room.id === "102")!.workable).toBe(false); // ospite ancora in camera
    expect(plan.find((p) => p.room.id === "101")!.workable).toBe(true);
    expect(plan.find((p) => p.room.id === "104")!.done).toBe(true);
    expect(plan.find((p) => p.room.id === "107")!.reason).toBe("Fuori servizio");
  });
  it("arrivo vicino = urgente, sale in testa al suo gruppo", () => {
    const plan = housekeepingPlan(
      [room({ id: "201", status: "libera_sporca", arrival: { eta: "18:00" } }), room({ id: "202", status: "libera_sporca", arrival: { eta: "12:30" } })],
      { checkinTime: "14:00", nowTime: "11:45" },
    );
    expect(plan[0]!.room.id).toBe("202");
    expect(plan[0]!.urgent).toBe(true);
    expect(plan[1]!.urgent).toBe(false);
  });
  it("a parità ordina per piano e numero", () => {
    const plan = housekeepingPlan([
      room({ id: "a", label: "210", floor: "2", stayOver: true }),
      room({ id: "b", label: "12", floor: "1", stayOver: true }),
      room({ id: "c", label: "9", floor: "1", stayOver: true }),
    ]);
    expect(plan.map((p) => p.room.label)).toEqual(["9", "12", "210"]);
  });
  it("raggruppa per piano", () => {
    const g = groupByFloor([
      { floor: null, label: "P1" },
      { floor: "2", label: "201" },
      { floor: "1", label: "110" },
      { floor: "1", label: "102" },
    ]);
    expect(g.map((x) => [x.floor, x.rooms.map((r) => r.label)])).toEqual([
      ["1", ["102", "110"]],
      ["2", ["201"]],
      [null, ["P1"]],
    ]);
  });
});

describe("parseStaysCsv", () => {
  const rooms = ["101", "102", "Suite"];
  it("date italiane e ISO", () => {
    expect(parseItalianDate("14/10/2026")).toBe("2026-10-14");
    expect(parseItalianDate("1.2.26")).toBe("2026-02-01");
    expect(parseItalianDate("2026-10-14")).toBe("2026-10-14");
    expect(parseItalianDate("31/02/2026")).toBeNull();
    expect(parseItalianDate("domani")).toBeNull();
  });
  it("righe valide, intestazione saltata, separatore automatico", () => {
    const r = parseStaysCsv("camera;nome;arrivo;partenza;adulti\n101;Rossi Mario;14/10/2026;16/10/2026;2\nsuite;\"Bianchi; Anna\";2026-10-14;2026-10-20;1;2;PMS-9", rooms);
    expect(r.skippedHeader).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, room: "101", guest_name: "Rossi Mario", arrival: "2026-10-14", departure: "2026-10-16", adults: 2, children: 0, external_ref: null },
      { line: 3, room: "Suite", guest_name: "Bianchi; Anna", arrival: "2026-10-14", departure: "2026-10-20", adults: 1, children: 2, external_ref: "PMS-9" },
    ]);
  });
  it("tab da Excel e virgola", () => {
    expect(parseStaysCsv("101\tRossi\t14/10/2026\t15/10/2026\t2", rooms).rows).toHaveLength(1);
    expect(parseStaysCsv("101,Rossi,14/10/2026,15/10/2026", rooms).rows[0]!.adults).toBe(1);
  });
  it("segnala ogni errore con il numero di riga", () => {
    const r = parseStaysCsv(
      ["999;X;14/10/2026;15/10/2026;1", "101;;14/10/2026;15/10/2026", "101;Y;15/10/2026;14/10/2026", "101;Z;14/10/2026;16/10/2026;due", "102;A;14/10/2026;16/10/2026;2", "102;B;15/10/2026;17/10/2026;2", "101;C"].join("\n"),
      rooms,
    );
    expect(r.rows.map((x) => x.guest_name)).toEqual(["A"]);
    expect(r.errors.map((e) => [e.line, e.error])).toEqual([
      [1, "Camera «999» inesistente"],
      [2, "Manca il nome dell'ospite"],
      [3, "La partenza deve essere dopo l'arrivo"],
      [4, "Adulti non validi: «due»"],
      [6, "Si sovrappone alla riga 5 sulla camera 102"],
      [7, "Servono almeno camera, nome, arrivo e partenza"],
    ]);
  });
  it("limite di righe", () => {
    const text = Array.from({ length: 5 }, (_, i) => `101;Ospite ${i};${String(i + 1).padStart(2, "0")}/11/2026;${String(i + 2).padStart(2, "0")}/11/2026`).join("\n");
    const r = parseStaysCsv(text, rooms, { maxRows: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.errors).toHaveLength(2);
  });
});

describe("manutenzione", () => {
  it("azioni per ruolo e stato", () => {
    expect(ticketActions("aperto", { manage: false, reporter: true })).toEqual(["annulla"]);
    expect(ticketActions("assegnato", { manage: false, reporter: true })).toEqual([]);
    expect(ticketActions("aperto", { manage: true, reporter: false })).toEqual(["assegna", "inizia", "annulla"]);
    expect(ticketActions("in_corso", { manage: true, reporter: false })).toEqual(["assegna", "attesa_ricambi", "risolvi", "annulla"]);
    expect(ticketActions("in_attesa_ricambi", { manage: true, reporter: false })).toEqual(["assegna", "riprendi", "risolvi", "annulla"]);
    expect(ticketActions("risolto", { manage: false, reporter: true })).toEqual(["verifica", "riapri"]);
    expect(ticketActions("verificato", { manage: true, reporter: true })).toEqual([]);
  });
  it("ordine: aperti per priorità e anzianità, poi risolti, poi chiusi", () => {
    const t = (id: string, priority: "bassa" | "media" | "alta" | "urgente", status: "aperto" | "risolto" | "verificato", created_at: string) => ({ id, priority, status, created_at });
    const sorted = sortTickets([
      t("a", "media", "aperto", "2026-10-14T08:00:00Z"),
      t("b", "urgente", "aperto", "2026-10-14T09:00:00Z"),
      t("c", "media", "aperto", "2026-10-13T08:00:00Z"),
      t("d", "urgente", "verificato", "2026-10-10T08:00:00Z"),
      t("e", "bassa", "risolto", "2026-10-12T08:00:00Z"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "c", "a", "e", "d"]);
  });
  it("durate", () => {
    expect(elapsedLabel("2026-10-14T08:00:00Z", "2026-10-14T08:40:00Z")).toBe("40 min");
    expect(elapsedLabel("2026-10-14T08:00:00Z", "2026-10-14T10:15:00Z")).toBe("2 h 15 min");
    expect(elapsedLabel("2026-10-10T08:00:00Z", "2026-10-14T08:00:00Z")).toBe("4 g");
  });
  it("ricorrenza: prossima scadenza dopo la generazione", () => {
    expect(nextDueAfter("2026-10-09", 30, "2026-10-14")).toBe("2026-11-08");
    expect(nextDueAfter("2026-10-14", 7, "2026-10-14")).toBe("2026-10-21");
    expect(nextDueAfter("2026-08-01", 7, "2026-10-14")).toBe("2026-10-17"); // salta le scadenze arretrate
    expect(nextDueAfter("2026-10-20", 7, "2026-10-14")).toBe("2026-10-20"); // non ancora dovuto
    expect(() => nextDueAfter("2026-10-20", 0, "2026-10-14")).toThrow();
  });
  it("ricorrenza: calendario", () => {
    expect(recurrenceDates("2026-10-01", 10, "2026-10-05", "2026-11-01")).toEqual(["2026-10-11", "2026-10-21", "2026-10-31"]);
    expect(recurrenceDates("2026-10-01", 10, "2026-11-05", "2026-10-01")).toEqual([]);
  });
  it("garanzia", () => {
    expect(warrantyState(null, "2026-10-14")).toBe("nessuna");
    expect(warrantyState("2026-10-01", "2026-10-14")).toBe("scaduta");
    expect(warrantyState("2026-11-01", "2026-10-14")).toBe("in_scadenza");
    expect(warrantyState("2027-11-01", "2026-10-14")).toBe("valida");
  });
});

describe("richieste ospiti", () => {
  it("conversioni per categoria", () => {
    expect(requestConversions("manutenzione", "nuova")).toEqual(["intervento"]);
    expect(requestConversions("pulizia", "presa_in_carico")).toEqual(["housekeeping"]);
    expect(requestConversions("assistenza", "nuova")).toEqual(["intervento", "housekeeping"]);
    expect(requestConversions("informazioni", "nuova")).toEqual([]);
    expect(requestConversions("manutenzione", "risolta")).toEqual([]);
  });
});
