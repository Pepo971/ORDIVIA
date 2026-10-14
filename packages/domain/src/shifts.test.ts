import { describe, expect, it } from "vitest";
import {
  checklistDescription,
  checklistRunsOn,
  coverageByDepartmentDay,
  currentWeekStart,
  findOverlaps,
  findShortRests,
  formatHours,
  headcountAt,
  hitsUnavailability,
  hoursByUser,
  localDateOf,
  parseChecklistItems,
  shiftHours,
  shiftInstants,
  shiftWarnings,
  warningsByShift,
  weekDays,
  weekRange,
  weekStartOf,
  weeklyCost,
  type ShiftLike,
} from "./shifts";
import { zonedTimeToUtc } from "./time";

const TZ = "Europe/Rome";

function sh(id: string, userId: string, date: string, start: string, end: string, extra: Partial<ShiftLike> = {}): ShiftLike {
  return { id, userId, ...shiftInstants(date, start, end, TZ), ...extra };
}

describe("settimane nel fuso della struttura", () => {
  it("il lunedì di una data qualunque", () => {
    expect(weekStartOf("2026-10-14")).toBe("2026-10-12"); // mercoledì
    expect(weekStartOf("2026-10-12")).toBe("2026-10-12");
    expect(weekStartOf("2026-10-18")).toBe("2026-10-12"); // domenica
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28"); // a cavallo d'anno
  });

  it("settimana corrente: domenica 23:30 a Roma è ancora la settimana precedente anche se in UTC no", () => {
    const now = zonedTimeToUtc(2026, 10, 18, 23, 30, TZ);
    expect(currentWeekStart(TZ, now)).toBe("2026-10-12");
    const mondayEarly = zonedTimeToUtc(2026, 10, 19, 0, 30, TZ); // in UTC è ancora domenica
    expect(currentWeekStart(TZ, mondayEarly)).toBe("2026-10-19");
  });

  it("7 giorni da lunedì a domenica", () => {
    expect(weekDays("2026-10-19")).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  });

  it("la settimana del cambio d'ora (25/10/2026) dura 169 ore", () => {
    const { from, to } = weekRange("2026-10-19", TZ);
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(169);
    expect(from.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(to.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });

  it("la settimana dell'ora legale (29/03/2026) dura 167 ore", () => {
    const { from, to } = weekRange("2026-03-23", TZ);
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(167);
  });
});

describe("ore dei turni", () => {
  it("8 ore con 30 minuti di pausa = 7,5 ore", () => {
    expect(shiftHours(sh("a", "u", "2026-10-19", "07:00", "15:00", { breakMinutes: 30 }))).toBe(7.5);
  });

  it("turno notturno 18:00 → 02:00 finisce il giorno dopo", () => {
    const s = sh("a", "u", "2026-10-19", "18:00", "02:00");
    expect(shiftHours(s)).toBe(8);
    expect(localDateOf(s.endsAt, TZ)).toBe("2026-10-20");
  });

  it("la notte del cambio d'ora 22:00 → 06:00 dura 9 ore reali", () => {
    expect(shiftHours(sh("a", "u", "2026-10-24", "22:00", "06:00"))).toBe(9);
  });

  it("pausa più lunga del turno non dà ore negative", () => {
    expect(shiftHours(sh("a", "u", "2026-10-19", "10:00", "11:00", { breakMinutes: 90 }))).toBe(0);
  });

  it("totali per persona e formattazione", () => {
    const m = hoursByUser([sh("a", "u1", "2026-10-19", "07:00", "15:00", { breakMinutes: 30 }), sh("b", "u1", "2026-10-20", "07:00", "11:00"), sh("c", "u2", "2026-10-19", "15:00", "23:00")]);
    expect(m.get("u1")).toBe(11.5);
    expect(m.get("u2")).toBe(8);
    expect(formatHours(11.5)).toBe("11 h 30");
    expect(formatHours(8)).toBe("8 h");
  });

  it("stima costo: ore × costo orario, segnala chi non ha costo", () => {
    const c = weeklyCost([sh("a", "u1", "2026-10-19", "07:00", "15:00", { breakMinutes: 30 }), sh("b", "u2", "2026-10-19", "15:00", "23:00")], new Map([["u1", 14]]));
    expect(c.total).toBe(105);
    expect(c.missing).toEqual(["u2"]);
  });
});

describe("avvisi di pianificazione", () => {
  it("sovrapposizione per la stessa persona, non tra persone diverse", () => {
    const list = [sh("a", "u1", "2026-10-19", "07:00", "15:00"), sh("b", "u1", "2026-10-19", "14:00", "18:00"), sh("c", "u2", "2026-10-19", "07:00", "15:00")];
    const o = findOverlaps(list);
    expect(o).toHaveLength(1);
    expect(o[0]!.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("turni contigui non sono sovrapposti", () => {
    expect(findOverlaps([sh("a", "u1", "2026-10-19", "07:00", "15:00"), sh("b", "u1", "2026-10-19", "15:00", "18:00")])).toHaveLength(0);
  });

  it("chiusura alle 01:00 e apertura alle 07:00: 6 ore di riposo < 11", () => {
    const r = findShortRests([sh("a", "u1", "2026-10-19", "17:00", "01:00"), sh("b", "u1", "2026-10-20", "07:00", "15:00")], 11);
    expect(r).toHaveLength(1);
    expect(r[0]!.restHours).toBe(6);
  });

  it("riposo di esattamente 11 ore è ok", () => {
    expect(findShortRests([sh("a", "u1", "2026-10-19", "12:00", "20:00"), sh("b", "u1", "2026-10-20", "07:00", "15:00")], 11)).toHaveLength(0);
  });

  it("riposo nella notte del cambio d'ora conta l'ora in più", () => {
    // 23:00 sab → 09:00 dom = 11 ore reali (10 da parete)
    expect(findShortRests([sh("a", "u1", "2026-10-24", "15:00", "23:00"), sh("b", "u1", "2026-10-25", "09:00", "17:00")], 11)).toHaveLength(0);
  });

  it("oltre 48 ore settimanali", () => {
    const days = weekDays("2026-10-19").slice(0, 6);
    const list = days.map((d, i) => sh(`s${i}`, "u1", d, "08:00", "17:00")); // 6 × 9 = 54
    const w = shiftWarnings(list, { tz: TZ });
    expect(w.filter((x) => x.kind === "ore_settimana")).toHaveLength(1);
    expect(shiftWarnings(list, { tz: TZ, rules: { maxWeekHours: 60 } }).filter((x) => x.kind === "ore_settimana")).toHaveLength(0);
  });

  it("le ore settimanali contano solo i turni della settimana quando indicato", () => {
    const prev = sh("p", "u1", "2026-10-18", "08:00", "20:00");
    const cur = sh("c", "u1", "2026-10-19", "08:00", "20:00");
    const w = shiftWarnings([prev, cur], { tz: TZ, rules: { maxWeekHours: 20 }, weekShiftIds: new Set(["c"]) });
    expect(w.filter((x) => x.kind === "ore_settimana")).toHaveLength(0);
  });

  it("turno durante un'assenza approvata", () => {
    const s = sh("a", "u1", "2026-10-21", "08:00", "16:00");
    const w = shiftWarnings([s], {
      tz: TZ,
      absences: [{ userId: "u1", startsAt: zonedTimeToUtc(2026, 10, 21, 0, 0, TZ), endsAt: zonedTimeToUtc(2026, 10, 23, 0, 0, TZ) }],
    });
    expect(w.map((x) => x.kind)).toEqual(["assenza"]);
    expect(warningsByShift(w).get("a")).toHaveLength(1);
  });

  it("indisponibilità ricorrente (mercoledì 8–13) e per data", () => {
    const wed = sh("a", "u1", "2026-10-21", "12:00", "18:00");
    expect(hitsUnavailability(wed, { userId: "u1", weekday: 3, fromTime: "08:00", toTime: "13:00" }, TZ)).toBe(true);
    expect(hitsUnavailability(wed, { userId: "u1", weekday: 3, fromTime: "08:00", toTime: "12:00" }, TZ)).toBe(false);
    expect(hitsUnavailability(wed, { userId: "u2", weekday: 3 }, TZ)).toBe(false);
    expect(hitsUnavailability(wed, { userId: "u1", onDate: "2026-10-21" }, TZ)).toBe(true);
    // turno notturno che entra nel giorno indisponibile
    expect(hitsUnavailability(sh("n", "u1", "2026-10-20", "20:00", "02:00"), { userId: "u1", onDate: "2026-10-21" }, TZ)).toBe(true);
  });
});

describe("copertura", () => {
  it("ore per reparto e giorno, turno notturno ripartito", () => {
    const cov = coverageByDepartmentDay(
      [sh("a", "u1", "2026-10-19", "07:00", "15:00", { departmentId: "bar", breakMinutes: 60 }), sh("b", "u2", "2026-10-19", "20:00", "04:00", { departmentId: "bar" })],
      TZ,
    );
    expect(cov.get("bar")!.get("2026-10-19")).toBe(7 + 4);
    expect(cov.get("bar")!.get("2026-10-20")).toBe(4);
  });

  it("persone presenti a un'ora", () => {
    const list = [sh("a", "u1", "2026-10-19", "07:00", "15:00", { departmentId: "bar" }), sh("b", "u2", "2026-10-19", "12:00", "20:00", { departmentId: "bar" })];
    expect(headcountAt(list, zonedTimeToUtc(2026, 10, 19, 13, 0, TZ), "bar")).toBe(2);
    expect(headcountAt(list, zonedTimeToUtc(2026, 10, 19, 15, 0, TZ), "bar")).toBe(1);
    expect(headcountAt(list, zonedTimeToUtc(2026, 10, 19, 13, 0, TZ), "cucina")).toBe(0);
  });
});

describe("checklist", () => {
  it("giorni di ricorrenza", () => {
    expect(checklistRunsOn([1, 2, 3, 4, 5], "2026-10-19")).toBe(true);
    expect(checklistRunsOn([1, 2, 3, 4, 5], "2026-10-24")).toBe(false);
  });

  it("voci da testo e descrizione a punti", () => {
    const items = parseChecklistItems("- Accendere macchina\n\n2) Controllare frigo\n• Rifornire banco  ");
    expect(items).toEqual(["Accendere macchina", "Controllare frigo", "Rifornire banco"]);
    expect(checklistDescription(items)).toBe("• Accendere macchina\n• Controllare frigo\n• Rifornire banco");
  });
});
