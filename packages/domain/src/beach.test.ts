import { describe, expect, it } from "vitest";
import {
  bookingsConflict,
  defaultEndDate,
  generateGrid,
  mapLayout,
  nextProgressive,
  occupancy,
  pickRate,
  pointStates,
  quotePrice,
  validateGrid,
  validatePeriodRange,
  balanceDue,
  type BeachRate,
  type BookingSpan,
  type DayBooking,
  type MapPoint,
} from "./beach";

const rate = (o: Partial<BeachRate>): BeachRate => ({
  id: o.id ?? Math.random().toString(36),
  kind: "ombrellone",
  zone: null,
  row_label: null,
  period: "giornata",
  valid_from: "2026-05-01",
  valid_to: "2026-09-30",
  price: 20,
  extra_lettino_price: 5,
  included_lettini: 2,
  active: true,
  ...o,
});

describe("generazione mappa", () => {
  it("Settore A, file 1–6, 20 per fila, 2 lettini: 120 ombrelloni numerati in progressione", () => {
    const { points, duplicates } = generateGrid({ kind: "ombrellone", zone: "A", rowFrom: 1, rowTo: 6, perRow: 20, seats: 2, numbering: "progressivo", prefix: "A" });
    expect(points).toHaveLength(120);
    expect(duplicates).toHaveLength(0);
    expect(points[0]).toMatchObject({ label: "A1", row_label: "1", pos_x: 1, pos_y: 1, seats: 2, zone: "A" });
    expect(points[20]).toMatchObject({ label: "A21", row_label: "2", pos_x: 1, pos_y: 2 });
    expect(points[119]).toMatchObject({ label: "A120", row_label: "6", pos_x: 20, pos_y: 6 });
  });

  it("numerazione per fila con zeri e salto delle etichette esistenti", () => {
    const { points, duplicates } = generateGrid({ kind: "ombrellone", zone: "B", rowFrom: 1, rowTo: 2, perRow: 12, seats: 2, numbering: "per_fila" }, ["1-03"]);
    expect(points[0]!.label).toBe("1-01");
    expect(duplicates).toEqual(["1-03"]);
    expect(points).toHaveLength(23);
  });

  it("prossimo numero progressivo e validazioni", () => {
    expect(nextProgressive(["A1", "A12", "B40", "x"], "A")).toBe(13);
    expect(validateGrid({ kind: "ombrellone", zone: "A", rowFrom: 1, rowTo: 50, perRow: 20, seats: 2, numbering: "progressivo" })).toMatch(/al massimo/);
    expect(validateGrid({ kind: "ombrellone", zone: " ", rowFrom: 1, rowTo: 1, perRow: 2, seats: 2, numbering: "progressivo" })).toMatch(/settore/);
    expect(validateGrid({ kind: "cabina", zone: "Cabine", rowFrom: 1, rowTo: 1, perRow: 10, seats: 0, numbering: "progressivo" })).toBeNull();
  });
});

describe("listino", () => {
  const rates = [
    rate({ id: "base", price: 20 }),
    rate({ id: "primaA", zone: "A", row_label: "1", price: 30 }),
    rate({ id: "settA", zone: "A", price: 25 }),
    rate({ id: "alta", price: 28, valid_from: "2026-08-01", valid_to: "2026-08-31" }),
    rate({ id: "sett", period: "settimana", price: 120 }),
    rate({ id: "mattina", period: "mattina", price: 12 }),
  ];
  const p1A = { kind: "ombrellone", zone: "A", row_label: "1" };
  const p3A = { kind: "ombrellone", zone: "A", row_label: "3" };
  const p3B = { kind: "ombrellone", zone: "B", row_label: "3" };

  it("prima fila costa di più: vince la tariffa più specifica", () => {
    expect(pickRate(rates, p1A, "giornata", "2026-07-10")!.id).toBe("primaA");
    expect(pickRate(rates, p3A, "giornata", "2026-07-10")!.id).toBe("settA");
    expect(pickRate(rates, p3B, "giornata", "2026-07-10")!.id).toBe("base");
  });

  it("alta stagione: a parità di specificità vince la validità più recente", () => {
    expect(pickRate(rates, p3B, "giornata", "2026-08-10")!.id).toBe("alta");
    expect(pickRate(rates, p3B, "giornata", "2026-10-10")).toBeNull();
    expect(pickRate(rates, { kind: "cabina", zone: null, row_label: null }, "giornata", "2026-07-10")).toBeNull();
  });

  it("prezzo multi-giorno a cavallo tra bassa e alta stagione, con lettino extra", () => {
    const q = quotePrice(rates, p3B, "giornata", "2026-07-30", "2026-08-02", 3);
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.lines.map((l) => l.amount)).toEqual([25, 25, 33, 33]);
      expect(q.total).toBe(116);
    }
  });

  it("settimana a prezzo fisso e mezza giornata", () => {
    const w = quotePrice(rates, p3B, "settimana", "2026-07-01", "2026-07-07", 2);
    expect(w.ok && w.total).toBe(120);
    const m = quotePrice(rates, p3B, "mattina", "2026-07-01", "2026-07-01", 2);
    expect(m.ok && m.total).toBe(12);
    const missing = quotePrice(rates, p3B, "pomeriggio", "2026-07-01", "2026-07-01", 2);
    expect(missing.ok).toBe(false);
  });

  it("saldo", () => {
    expect(balanceDue(116, 50)).toBe(66);
    expect(balanceDue(20, 30)).toBe(0);
  });
});

