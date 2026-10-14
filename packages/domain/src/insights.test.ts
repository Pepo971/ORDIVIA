import { describe, expect, it } from "vitest";
import {
  applyInsightFeedback,
  buildInsights,
  normalizeSignals,
  pctChange,
  prepConfidence,
  prepPlan,
  resolvePeriod,
  topInsights,
  type InsightSignals,
  type PrepHistoryDay,
} from "./insights";
import { zonedTimeToUtc } from "./time";

const TZ = "Europe/Rome";

function signals(over: Partial<InsightSignals> = {}): InsightSignals {
  return {
    today: "2026-10-12",
    timezone: TZ,
    finance: true,
    ticket_target_minutes: 15,
    stock: [],
    price_increases: [],
    food_cost: [],
    margin: null,
    waste: [],
    staffing: null,
    kitchen: [],
    haccp: [],
    maintenance: [],
    labels: { expired: 0, expiring_24h: 0 },
    customers: null,
    feedback: [],
    ...over,
  };
}

describe("periodi e confronto", () => {
  const today = "2026-10-14";
  it("7 giorni: confronto con i 7 precedenti", () => {
    const p = resolvePeriod("7g", today);
    expect(p).toMatchObject({ from: "2026-10-08", to: "2026-10-14", days: 7 });
    expect(p.prev).toMatchObject({ from: "2026-10-01", to: "2026-10-07" });
  });
  it("oggi: confronto con lo stesso giorno della settimana scorsa", () => {
    const p = resolvePeriod("oggi", today);
    expect(p.prev).toMatchObject({ from: "2026-10-07", to: "2026-10-07" });
  });
  it("ieri e 30 giorni", () => {
    expect(resolvePeriod("ieri", today)).toMatchObject({ from: "2026-10-13", to: "2026-10-13" });
    const p = resolvePeriod("30g", today);
    expect(p).toMatchObject({ from: "2026-09-15", days: 30 });
    expect(p.prev).toMatchObject({ from: "2026-08-16", to: "2026-09-14" });
  });
  it("stagione: 1 maggio – 30 settembre, confronto con l'anno prima", () => {
    const p = resolvePeriod("stagione", today);
    expect(p).toMatchObject({ from: "2026-05-01", to: "2026-09-30" });
    expect(p.prev).toMatchObject({ from: "2025-05-01", to: "2025-09-30" });
    expect(resolvePeriod("stagione", "2026-07-10")).toMatchObject({ from: "2026-05-01", to: "2026-07-10" });
    expect(resolvePeriod("stagione", "2026-03-01")).toMatchObject({ from: "2025-05-01", to: "2025-09-30" });
  });
  it("personalizzato: date invertite e non valide", () => {
    expect(resolvePeriod("personalizzato", today, { from: "2026-10-10", to: "2026-10-01" })).toMatchObject({ from: "2026-10-01", to: "2026-10-10", days: 10 });
    expect(resolvePeriod("personalizzato", today, { from: "2026-02-30", to: "x" })).toMatchObject({ from: "2026-10-08", to: today });
    expect(resolvePeriod("personalizzato", today, { from: "2020-01-01", to: today }).days).toBe(366);
  });
  it("chiave sconosciuta: 7 giorni", () => {
    expect(resolvePeriod("boh", today).key).toBe("7g");
  });
  it("variazione percentuale: null senza base", () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(80, 100)).toBe(-20);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 4)).toBeNull();
  });
});

