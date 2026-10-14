"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { PORTAL_LIMITS, REQUEST_CATEGORIES, parseLang } from "@ordivia/domain";
import type { ActionState } from "@/lib/action-state";
import { TOKEN_RE, publicClient } from "@/lib/portal-queries";

// Azioni pubbliche del portale QR: nessuna sessione, solo funzioni public_portal_* con la chiave anonima.
// Il database ricontrolla tutto (token, orari, tipi di punto, disponibilità, limiti, frequenza).

function guestError(e: { code?: string; message?: string } | null, lang: "it" | "en"): string {
  const generic = lang === "en" ? "Something went wrong. Please try again or ask the staff." : "Qualcosa non ha funzionato. Riprova o chiedi al personale.";
  if (!e) return generic;
  // Messaggi scritti per l'ospite nelle funzioni public_portal_* (in italiano, il personale li capisce comunque).
  if (["P0001", "P0002", "22023"].includes(e.code ?? "") && e.message) {
    if (lang === "en") {
      if (e.message.includes("esaurito")) return e.message.replace("è esaurito", "is sold out");
      if (e.message.startsWith("Troppe richieste")) return "Too many requests from this QR: please try again in a few minutes or ask the staff.";
      if (e.message.startsWith("Gli ordini dal QR sono aperti")) return e.message.replace("Gli ordini dal QR sono aperti dalle", "QR ordering is open from").replace(" alle ", " to ");
      if (e.message.startsWith("Codice QR non valido")) return "This QR code is not valid.";
      if (e.message.includes("chiedi al personale")) return "This is not available from this QR: please ask the staff.";
    }
    return e.message;
  }
  return generic;
}

const lineSchema = z.object({
  menu_item_id: z.string().uuid(),
  qty: z.number().int().min(1).max(PORTAL_LIMITS.maxQty),
  notes: z.string().trim().max(PORTAL_LIMITS.maxLineNote).optional(),
});

const orderSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  lines: z.array(lineSchema).min(1).max(PORTAL_LIMITS.maxLines),
  guest_name: z.string().trim().max(PORTAL_LIMITS.maxGuestName).optional(),
  notes: z.string().trim().max(PORTAL_LIMITS.maxNotes).optional(),
  allergies: z.string().trim().max(PORTAL_LIMITS.maxAllergies).optional(),
});

export async function placeOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const lang = parseLang(data.get("lang"));
  let lines: unknown;
  try {
    lines = JSON.parse(String(data.get("lines") ?? "[]"));
  } catch {
    lines = [];
  }
  const parsed = orderSchema.safeParse({
    token: data.get("token"),
    lines,
    guest_name: data.get("guest_name") ?? undefined,
    notes: data.get("notes") ?? undefined,
    allergies: data.get("allergies") ?? undefined,
  });
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    const msg =
      path === "lines"
        ? lang === "en" ? "Check your cart: 1–30 lines, quantities 1–20." : "Controlla il carrello: da 1 a 30 righe, quantità da 1 a 20."
        : path === "token"
          ? lang === "en" ? "This QR code is not valid." : "Codice QR non valido."
          : lang === "en" ? "Some fields are too long." : "Alcuni campi sono troppo lunghi.";
    return { error: msg };
  }
  const p = parsed.data;
  const { data: res, error } = await publicClient().rpc("public_portal_place_order", {
    p_token: p.token,
    p_lines: p.lines.map((l) => ({ menu_item_id: l.menu_item_id, qty: l.qty, ...(l.notes ? { notes: l.notes } : {}) })),
    p_guest_name: p.guest_name || null,
    p_notes: p.notes || null,
    p_allergies: p.allergies || null,
    p_lang: lang,
  });
  if (error) return { error: guestError(error, lang) };
  const ref = (res as { reference?: string } | null)?.reference;
  if (!ref) return { error: guestError(null, lang) };
  redirect(`/p/${p.token}/ordine/${ref}?lang=${lang}`);
}

const requestSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  category: z.enum(REQUEST_CATEGORIES),
  message: z.string().trim().min(PORTAL_LIMITS.minMessage).max(PORTAL_LIMITS.maxMessage),
  guest_name: z.string().trim().max(PORTAL_LIMITS.maxGuestName).optional(),
  contact: z.string().trim().max(PORTAL_LIMITS.maxContact).optional(),
});

export async function sendRequest(_: ActionState, data: FormData): Promise<ActionState> {
  const lang = parseLang(data.get("lang"));
  const parsed = requestSchema.safeParse({
    token: data.get("token"),
    category: data.get("category"),
    message: data.get("message"),
    guest_name: data.get("guest_name") ?? undefined,
    contact: data.get("contact") ?? undefined,
  });
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    return {
      error:
        path === "message"
          ? lang === "en" ? `Write a message (${PORTAL_LIMITS.minMessage}–${PORTAL_LIMITS.maxMessage} characters).` : `Scrivi un messaggio (da ${PORTAL_LIMITS.minMessage} a ${PORTAL_LIMITS.maxMessage} caratteri).`
          : lang === "en" ? "Please check the form." : "Controlla i campi del modulo.",
    };
  }
  const p = parsed.data;
  const { error } = await publicClient().rpc("public_portal_request", {
    p_token: p.token,
    p_category: p.category,
    p_message: p.message,
    p_guest_name: p.guest_name || null,
    p_contact: p.contact || null,
  });
  if (error) return { error: guestError(error, lang) };
  return { ok: true, message: lang === "en" ? "Request sent: we will be with you shortly." : "Richiesta inviata: arriviamo appena possibile." };
}
