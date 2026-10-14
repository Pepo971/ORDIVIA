import { describe, expect, it } from "vitest";
import {
  allocateCents,
  billTotals,
  cashSuggestions,
  changeDue,
  compareLabels,
  destinationLabel,
  discountCents,
  expandLabelRange,
  groupIncastri,
  incastroLabel,
  nextLineStatus,
  splitByItems,
  splitEqual,
  ticketAge,
  type KdsLine,
} from "./pos";

describe("conto: totali, sconti e IVA", () => {
  const lines = [
    { unitPrice: 14, qty: 2, vatRate: 10 }, // spaghetti
    { unitPrice: "3.50", qty: 2, vatRate: 22 }, // birre
    { unitPrice: 6, qty: 1, vatRate: 10, status: "annullata" }, // non conta
  ];

  it("somma solo le righe non annullate", () => {
    const t = billTotals(lines);
    expect(t.subtotal).toBe(35);
    expect(t.total).toBe(35);
    expect(t.discount).toBe(0);
  });

  it("scorpora l'IVA per aliquota da prezzi IVA inclusa", () => {
    const t = billTotals(lines);
    const v10 = t.vat.find((v) => v.rate === 10)!;
    const v22 = t.vat.find((v) => v.rate === 22)!;
    expect(v10.gross).toBe(28);
    expect(v10.net).toBe(25.45);
    expect(v10.vat).toBe(2.55);
    expect(v22.net).toBe(5.74);
    expect(v22.vat).toBe(1.26);
    expect(t.vat.reduce((s, v) => s + Math.round(v.gross * 100), 0)).toBe(3500);
  });

  it("sconto percentuale ripartito sulle aliquote con somma esatta", () => {
    const t = billTotals(lines, { kind: "percentuale", value: 10 });
    expect(t.discount).toBe(3.5);
    expect(t.total).toBe(31.5);
    expect(Math.round(t.vat.reduce((s, v) => s + v.gross, 0) * 100)).toBe(3150);
  });

  it("sconto a importo mai oltre il subtotale", () => {
    expect(discountCents(1000, { kind: "importo", value: 50 })).toBe(1000);
    expect(discountCents(1000, { kind: "importo", value: 2.5 })).toBe(250);
    expect(discountCents(1000, { kind: "percentuale", value: 150 })).toBe(1000);
    expect(discountCents(1000, null)).toBe(0);
  });

  it("allocazione con resti maggiori", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateCents(0, [5, 5])).toEqual([0, 0]);
  });
});

