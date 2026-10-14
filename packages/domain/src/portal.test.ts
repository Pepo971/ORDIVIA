import { describe, expect, it } from "vitest";
import {
  PORTAL_LIMITS,
  accentOf,
  addToCart,
  allergenLabel,
  cartIssueText,
  cartTotals,
  isWithinOrderingHours,
  parseHhmm,
  parseLang,
  pickLang,
  pointKindLabel,
  portalText,
  sanitizeCart,
  setCartQty,
  telLink,
  validateCart,
  whatsappLink,
  whatsappNumber,
  type CartMenuItem,
} from "./portal";

const menu: CartMenuItem[] = [
  { id: "pan", name: "Panino caprese", price: 7.5, sold_out: false },
  { id: "acq", name: "Acqua", price: 1.5, sold_out: false },
  { id: "gra", name: "Granita", price: 3, sold_out: true },
  { id: "spr", name: "Spritz", price: 0.1, sold_out: false },
];

describe("carrello", () => {
  it("aggiunge e somma la stessa voce", () => {
    let c = addToCart([], "pan");
    c = addToCart(c, "pan", 2);
    c = addToCart(c, "acq");
    expect(c).toEqual([
      { menu_item_id: "pan", qty: 3 },
      { menu_item_id: "acq", qty: 1 },
    ]);
  });

  it("non supera la quantità massima per riga", () => {
    const c = addToCart([{ menu_item_id: "pan", qty: 19 }], "pan", 5);
    expect(c[0]!.qty).toBe(PORTAL_LIMITS.maxQty);
  });

  it("non supera il numero massimo di righe", () => {
    const full = Array.from({ length: PORTAL_LIMITS.maxLines }, (_, i) => ({ menu_item_id: `x${i}`, qty: 1 }));
    expect(addToCart(full, "nuovo")).toHaveLength(PORTAL_LIMITS.maxLines);
  });

  it("quantità a zero rimuove la riga", () => {
    const c = setCartQty([{ menu_item_id: "pan", qty: 2 }, { menu_item_id: "acq", qty: 1 }], 0, 0);
    expect(c).toEqual([{ menu_item_id: "acq", qty: 1 }]);
    expect(setCartQty(c, 0, 50)[0]!.qty).toBe(20);
  });

  it("totali in centesimi senza errori di virgola mobile", () => {
    const t = cartTotals(
      [
        { menu_item_id: "pan", qty: 2 },
        { menu_item_id: "acq", qty: 2 },
        { menu_item_id: "spr", qty: 3 },
        { menu_item_id: "sconosciuto", qty: 1 },
      ],
      menu,
    );
    expect(t.totalCents).toBe(1830);
    expect(t.total).toBe(18.3);
    expect(t.pieces).toBe(7);
    expect(t.lines).toBe(3);
  });

  it("validazione come nel database", () => {
    expect(validateCart([], menu)).toEqual([{ code: "empty" }]);
    expect(validateCart([{ menu_item_id: "pan", qty: 2 }], menu)).toEqual([]);
    const issues = validateCart(
      [
        { menu_item_id: "gra", qty: 1 },
        { menu_item_id: "pan", qty: 21 },
        { menu_item_id: "boh", qty: 1 },
        { menu_item_id: "acq", qty: 1, notes: "x".repeat(201) },
      ],
      menu,
    );
    expect(issues.map((i) => i.code)).toEqual(["sold_out", "bad_qty", "unknown_item", "note_too_long"]);
    const many = Array.from({ length: 31 }, () => ({ menu_item_id: "acq", qty: 1 }));
    expect(validateCart(many, menu)[0]).toEqual({ code: "too_many_lines", max: 30 });
  });

  it("carrello salvato nel browser: scarta righe malformate, esaurite o sconosciute", () => {
    const raw = [
      { menu_item_id: "pan", qty: "3" },
      { menu_item_id: "gra", qty: 1 },
      { menu_item_id: "boh", qty: 1 },
      { menu_item_id: "acq", qty: 99, notes: "  fredda  " },
      { menu_item_id: "acq", qty: -1 },
      null,
      "ciao",
    ];
    expect(sanitizeCart(raw, menu)).toEqual([
      { menu_item_id: "pan", qty: 3 },
      { menu_item_id: "acq", qty: 20, notes: "fredda" },
    ]);
    expect(sanitizeCart("non un array", menu)).toEqual([]);
  });

  it("messaggi dei problemi nelle due lingue", () => {
    expect(cartIssueText("it", { code: "sold_out", itemId: "gra", name: "Granita" })).toBe("«Granita» è esaurito.");
    expect(cartIssueText("en", { code: "sold_out", itemId: "gra", name: "Granita" })).toBe("«Granita» is sold out.");
  });
});