describe("assistente: esaurimento prima della consegna", () => {
  // lunedì 12/10/2026 ore 9: fornitore consegna mar e ven, ordine entro le 11 del giorno prima
  const now = zonedTimeToUtc(2026, 10, 12, 9, 0, TZ);
  const sup = { id: "s1", name: "Bevande Sud", delivery_weekdays: [2, 5], cutoff_time: "11:00:00", lead_days: 1 };

  it("scorta per 1,5 giorni e consegna martedì (2 giorni da coprire): segnala", () => {
    const s = signals({ stock: [{ product_id: "p1", name: "Acqua", unit: "pz", on_hand: 30, daily_use: 20, incoming: 0, supplier: sup }] });
    const [i] = buildInsights(s, now);
    expect(i?.rule).toBe("esaurimento");
    expect(i?.action.href).toBe("/acquisti/riordino?fornitore=s1");
    expect(i?.impact).toContain("10 pz");
    expect(i?.data.find((d) => d.label === "Ordina entro")).toBeDefined();
  });
  it("con merce in arrivo sufficiente: nessun suggerimento", () => {
    const s = signals({ stock: [{ product_id: "p1", name: "Acqua", unit: "pz", on_hand: 30, daily_use: 20, incoming: 48, supplier: sup }] });
    expect(buildInsights(s, now)).toHaveLength(0);
  });
  it("dopo il cut-off la consegna utile è venerdì: serve più scorta", () => {
    const after = zonedTimeToUtc(2026, 10, 12, 12, 0, TZ);
    const s = signals({ stock: [{ product_id: "p1", name: "Acqua", unit: "pz", on_hand: 70, daily_use: 20, incoming: 0, supplier: sup }] });
    expect(buildInsights(s, now)).toHaveLength(0); // 3,5 giorni ≥ 2
    expect(buildInsights(s, after)[0]?.rule).toBe("esaurimento"); // 3,5 giorni < 5 (lun→ven)
  });
  it("senza fornitore: suggerisce di aggiungerne uno", () => {
    const s = signals({ stock: [{ product_id: "p1", name: "Limoni", unit: "kg", on_hand: 1, daily_use: 2, incoming: 0, supplier: null }] });
    expect(buildInsights(s, now)[0]?.action.href).toBe("/acquisti/fornitori");
  });
});

describe("assistente: regole economiche", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  const inc = { product_id: "p", product: "Mozzarella", unit: "kg", supplier_id: "s", supplier: "Caseificio", pack_label: "kg", old_price: 10, new_price: 10.4, observed_at: "2026-10-10T08:00:00Z", increase_pct: 4, monthly_impact: 12 };

  it("aumento prezzo: oltre il 5% sì, sotto no", () => {
    expect(buildInsights(signals({ price_increases: [inc] }), now)).toHaveLength(0);
    const r = buildInsights(signals({ price_increases: [{ ...inc, new_price: 11.6, increase_pct: 16 }] }), now);
    expect(r[0]).toMatchObject({ rule: "aumento_prezzo", severity: "alta", economic: true, impactEur: 12 });
  });
  it("senza finance: nessun suggerimento economico anche se arrivano dati", () => {
    const s = signals({
      finance: false,
      price_increases: [{ ...inc, increase_pct: 16 }],
      margin: { cur: { net: 1000, cost: 400 }, prev: { net: 1000, cost: 300 } },
    });
    expect(buildInsights(s, now)).toHaveLength(0);
  });
  it("food cost sopra obiettivo con almeno 5 porzioni vendute", () => {
    const fc = { menu_item_id: "m1", name: "Frittura", target: 30, portion_cost: 4, missing: 0, qty_28d: 40, net_28d: 400, food_cost_pct: 40 };
    const [i] = buildInsights(signals({ food_cost: [fc] }), now);
    expect(i).toMatchObject({ rule: "food_cost", severity: "alta", impactEur: 40 });
    expect(i?.action.href).toBe("/servizio/menu/m1");
    expect(buildInsights(signals({ food_cost: [{ ...fc, qty_28d: 3 }] }), now)).toHaveLength(0);
    expect(buildInsights(signals({ food_cost: [{ ...fc, food_cost_pct: 29 }] }), now)).toHaveLength(0);
  });
  it("margine in calo di almeno 3 punti", () => {
    const [i] = buildInsights(signals({ margin: { cur: { net: 1000, cost: 350 }, prev: { net: 1000, cost: 300 } } }), now);
    expect(i).toMatchObject({ rule: "margine", impactEur: 50 });
    expect(buildInsights(signals({ margin: { cur: { net: 1000, cost: 310 }, prev: { net: 1000, cost: 300 } } }), now)).toHaveLength(0);
  });
});