describe("divisione del conto e resto", () => {
  it("parti uguali al centesimo", () => {
    expect(splitEqual(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(splitEqual(10, 1)).toEqual([10]);
    expect(splitEqual(10, 0)).toEqual([10]);
    expect(splitEqual(0.05, 2).reduce((a, b) => a + b, 0)).toBeCloseTo(0.05);
  });

  it("per piatti: applica lo sconto in proporzione", () => {
    expect(splitByItems(14, 35, 31.5)).toBe(12.6);
    expect(splitByItems(35, 35, 31.5)).toBe(31.5);
    expect(splitByItems(20, 35, 35, 10)).toBe(10); // non oltre il residuo
    expect(splitByItems(0, 35, 35)).toBe(0);
  });

  it("resto da dare o importo mancante", () => {
    expect(changeDue(23.4, 50)).toEqual({ change: 26.6, short: 0 });
    expect(changeDue(23.4, 20)).toEqual({ change: 0, short: 3.4 });
    expect(changeDue(0.1 + 0.2, 0.3)).toEqual({ change: 0, short: 0 });
  });

  it("suggerimenti di contante", () => {
    expect(cashSuggestions(23.4)).toEqual([23.4, 24, 25, 30, 50]);
    expect(cashSuggestions(0)).toEqual([]);
  });
});

describe("stati e KDS", () => {
  it("avanzamento naturale delle righe", () => {
    expect(nextLineStatus("inviata")).toBe("in_preparazione");
    expect(nextLineStatus("in_preparazione")).toBe("pronta");
    expect(nextLineStatus("pronta")).toBe("servita");
    expect(nextLineStatus("servita")).toBeNull();
    expect(nextLineStatus("annullata")).toBeNull();
    expect(nextLineStatus("inviata", false)).toBe("servita");
  });

  it("colore del ticket per età", () => {
    const now = new Date("2026-07-10T20:30:00Z");
    expect(ticketAge("2026-07-10T20:29:40Z", now)).toMatchObject({ minutes: 0, tone: "fresh", label: "ora" });
    expect(ticketAge("2026-07-10T20:18:00Z", now)).toMatchObject({ minutes: 12, tone: "warn" });
    expect(ticketAge("2026-07-10T20:05:00Z", now)).toMatchObject({ minutes: 25, tone: "late", label: "25 min" });
    expect(ticketAge("2026-07-10T19:00:00Z", now).label).toBe("1 h 30");
    expect(ticketAge("2026-07-10T20:40:00Z", now).minutes).toBe(0);
  });
});

describe("incastri", () => {
  const now = new Date("2026-07-10T20:30:00Z");
  const base = (o: Partial<KdsLine>): KdsLine => ({
    id: Math.random().toString(36),
    orderId: "o1",
    destination: "Tavolo 1",
    destinationKind: "tavolo",
    menuItemId: "spag",
    name: "Spaghetti vongole",
    qty: 1,
    status: "inviata",
    sentAt: "2026-07-10T20:28:00Z",
    ...o,
  });

  it("raggruppa piatti uguali da più tavoli negli ultimi 5 minuti", () => {
    const lines = [
      base({ orderId: "o1", destination: "Tavolo 1", qty: 2 }),
      base({ orderId: "o2", destination: "Tavolo 4", qty: 1 }),
      base({ orderId: "o3", destination: "Tavolo 7", qty: 2 }),
      base({ orderId: "o4", destination: "Tavolo 9", qty: 1 }),
      base({ orderId: "o5", destination: "Tavolo 2", notes: "ben cotti" }), // con nota: escluso
      base({ orderId: "o6", destination: "Tavolo 3", allergy: true }), // allergia: escluso
      base({ orderId: "o7", destination: "Tavolo 5", without: ["aglio"] }), // variante: escluso
      base({ orderId: "o8", destination: "Tavolo 6", sentAt: "2026-07-10T20:20:00Z" }), // troppo vecchio
      base({ orderId: "o9", destination: "Tavolo 8", status: "in_preparazione" }), // già iniziato
      base({ orderId: "o1", menuItemId: "pizza", name: "Margherita" }), // solo un tavolo: niente incastro
    ];
    const g = groupIncastri(lines, now);
    expect(g).toHaveLength(1);
    expect(g[0]!.totalQty).toBe(6);
    expect(g[0]!.orders).toBe(4);
    expect(g[0]!.lineIds).toHaveLength(4);
    expect(incastroLabel(g[0]!)).toBe("6× Spaghetti vongole su 4 tavoli");
  });

  it("su destinazioni miste parla di comande", () => {
    const g = groupIncastri([base({ orderId: "a" }), base({ orderId: "b", destination: "Ombrellone 12", destinationKind: "ombrellone" })], now);
    expect(incastroLabel(g[0]!)).toBe("2× Spaghetti vongole su 2 comande");
  });
});

describe("punti di servizio", () => {
  it("espande intervalli di tavoli", () => {
    expect(expandLabelRange("1-3")).toEqual({ ok: true, labels: ["1", "2", "3"] });
    expect(expandLabelRange("T1–T3")).toEqual({ ok: true, labels: ["T1", "T2", "T3"] });
    expect(expandLabelRange("T1-3, Bar")).toEqual({ ok: true, labels: ["T1", "T2", "T3", "Bar"] });
    expect(expandLabelRange("1-2, 2, 5")).toEqual({ ok: true, labels: ["1", "2", "5"] });
  });

  it("rifiuta intervalli non validi", () => {
    expect(expandLabelRange("").ok).toBe(false);
    expect(expandLabelRange("5-1").ok).toBe(false);
    expect(expandLabelRange("1-500").ok).toBe(false);
    expect(expandLabelRange("A1-B3").ok).toBe(false);
  });

  it("etichette e ordinamento naturale", () => {
    expect(destinationLabel("tavolo", "12")).toBe("Tavolo 12");
    expect(destinationLabel("asporto")).toBe("Asporto");
    expect(["T10", "T2", "T1"].sort(compareLabels)).toEqual(["T1", "T2", "T10"]);
  });
});
