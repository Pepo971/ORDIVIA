"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PORTAL_ACCENT_KEYS, PORTAL_ORDER_KINDS } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { can, getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const opt = (max: number, msg: string) =>
  z
    .string()
    .trim()
    .max(max, msg)
    .optional()
    .transform((v) => (v ? v : null));
const httpsUrl = (msg: string) =>
  z
    .string()
    .trim()
    .max(500, msg)
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v == null || /^https:\/\/[^\s"'<>]+$/.test(v), msg);
const phone = (msg: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v == null || /^\+?[0-9 ./-]{5,20}$/.test(v), msg);
const time = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v == null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "Orario non valido");
const bool = (data: FormData, k: string) => data.get(k) === "on" || data.get(k) === "1";

function revalidate() {
  revalidatePath("/ospiti/portale", "layout");
  revalidatePath("/p", "layout");
}

async function managerCtx() {
  const ctx = await getContext();
  if (!can(ctx, "portal.manage")) return null;
  return ctx;
}

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------
const settingsSchema = z
  .object({
    display_name: opt(80, "Nome: massimo 80 caratteri"),
    welcome_it: opt(400, "Benvenuto (IT): massimo 400 caratteri"),
    welcome_en: opt(400, "Benvenuto (EN): massimo 400 caratteri"),
    accent: z.enum(PORTAL_ACCENT_KEYS as [string, ...string[]], { message: "Colore non valido" }),
    cover_url: httpsUrl("L'immagine di copertina deve essere un indirizzo https://"),
    hours_it: opt(300, "Orari (IT): massimo 300 caratteri"),
    hours_en: opt(300, "Orari (EN): massimo 300 caratteri"),
    phone: phone("Telefono non valido"),
    whatsapp: phone("Numero WhatsApp non valido"),
    email: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((v) => (v ? v : null))
      .refine((v) => v == null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), "Email non valida"),
    address: opt(200, "Indirizzo: massimo 200 caratteri"),
    map_url: httpsUrl("Il link alla mappa deve essere un indirizzo https://"),
    order_from: time,
    order_to: time,
  })
  .refine((v) => (v.order_from == null) === (v.order_to == null), { message: "Indica entrambi gli orari degli ordini oppure nessuno" })
  .refine((v) => v.order_from == null || v.order_from !== v.order_to, { message: "Inizio e fine degli ordini non possono coincidere" });

export async function saveSettings(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await managerCtx();
  if (!ctx) return { error: "Non hai i permessi per questa operazione." };
  const parsed = settingsSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const kinds = data.getAll("order_kinds").map(String).filter((k) => (PORTAL_ORDER_KINDS as readonly string[]).includes(k));
  const supabase = await createClient();
  const { error } = await supabase.from("portal_settings").upsert(
    {
      org_id: ctx.org.id,
      facility_id: ctx.facility.id,
      ...parsed.data,
      enabled: bool(data, "enabled"),
      show_menu: bool(data, "show_menu"),
      show_order: bool(data, "show_order"),
      show_booking: bool(data, "show_booking"),
      show_assistance: bool(data, "show_assistance"),
      show_offers: bool(data, "show_offers"),
      show_info: bool(data, "show_info"),
      order_kinds: kinds,
    },
    { onConflict: "facility_id" },
  );
  if (error) return { error: humanError(error) };
  revalidate();
  return { ok: true, message: "Portale salvato." };
}

// ---------------------------------------------------------------------------
// Offerte e pacchetti
// ---------------------------------------------------------------------------
const date = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Data non valida");

const offerSchema = z
  .object({
    id: uuid.optional().or(z.literal("").transform(() => undefined)),
    title_it: z.string().trim().min(1, "Indica il titolo").max(100, "Titolo: massimo 100 caratteri"),
    title_en: opt(100, "Titolo (EN): massimo 100 caratteri"),
    description_it: opt(600, "Descrizione: massimo 600 caratteri"),
    description_en: opt(600, "Descrizione (EN): massimo 600 caratteri"),
    price: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? Number(v.replace(",", ".")) : null))
      .refine((v) => v == null || (Number.isFinite(v) && v >= 0 && v < 100000), "Prezzo non valido"),
    valid_from: date,
    valid_to: date,
    sort: z.coerce.number().int().min(-1000).max(1000).catch(0),
  })
  .refine((v) => !v.valid_from || !v.valid_to || v.valid_from <= v.valid_to, { message: "La fine validità è prima dell'inizio" });