describe("orari d'ordine nel fuso della struttura", () => {
  it("legge HH:MM e HH:MM:SS", () => {
    expect(parseHhmm("09:30")).toBe(570);
    expect(parseHhmm("23:59:00")).toBe(1439);
    expect(parseHhmm("24:00")).toBeNull();
    expect(parseHhmm("")).toBeNull();
  });

  it("senza fascia è sempre aperto", () => {
    expect(isWithinOrderingHours(null, null, "Europe/Rome")).toBe(true);
  });

  it("usa l'ora locale con l'ora legale (estate UTC+2)", () => {
    // 07:30 UTC = 09:30 a Roma in luglio
    expect(isWithinOrderingHours("10:00", "18:00", "Europe/Rome", new Date("2026-07-01T07:30:00Z"))).toBe(false);
    expect(isWithinOrderingHours("10:00", "18:00", "Europe/Rome", new Date("2026-07-01T08:30:00Z"))).toBe(true);
    // 16:00 UTC = 18:00: estremo finale escluso
    expect(isWithinOrderingHours("10:00", "18:00", "Europe/Rome", new Date("2026-07-01T16:00:00Z"))).toBe(false);
  });

  it("usa l'ora solare in inverno (UTC+1)", () => {
    expect(isWithinOrderingHours("10:00", "18:00", "Europe/Rome", new Date("2026-01-15T08:30:00Z"))).toBe(false);
    expect(isWithinOrderingHours("10:00", "18:00", "Europe/Rome", new Date("2026-01-15T09:30:00Z"))).toBe(true);
  });

  it("fascia a cavallo della mezzanotte", () => {
    expect(isWithinOrderingHours("22:00", "02:00", "Europe/Rome", new Date("2026-07-01T21:30:00Z"))).toBe(true); // 23:30
    expect(isWithinOrderingHours("22:00", "02:00", "Europe/Rome", new Date("2026-07-01T23:59:00Z"))).toBe(true); // 01:59
    expect(isWithinOrderingHours("22:00", "02:00", "Europe/Rome", new Date("2026-07-02T00:00:00Z"))).toBe(false); // 02:00
    expect(isWithinOrderingHours("22:00", "02:00", "Europe/Rome", new Date("2026-07-01T10:00:00Z"))).toBe(false); // 12:00
  });
});

describe("contatti", () => {
  it("numeri WhatsApp con prefisso", () => {
    expect(whatsappNumber("+39 333 123 4567")).toBe("393331234567");
    expect(whatsappNumber("333 1234567")).toBe("393331234567");
    expect(whatsappNumber("0039 333 1234567")).toBe("393331234567");
    expect(whatsappNumber("+44 7700 900123")).toBe("447700900123");
    expect(whatsappNumber("abc")).toBeNull();
    expect(whatsappLink("333 1234567", "Ciao, vorrei prenotare")).toBe("https://wa.me/393331234567?text=Ciao%2C%20vorrei%20prenotare");
  });

  it("link telefonici", () => {
    expect(telLink("+39 0541 123456")).toBe("tel:+390541123456");
    expect(telLink("12")).toBeNull();
    expect(telLink(null)).toBeNull();
  });
});

describe("lingua e testi", () => {
  it("ripiego sull'italiano", () => {
    expect(pickLang("en", "Benvenuti", "Welcome")).toBe("Welcome");
    expect(pickLang("en", "Benvenuti", "  ")).toBe("Benvenuti");
    expect(pickLang("it", null, "Welcome")).toBe("Welcome");
    expect(pickLang("it", null, null)).toBe("");
  });

  it("lingua sconosciuta = italiano", () => {
    expect(parseLang("en")).toBe("en");
    expect(parseLang("fr")).toBe("it");
    expect(parseLang(undefined)).toBe("it");
  });

  it("dizionari con le stesse chiavi", () => {
    expect(Object.keys(portalText("en")).sort()).toEqual(Object.keys(portalText("it")).sort());
    expect(portalText("en").orderHours("10:00", "18:00")).toBe("QR ordering from 10:00 to 18:00.");
  });

  it("etichette di punti e allergeni", () => {
    expect(pointKindLabel("en", "ombrellone")).toBe("Umbrella");
    expect(pointKindLabel("it", "camera")).toBe("Camera");
    expect(allergenLabel("en", "frutta_a_guscio")).toBe("Tree nuts");
    expect(allergenLabel("it", "latte")).toBe("Latte");
  });

  it("colore di marca solo dalla palette", () => {
    expect(accentOf("corallo").hex).toBe("#b4401b");
    expect(accentOf("#ff00ff").hex).toBe(accentOf("turchese").hex);
    expect(accentOf(null).hex).toBe("#0c7d72");
  });
});
