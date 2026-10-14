import { describe, expect, it } from "vitest";
import {
  costIncreaseImpact,
  expiryState,
  foodCostPct,
  grossQty,
  internalLotCode,
  isOutOfRange,
  labelExpiry,
  menuEconomics,
  netOfVat,
  normalizeAllergens,
  portionCost,
  rankByProfit,
  recommendedPrice,
  roundTo,
  roundUpTo,
} from "./menu";

describe("arrotondamenti e IVA", () => {
  it("arrotonda senza errori binari", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(8.675, 2)).toBe(8.68);
  });
  it("arrotonda per eccesso al passo", () => {
    expect(roundUpTo(12.1917, 0.1)).toBe(12.2);
    expect(roundUpTo(12.2, 0.1)).toBe(12.2);
    expect(roundUpTo(12.01, 0.5)).toBe(12.5);
  });
  it("scorpora l'IVA", () => {
    expect(netOfVat(13.2, 10)).toBeCloseTo(12, 10);
    expect(netOfVat(12.2, 22)).toBeCloseTo(10, 10);
  });
});

describe("ricetta e food cost", () => {
  it("lo scarto aumenta la quantità da acquistare", () => {
    expect(grossQty(0.25, 20)).toBeCloseTo(0.3125, 10);
    expect(() => grossQty(1, 100)).toThrow();
  });

  it("costo porzione con scarto, resa e ingredienti senza costo (stessi numeri del test SQL)", () => {
    const vongole = portionCost([
      { qty: 0.1, unitCost: 2 },
      { qty: 0.25, wastePct: 20, unitCost: 10 },
    ]);
    expect(vongole.cost).toBeCloseTo(3.325, 10);
    expect(vongole.missingCosts).toBe(0);

    const risotto = portionCost([{ qty: 0.4, unitCost: 2 }, { qty: 1, unitCost: null }], 4);
    expect(risotto.cost).toBeCloseTo(0.2, 10);
    expect(risotto.missingCosts).toBe(1);
    expect(() => portionCost([], 0)).toThrow();
  });

  it("food cost %, margine e prezzo consigliato", () => {
    const e = menuEconomics({ price: 13.2, vatRate: 10, cost: 3.325, targetPct: 30 });
    expect(e.netPrice).toBe(12);
    expect(e.foodCostPct).toBe(27.7);
    expect(e.margin).toBe(8.68);
    expect(e.marginPct).toBe(72.3);
    expect(e.recommendedPrice).toBe(12.2);
    expect(e.overTarget).toBe(false);
    expect(e.priceGap).toBe(-1);
  });

  it("sopra target e prezzo zero", () => {
    expect(menuEconomics({ price: 5.5, vatRate: 10, cost: 3.325, targetPct: 30 }).overTarget).toBe(true);
    const free = menuEconomics({ price: 0, vatRate: 10, cost: 1, targetPct: 30 });
    expect(free.foodCostPct).toBeNull();
    expect(free.overTarget).toBe(true);
    expect(foodCostPct(1, 0)).toBeNull();
    expect(recommendedPrice(0, 30, 10)).toBeNull();
  });

  it("classifica per redditività (margine × vendite se presenti)", () => {
    const r = rankByProfit([
      { id: "a", margin: 2, foodCostPct: 40 },
      { id: "b", margin: 8, foodCostPct: 25 },
      { id: "c", margin: 8, foodCostPct: 20 },
    ]);
    expect(r.map((x) => x.id)).toEqual(["c", "b", "a"]);
    const s = rankByProfit([
      { id: "a", margin: 2, foodCostPct: 40, sold: 100 },
      { id: "b", margin: 8, foodCostPct: 25, sold: 10 },
    ]);
    expect(s[0]!.id).toBe("a");
  });

  it("impatto degli aumenti per porzione", () => {
    expect(costIncreaseImpact(0.3125, 10, 12)).toBeCloseTo(0.625, 10);
  });
});

describe("allergeni", () => {
  it("normalizza: solo i 14 UE, senza doppioni, in ordine", () => {
    expect(normalizeAllergens(["molluschi", "glutine", "plutonio", "glutine"])).toEqual(["glutine", "molluschi"]);
  });
});

describe("HACCP", () => {
  it("fuori range", () => {
    expect(isOutOfRange(3.2, 0, 4)).toBe(false);
    expect(isOutOfRange(7.5, 0, 4)).toBe(true);
    expect(isOutOfRange(-19, -22, -18)).toBe(false);
    expect(isOutOfRange(-15, -22, -18)).toBe(true);
  });

  it("scadenza da preparazione e da apertura", () => {
    const prep = new Date("2026-10-14T08:00:00Z");
    expect(labelExpiry({ kind: "preparazione", preparedAt: prep, shelfLifeDays: 3 }).expiresAt.toISOString()).toBe("2026-10-17T08:00:00.000Z");
    const open = new Date("2026-10-15T10:00:00Z");
    expect(labelExpiry({ kind: "apertura", preparedAt: prep, openedAt: open, shelfLifeDays: 0.5 }).expiresAt.toISOString()).toBe("2026-10-15T22:00:00.000Z");
  });

  it("la scadenza non supera quella dei lotti di origine (fine giornata nel fuso)", () => {
    const prep = new Date("2026-10-14T08:00:00Z");
    const r = labelExpiry({ kind: "preparazione", preparedAt: prep, shelfLifeDays: 5, sourceExpiries: ["2026-10-16", null, "2026-10-20"] });
    expect(r.capped).toBe(true);
    // fine del 16/10 a Roma (CEST, UTC+2) = 16/10 22:00 UTC
    expect(r.expiresAt.toISOString()).toBe("2026-10-16T22:00:00.000Z");
    const winter = labelExpiry({ kind: "preparazione", preparedAt: new Date("2026-12-01T08:00:00Z"), shelfLifeDays: 5, sourceExpiries: ["2026-12-02"] });
    expect(winter.expiresAt.toISOString()).toBe("2026-12-02T23:00:00.000Z");
    expect(labelExpiry({ kind: "preparazione", preparedAt: prep, shelfLifeDays: 1, sourceExpiries: ["2026-10-20"] }).capped).toBe(false);
  });

  it("stato della scadenza", () => {
    const now = new Date("2026-10-14T10:00:00Z");
    expect(expiryState(new Date("2026-10-14T09:00:00Z"), now)).toBe("scaduta");
    expect(expiryState(new Date("2026-10-14T20:00:00Z"), now)).toBe("oggi");
    expect(expiryState(new Date("2026-10-15T20:00:00Z"), now)).toBe("presto");
    expect(expiryState(new Date("2026-10-20T20:00:00Z"), now)).toBe("ok");
  });

  it("lotto interno", () => {
    expect(internalLotCode("2026-10-14", 7)).toBe("L261014-007");
  });
});