describe("periodi e sovrapposizioni", () => {
  const b = (o: Partial<BookingSpan>): BookingSpan => ({ service_point_id: "p1", period: "giornata", start_date: "2026-07-10", end_date: "2026-07-10", status: "prenotata", ...o });

  it("mattina e pomeriggio convivono, la giornata no", () => {
    expect(bookingsConflict(b({ period: "mattina" }), b({ period: "pomeriggio" }))).toBe(false);
    expect(bookingsConflict(b({ period: "mattina" }), b({ period: "mattina" }))).toBe(true);
    expect(bookingsConflict(b({ period: "giornata" }), b({ period: "pomeriggio" }))).toBe(true);
  });

  it("date, postazione e stato", () => {
    expect(bookingsConflict(b({}), b({ period: "settimana", start_date: "2026-07-05", end_date: "2026-07-11" }))).toBe(true);
    expect(bookingsConflict(b({}), b({ start_date: "2026-07-11", end_date: "2026-07-11" }))).toBe(false);
    expect(bookingsConflict(b({}), b({ service_point_id: "p2" }))).toBe(false);
    expect(bookingsConflict(b({}), b({ status: "annullata" }))).toBe(false);
    expect(bookingsConflict(b({}), b({ status: "uscito" }))).toBe(false);
  });

  it("date di fine proposte e verificate", () => {
    expect(defaultEndDate("settimana", "2026-07-10")).toBe("2026-07-16");
    expect(defaultEndDate("mese", "2026-07-15")).toBe("2026-08-14");
    expect(defaultEndDate("mese", "2026-01-31")).toBe("2026-02-27");
    expect(defaultEndDate("stagione", "2026-06-01", "2026-09-15")).toBe("2026-09-15");
    expect(defaultEndDate("giornata", "2026-06-01")).toBe("2026-06-01");
    expect(validatePeriodRange("settimana", "2026-07-10", "2026-07-16")).toBeNull();
    expect(validatePeriodRange("settimana", "2026-07-10", "2026-07-12")).toMatch(/7 giorni/);
    expect(validatePeriodRange("giornata", "2026-07-10", "2026-07-09")).toMatch(/precedente/);
  });
});

describe("giornata e occupazione", () => {
  const pt = (id: string, zone: string, row: string, x: number): MapPoint => ({ id, kind: "ombrellone", label: id, zone, row_label: row, pos_x: x, pos_y: Number(row), active: true });
  const points = [pt("A1", "A", "1", 1), pt("A2", "A", "1", 2), pt("A3", "A", "2", 1), pt("A4", "A", "2", 2), pt("B1", "B", "1", 1), pt("B2", "B", "1", 2)];
  const bk = (o: Partial<DayBooking>): DayBooking => ({ id: Math.random().toString(36), service_point_id: "A1", period: "giornata", start_date: "2026-07-10", end_date: "2026-07-10", status: "prenotata", presentOnDay: false, ...o });
  const bookings = [
    bk({ service_point_id: "A1" }),
    bk({ service_point_id: "A2", status: "presente", presentOnDay: true }),
    bk({ service_point_id: "A3", period: "stagione", start_date: "2026-06-01", end_date: "2026-09-15" }),
    bk({ service_point_id: "B1", period: "mattina" }),
    bk({ service_point_id: "B2", status: "annullata" }),
    bk({ service_point_id: "A4", start_date: "2026-07-11", end_date: "2026-07-11" }),
  ];
  const states = pointStates(points, bookings, new Set(["A4"]), "2026-07-10");

  it("stati della mappa", () => {
    expect(states.get("A1")!.state).toBe("prenotato");
    expect(states.get("A2")!.state).toBe("presente");
    expect(states.get("A3")!.state).toBe("abbonato");
    expect(states.get("A4")!.state).toBe("fuori_servizio");
    expect(states.get("B1")!.freeSlot).toBe("pomeriggio");
    expect(states.get("B2")!.state).toBe("libero");
  });

  it("occupazione totale e per settore (fuori servizio escluso dal totale)", () => {
    const o = occupancy(points, states);
    expect(o.all).toMatchObject({ total: 5, occupied: 4, present: 1, outOfService: 1, pct: 80 });
    expect(o.bySector.map((s) => [s.zone, s.pct])).toEqual([["A", 100], ["B", 50]]);
  });

  it("layout a griglia ordinato", () => {
    const l = mapLayout([...points].reverse());
    expect(l.map((z) => z.zone)).toEqual(["A", "B"]);
    expect(l[0]!.rows.map((r) => r.points.map((p) => p.id))).toEqual([["A1", "A2"], ["A3", "A4"]]);
  });
});