export async function saveOffer(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await managerCtx();
  if (!ctx) return { error: "Non hai i permessi per questa operazione." };
  const parsed = offerSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { id, ...row } = parsed.data;
  const supabase = await createClient();
  const payload = { ...row, active: bool(data, "active") };
  const { error } = id
    ? await supabase.from("portal_offers").update(payload).eq("id", id).eq("facility_id", ctx.facility.id)
    : await supabase.from("portal_offers").insert({ ...payload, org_id: ctx.org.id, facility_id: ctx.facility.id });
  if (error) return { error: humanError(error) };
  revalidate();
  return { ok: true, message: id ? "Offerta aggiornata." : "Offerta aggiunta." };
}

export async function deleteOffer(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await managerCtx();
  if (!ctx) return { error: "Non hai i permessi per questa operazione." };
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Offerta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.from("portal_offers").delete().eq("id", id.data).eq("facility_id", ctx.facility.id);
  if (error) return { error: humanError(error) };
  revalidate();
  return { ok: true, message: "Offerta eliminata." };
}

// ---------------------------------------------------------------------------
// Blocchi informativi
// ---------------------------------------------------------------------------
const infoSchema = z.object({
  id: uuid.optional().or(z.literal("").transform(() => undefined)),
  title_it: z.string().trim().min(1, "Indica il titolo").max(100, "Titolo: massimo 100 caratteri"),
  title_en: opt(100, "Titolo (EN): massimo 100 caratteri"),
  body_it: z.string().trim().min(1, "Scrivi il testo").max(2000, "Testo: massimo 2000 caratteri"),
  body_en: opt(2000, "Testo (EN): massimo 2000 caratteri"),
  sort: z.coerce.number().int().min(-1000).max(1000).catch(0),
});

export async function saveInfo(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await managerCtx();
  if (!ctx) return { error: "Non hai i permessi per questa operazione." };
  const parsed = infoSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { id, ...row } = parsed.data;
  const supabase = await createClient();
  const payload = { ...row, active: bool(data, "active") };
  const { error } = id
    ? await supabase.from("portal_info_blocks").update(payload).eq("id", id).eq("facility_id", ctx.facility.id)
    : await supabase.from("portal_info_blocks").insert({ ...payload, org_id: ctx.org.id, facility_id: ctx.facility.id });
  if (error) return { error: humanError(error) };
  revalidate();
  return { ok: true, message: id ? "Informazione aggiornata." : "Informazione aggiunta." };
}

export async function deleteInfo(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await managerCtx();
  if (!ctx) return { error: "Non hai i permessi per questa operazione." };
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Elemento non valido" };
  const supabase = await createClient();
  const { error } = await supabase.from("portal_info_blocks").delete().eq("id", id.data).eq("facility_id", ctx.facility.id);
  if (error) return { error: humanError(error) };
  revalidate();
  return { ok: true, message: "Informazione eliminata." };
}

// ---------------------------------------------------------------------------
// Ordini dal portale: accetta / rifiuta (pos.operate, ricontrollato nel database)
// ---------------------------------------------------------------------------
export async function acceptSubmission(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Ordine non valido" };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("portal_accept_submission", { p_submission: id.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/ospiti/portale/ordini");
  revalidatePath("/servizio", "layout");
  return { ok: true, message: `Ordine accettato: ${n} ${Number(n) === 1 ? "riga inviata" : "righe inviate"} in produzione.` };
}

const rejectSchema = z.object({
  id: uuid,
  reason: z.string().trim().min(3, "Indica il motivo del rifiuto").max(300, "Motivo: massimo 300 caratteri"),
});

export async function rejectSubmission(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = rejectSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_reject_submission", { p_submission: parsed.data.id, p_reason: parsed.data.reason });
  if (error) return { error: humanError(error) };
  revalidatePath("/ospiti/portale/ordini");
  revalidatePath("/servizio", "layout");
  return { ok: true, message: "Ordine rifiutato: le porzioni sono tornate disponibili." };
}