describe("assistente: regole operative", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  it("spreco in crescita oltre il 25%", () => {
    const w = { product_id: "p", name: "Pane", unit: "kg", cur: 6, prev: 3, cur_movements: 4, cur_value: null, prev_value: null };
    expect(buildInsights(signals({ waste: [w] }), now)[0]?.rule).toBe("spreco");
    expect(buildInsights(signals({ waste: [{ ...w, cur: 3.5 }] }), now)).toHaveLength(0);
    expect(buildInsights(signals({ waste: [{ ...w, cur_movements: 1 }] }), now)).toHaveLength(0);
  });
  it("tempi cucina oltre l'obiettivo con abbastanza righe", () => {
    const k = { station_id: "c", name: "Cucina", lines: 40, avg_ready_min: 24, p90_ready_min: 35 };
    expect(buildInsights(signals({ kitchen: [k] }), now)[0]).toMatchObject({ rule: "tempi_cucina", severity: "alta" });
    expect(buildInsights(signals({ kitchen: [{ ...k, lines: 5 }] }), now)).toHaveLength(0);
    expect(buildInsights(signals({ kitchen: [{ ...k, avg_ready_min: 12, p90_ready_min: 18 }] }), now)).toHaveLength(0);
  });
  it("personale sotto il fabbisogno rispetto ai coperti attesi", () => {
    const st = { hist_covers: 400, hist_hours: 100, days: [{ date: "2026-10-17", planned_hours: 10, forecast_covers: 80, booked_covers: 120 }] };
    const [i] = buildInsights(signals({ staffing: st }), now); // servono 120 / 4 = 30 h
    expect(i).toMatchObject({ rule: "personale", severity: "alta" });
    expect(i?.impact).toContain("20");
    expect(buildInsights(signals({ staffing: { ...st, days: [{ ...st.days[0]!, planned_hours: 28 }] } }), now)).toHaveLength(0);
    expect(buildInsights(signals({ staffing: { ...st, hist_hours: 0 } }), now)).toHaveLength(0);
  });
  it("HACCP ricorrente o senza azione correttiva, etichette, manutenzione, clienti", () => {
    const s = signals({
      haccp: [{ equipment_id: "e", name: "Frigo 1", out_count: 1, without_action: 1, last_at: "2026-10-11T10:00:00Z" }],
      labels: { expired: 2, expiring_24h: 1 },
      maintenance: [{ label: "Camera 12", kind: "camera", count: 3, open: 1 }],
      customers: { count: 14, min_days: 90, max_days: 365 },
    });
    const rules = buildInsights(s, now).map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["haccp", "etichette", "manutenzione", "clienti"]));
    expect(rules.at(-1)).toBe("clienti"); // gravità bassa in fondo
  });
});

describe("assistente: riscontri e top 3", () => {
  const now = new Date("2026-10-12T08:00:00Z");
  const s = signals({
    labels: { expired: 1, expiring_24h: 0 },
    customers: { count: 3, min_days: 90, max_days: 365 },
    maintenance: [{ label: "Doccia", kind: null, count: 2, open: 0 }],
    kitchen: [{ station_id: "c", name: "Cucina", lines: 40, avg_ready_min: 18, p90_ready_min: 20 }],
  });
  it("ignorati e rimandati escono dagli attivi finché il riscontro vale", () => {
    const all = buildInsights(s, now);
    const key = all[0]!.key;
    const r = applyInsightFeedback(all, [{ key, action: "rimandato", until: "2026-10-13T08:00:00Z" }], now);
    expect(r.active.map((i) => i.key)).not.toContain(key);
    expect(r.hidden).toHaveLength(1);
    const later = applyInsightFeedback(all, [{ key, action: "rimandato", until: "2026-10-13T08:00:00Z" }], new Date("2026-10-14T00:00:00Z"));
    expect(later.active).toHaveLength(all.length);
  });
  it("topInsights restituisce al massimo 3 suggerimenti, i più gravi", () => {
    const top = topInsights({ ...s, feedback: [] }, 3, now);
    expect(top).toHaveLength(3);
    expect(top[0]!.severity).toBe("alta");
  });
  it("nessun dato: nessun suggerimento (mai inventati)", () => {
    expect(buildInsights(signals({ labels: null }), now)).toEqual([]);
  });
  it("normalizeSignals converte i numeric e tollera blocchi mancanti", () => {
    const n = normalizeSignals({ today: "2026-10-12", finance: false, stock: [{ product_id: "p", name: "X", unit: "kg", on_hand: "1.5", daily_use: "0.5", incoming: null, supplier: null }], price_increases: null });
    expect(n.stock[0]).toMatchObject({ on_hand: 1.5, daily_use: 0.5, incoming: 0 });
    expect(n.price_increases).toBeNull();
    expect(n.waste).toEqual([]);
    expect(n.ticket_target_minutes).toBe(15);
  });
});

