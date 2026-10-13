import { describe, expect, it } from "vitest";
import {
  deadlineUrgency,
  navFor,
  nextOrderWindow,
  priceChange,
  rankToday,
  reorderSuggestion,
  upcomingOrderWindows,
  weightedAverageCost,
  zonedTimeToUtc,
} from "./index";

const TZ = "Europe/Rome";

describe("finestre d'ordine fornitore", () => {
  const bevande = { deliveryWeekdays: [2, 5], cutoffTime: "11:00", leadDays: 1 }; // consegna mar e ven, ordine entro le 11 del giorno prima

  it("lunedì alle 9: ordina entro le 11 di oggi per la consegna di martedì", () => {
    const now = zonedTimeToUtc(2026, 10, 12, 9, 0, TZ); // lunedì 12/10/2026
    const w = nextOrderWindow(bevande, TZ, now)!;
    expect(w.deliveryDate).toBe("2026-10-13");
    expect(w.orderBy.toISOString()).toBe(zonedTimeToUtc(2026, 10, 12, 11, 0, TZ).toISOString());
  });

  it("lunedì alle 12: il cut-off è passato, la prossima consegna è venerdì (ordine giovedì)", () => {
    const now = zonedTimeToUtc(2026, 10, 12, 12, 0, TZ);
    const w = nextOrderWindow(bevande, TZ, now)!;
    expect(w.deliveryDate).toBe("2026-10-16");
    expect(w.orderBy.toISOString()).toBe(zonedTimeToUtc(2026, 10, 15, 11, 0, TZ).toISOString());
  });

  it("gestisce il cambio dell'ora legale (25/10/2026)", () => {
    const now = zonedTimeToUtc(2026, 10, 24, 8, 0, TZ);
    const w = nextOrderWindow({ deliveryWeekdays: [1], cutoffTime: "10:00", leadDays: 1 }, TZ, now)!;
    expect(w.deliveryDate).toBe("2026-10-26");
    // domenica 25 ottobre: dopo il cambio Roma è UTC+1 → 10:00 locali = 09:00 UTC
    expect(w.orderBy.toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("restituisce più finestre in ordine e nessuna senza giorni di consegna", () => {
    const now = zonedTimeToUtc(2026, 10, 12, 9, 0, TZ);
    expect(upcomingOrderWindows(bevande, TZ, now, 3).map((w) => w.deliveryDate)).toEqual(["2026-10-13", "2026-10-16", "2026-10-20"]);
    expect(nextOrderWindow({ deliveryWeekdays: [], cutoffTime: "10:00", leadDays: 1 }, TZ, now)).toBeNull();
  });

  it("classifica l'urgenza della scadenza", () => {
    const now = zonedTimeToUtc(2026, 10, 12, 9, 0, TZ);
    expect(deadlineUrgency(zonedTimeToUtc(2026, 10, 12, 10, 30, TZ), TZ, now)).toBe("critico");
    expect(deadlineUrgency(zonedTimeToUtc(2026, 10, 12, 18, 0, TZ), TZ, now)).toBe("oggi");
    expect(deadlineUrgency(zonedTimeToUtc(2026, 10, 13, 9, 0, TZ), TZ, now)).toBe("prossimo");
    expect(deadlineUrgency(zonedTimeToUtc(2026, 10, 12, 8, 0, TZ), TZ, now)).toBe("scaduto");
  });
});

describe("riordino", () => {
  it("sopra il minimo non suggerisce nulla", () => {
    expect(reorderSuggestion({ onHand: 50, minQty: 48, parQty: 144 }).needed).toBe(false);
  });
  it("sotto il minimo riporta al livello di riordino in confezioni intere", () => {
    expect(reorderSuggestion({ onHand: 30, minQty: 48, parQty: 144, packQty: 24 })).toEqual({ needed: true, qtyBase: 120, packs: 5 });
  });
  it("considera la merce già in arrivo", () => {
    expect(reorderSuggestion({ onHand: 30, minQty: 48, parQty: 144, incoming: 48, packQty: 24 }).needed).toBe(false);
  });
  it("senza minimo impostato non segnala", () => {
    expect(reorderSuggestion({ onHand: 0, minQty: 0, parQty: 0 }).needed).toBe(false);
  });
});

describe("prezzi e costi", () => {
  it("segnala aumenti oltre soglia", () => {
    expect(priceChange(6.0, 6.6)).toMatchObject({ pct: 10, direction: "aumento", anomalous: true });
    expect(priceChange(6.0, 6.1).anomalous).toBe(false);
  });
  it("costo medio ponderato", () => {
    expect(weightedAverageCost(0.2875, 48, 0.275, 24)).toBeCloseTo((6.9 * 2 + 6.6) / 72, 6);
    expect(weightedAverageCost(1, -5, 2, 10)).toBe(2); // giacenza negativa non pesa
  });
});

describe("Oggi", () => {
  it("un cut-off imminente batte un'attività di oggi", () => {
    const now = new Date("2026-10-12T07:00:00Z");
    const ranked = rankToday(
      [
        { id: "a", kind: "attivita_oggi", title: "Pulizia", href: "/" },
        { id: "b", kind: "sotto_scorta", title: "Limoni", href: "/" },
        { id: "c", kind: "ordine_da_inviare", title: "Bevande Sud", href: "/", deadline: new Date("2026-10-12T08:30:00Z") },
      ],
      now,
    );
    expect(ranked.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("navigazione per ruolo", () => {
  it("un collaboratore vede solo Oggi, Lavoro e Scorte", () => {
    expect(navFor(["tasks.perform", "inventory.view"]).map((n) => n.key)).toEqual(["oggi", "lavoro", "scorte"]);
  });
});