describe("pianificatore preparazioni", () => {
  const menu = [
    { id: "a", name: "Spaghetti", recipe: [{ product_id: "pasta", qty_per_portion: 100 }, { product_id: "pomodoro", qty_per_portion: 80 }] },
    { id: "b", name: "Frittura", recipe: [{ product_id: "calamari", qty_per_portion: 150 }] },
    { id: "c", name: "Mai venduto", recipe: [] },
  ];
  const products = [
    { id: "pasta", name: "Pasta", unit: "g", on_hand: 5000 },
    { id: "pomodoro", name: "Pomodoro", unit: "g", on_hand: 1000 },
    { id: "calamari", name: "Calamari", unit: "g", on_hand: 0 },
  ];
  const history: PrepHistoryDay[] = [
    { date: "2026-10-10", orders: 20, covers: 50, items: { a: 30, b: 10 } },
    { date: "2026-10-03", orders: 18, covers: 40, items: { a: 20, b: 14 } },
    { date: "2026-09-26", orders: 0, covers: 0, items: {} }, // chiuso: escluso
    { date: "2026-09-19", orders: 22, covers: 60, items: { a: 25 } },
  ];

  it("baseline = media degli stessi giorni con attività; meteo moltiplica", () => {
    const p = prepPlan({ history, menu, products, bookedCovers: null, weatherFactor: 1.1 });
    expect(p.weeksWithData).toBe(3);
    expect(p.confidence).toBe("media");
    expect(p.avgCovers).toBe(50);
    const a = p.items.find((i) => i.id === "a")!;
    expect(a.baseline).toBe(25);
    expect(a.portions).toBe(28); // ⌈25 × 1,1⌉ = ⌈27,5⌉
    expect(a).toMatchObject({ min: 20, max: 30 });
    const b = p.items.find((i) => i.id === "b")!;
    expect(b.baseline).toBe(8); // (10 + 14 + 0) / 3
    expect(p.items.find((i) => i.id === "c")).toBeUndefined();
  });

  it("prenotati oltre la media alzano la stima, sotto la media no", () => {
    const up = prepPlan({ history, menu, products, bookedCovers: 75, weatherFactor: 1 });
    expect(up.coversFactor).toBe(1.5);
    expect(up.items.find((i) => i.id === "a")!.portions).toBe(38); // ⌈25 × 1,5⌉
    const low = prepPlan({ history, menu, products, bookedCovers: 10, weatherFactor: 1 });
    expect(low.coversFactor).toBe(1);
  });

  it("ingredienti: fabbisogno contro giacenza, mancanti in cima", () => {
    const p = prepPlan({ history, menu, products, bookedCovers: null, weatherFactor: 1 });
    // spaghetti 25 porzioni, frittura 8
    expect(p.ingredients[0]!.product_id).toBe("calamari");
    expect(p.ingredients.find((x) => x.product_id === "calamari")).toMatchObject({ need: 1200, missing: 1200 });
    expect(p.ingredients.find((x) => x.product_id === "pasta")).toMatchObject({ need: 2500, missing: 0 });
    expect(p.ingredients.find((x) => x.product_id === "pomodoro")).toMatchObject({ need: 2000, missing: 1000 });
  });

  it("nessuno storico: nessuna porzione, confidenza nessuna", () => {
    const p = prepPlan({ history: [], menu, products, bookedCovers: 40, weatherFactor: 1 });
    expect(p.items).toEqual([]);
    expect(p.confidence).toBe("nessuna");
  });

  it("confidenza per settimane di dati", () => {
    expect([0, 1, 2, 3, 4, 8].map(prepConfidence)).toEqual(["nessuna", "bassa", "media", "media", "alta", "alta"]);
  });
});
