"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { generateGrid, nextProgressive, validateGrid, BEACH_PERIOD_KEYS } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { can, getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida");
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const money = (msg: string) => z.coerce.number({ message: msg }).finite(msg).min(0, msg);
const optMoney = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? null : Number(v.replace(",", "."))))
  .refine((v) => v == null || (Number.isFinite(v) && v >= 0), "Importo non valido");
const kindEnum = z.enum(["ombrellone", "lettino", "cabina", "gazebo"]);
const periodEnum = z.enum(BEACH_PERIOD_KEYS as [string, ...string[]]);
const methodEnum = z.enum(["contanti", "carta", "bonifico", "altro"]);

const BASE = "/servizio/spiaggia";
function refresh() {
  revalidatePath(BASE, "layout");
}

// ---------------------------------------------------------------------------
// Mappa
// ---------------------------------------------------------------------------
const gridSchema = z.object({
  kind: kindEnum,
  zone: z.string().trim().min(1, "Indica il nome del settore").max(40),
  row_from: z.coerce.number().int().min(1, "File non valide").max(99),
  row_to: z.coerce.number().int().min(1, "File non valide").max(99),
  per_row: z.coerce.number().int().min(1, "Elementi per fila non validi").max(100, "Massimo 100 per fila"),
  seats: z.coerce.number().int().min(0).max(20),
  numbering: z.enum(["progressivo", "per_fila"]),
  prefix: z.string().trim().max(6).optional().default(""),
});

export async function createGrid(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = gridSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const spec = {
    kind: d.kind,
    zone: d.zone,
    rowFrom: d.row_from,
    rowTo: d.row_to,
    perRow: d.per_row,
    seats: d.seats,
    numbering: d.numbering,
    prefix: d.prefix,
  } as const;
  const invalid = validateGrid(spec);
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  const { data: existing, error: exErr } = await supabase.from("service_points").select("label").eq("facility_id", ctx.facility.id).eq("kind", d.kind);
  if (exErr) return { error: humanError(exErr) };
  const labels = (existing ?? []).map((e) => e.label as string);
  const startNumber = d.numbering === "progressivo" ? nextProgressive(labels, d.prefix) : 1;
  const { points, duplicates } = generateGrid({ ...spec, startNumber }, labels);
  if (points.length === 0) return { error: "Tutte queste etichette esistono già." };

  const { error } = await supabase.from("service_points").insert(points.map((p) => ({ ...p, org_id: ctx.org.id, facility_id: ctx.facility.id })));
  if (error) return { error: humanError(error) };
  refresh();
  return {
    ok: true,
    message: `Creati ${points.length} elementi nel settore ${d.zone}` + (duplicates.length ? ` (saltate ${duplicates.length} etichette già esistenti).` : "."),
  };
}

const pointSchema = z.object({
  id: uuid,
  label: z.string().trim().min(1, "Etichetta obbligatoria").max(40),
  zone: z.string().trim().min(1, "Indica il settore").max(40),
  row_label: optText(20),
  seats: z.coerce.number().int().min(0).max(20),
  pos_x: z.coerce.number().min(0).max(999),
});

export async function updatePoint(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = pointSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { id, ...rest } = parsed.data;
  const posY = rest.row_label && /^\d+$/.test(rest.row_label) ? Number(rest.row_label) : null;
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_points")
    .update({ ...rest, ...(posY != null ? { pos_y: posY } : {}), active: data.get("active") === "on" })
    .eq("id", id);
  if (error) return { error: error.code === "23505" ? "Esiste già un elemento con questa etichetta." : humanError(error) };
  refresh();
  return { ok: true, message: "Salvato." };
}

const renameZoneSchema = z.object({ from: z.string().trim().min(1), to: z.string().trim().min(1, "Nuovo nome obbligatorio").max(40) });

export async function renameZone(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = renameZoneSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase
    .from("service_points")
    .update({ zone: parsed.data.to })
    .eq("facility_id", ctx.facility.id)
    .in("kind", ["ombrellone", "lettino", "cabina", "gazebo"])
    .eq("zone", parsed.data.from);
  if (error) return { error: humanError(error) };
  await supabase.from("beach_rates").update({ zone: parsed.data.to }).eq("facility_id", ctx.facility.id).eq("zone", parsed.data.from);
  refresh();
  return { ok: true, message: `Settore rinominato in ${parsed.data.to}.` };
}

const zoneActiveSchema = z.object({ zone: z.string().trim().min(1), row_label: optText(20), active: z.enum(["0", "1"]) });

/** Attiva o disattiva un intero settore o una fila (le prenotazioni esistenti restano). */
export async function setZoneActive(data: FormData) {
  const ctx = await getContext();
  const parsed = zoneActiveSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return;
  const supabase = await createClient();
  let q = supabase
    .from("service_points")
    .update({ active: parsed.data.active === "1" })
    .eq("facility_id", ctx.facility.id)
    .in("kind", ["ombrellone", "lettino", "cabina", "gazebo"])
    .eq("zone", parsed.data.zone);
  if (parsed.data.row_label) q = q.eq("row_label", parsed.data.row_label);
  await q;
  refresh();
}

// ---------------------------------------------------------------------------
// Listino
// ---------------------------------------------------------------------------
const rateSchema = z.object({
  name: optText(80),
  kind: kindEnum,
  zone: optText(40),
  row_label: optText(20),
  period: periodEnum,
  valid_from: isoDate,
  valid_to: isoDate,
  price: money("Prezzo non valido"),
  included_lettini: z.coerce.number().int().min(0).max(20),
  extra_lettino_price: money("Prezzo lettino extra non valido"),
});

export async function createRate(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = rateSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (d.valid_to < d.valid_from) return { error: "La fine validità è precedente all'inizio" };
  if (d.row_label && !d.zone) return { error: "Per una tariffa di fila indica anche il settore" };
  const supabase = await createClient();
  const { error } = await supabase.from("beach_rates").insert({ ...d, org_id: ctx.org.id, facility_id: ctx.facility.id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Tariffa aggiunta." };
}

export async function updateRatePrice(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = z
    .object({ id: uuid, price: money("Prezzo non valido"), extra_lettino_price: money("Prezzo lettino extra non valido") })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("beach_rates").update({ price: parsed.data.price, extra_lettino_price: parsed.data.extra_lettino_price }).eq("id", parsed.data.id);
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Aggiornata." };
}

export async function toggleRate(data: FormData) {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.from("beach_rates").update({ active: data.get("active") === "1" }).eq("id", id.data);
  refresh();
}

// ---------------------------------------------------------------------------
// Prenotazioni
// ---------------------------------------------------------------------------
const bookSchema = z.object({
  point_id: uuid,
  period: periodEnum,
  start_date: isoDate,
  end_date: isoDate.optional().or(z.literal("")).transform((v) => v || null),
  customer_name: z.string().trim().min(1, "Inserisci il nome del cliente").max(120),
  customer_phone: optText(40),
  customer_email: z.union([z.literal(""), z.string().trim().email("Email non valida")]).optional().transform((v) => v || null),
  notes: optText(1000),
  lettini: z.coerce.number().int().min(0, "Lettini non validi").max(20, "Lettini non validi"),
  price: optMoney,
  price_reason: optText(300),
  paid: optMoney,
  method: methodEnum.default("contanti"),
  checkin: z.literal("1").optional(),
  back: z.string().optional(),
});

export async function createBooking(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = bookSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("beach_book", {
    p_point: d.point_id,
    p_period: d.period,
    p_start: d.start_date,
    p_end: d.end_date ?? d.start_date,
    p_customer_name: d.customer_name,
    p_customer_phone: d.customer_phone,
    p_customer_email: d.customer_email,
    p_notes: d.notes,
    p_lettini: d.lettini,
    p_price: can(ctx, "beach.manage") ? d.price : null,
    p_price_reason: d.price_reason,
    p_paid: d.paid ?? 0,
    p_payment_method: d.method,
    p_checkin: d.checkin === "1",
  });
  if (error) return { error: humanError(error) };
  refresh();
  if (d.back === "mappa") redirect(`${BASE}?data=${d.start_date}&p=${d.point_id}`);
  redirect(`${BASE}/prenotazioni/${id as string}?nuova=1`);
}

async function bookingRpc(fn: string, args: Record<string, unknown>): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true };
}

const idOnly = z.object({ booking_id: uuid });

export async function checkIn(_: ActionState, data: FormData): Promise<ActionState> {
  const p = idOnly.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Prenotazione non valida" };
  const r = await bookingRpc("beach_checkin", { p_booking: p.data.booking_id });
  return r.error ? r : { ok: true, message: "Check-in fatto." };
}

export async function checkOut(_: ActionState, data: FormData): Promise<ActionState> {
  const p = idOnly.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Prenotazione non valida" };
  const r = await bookingRpc("beach_checkout", { p_booking: p.data.booking_id });
  return r.error ? r : { ok: true, message: "Uscita registrata." };
}

export async function markNoShow(_: ActionState, data: FormData): Promise<ActionState> {
  const p = idOnly.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Prenotazione non valida" };
  const r = await bookingRpc("beach_no_show", { p_booking: p.data.booking_id });
  return r.error ? r : { ok: true, message: "Segnato come non presentato." };
}

export async function moveBooking(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ booking_id: uuid, to_point: uuid, note: optText(300), date: isoDate.optional() }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Scegli la nuova postazione" };
  const r = await bookingRpc("beach_move", { p_booking: p.data.booking_id, p_to_point: p.data.to_point, p_note: p.data.note });
  if (r.error) return r;
  if (p.data.date) redirect(`${BASE}?data=${p.data.date}&p=${p.data.to_point}`);
  return { ok: true, message: "Postazione cambiata." };
}

export async function addPayment(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z
    .object({ booking_id: uuid, amount: z.coerce.number({ message: "Importo non valido" }).finite("Importo non valido"), method: methodEnum, refund: z.literal("1").optional() })
    .safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  if (p.data.amount <= 0) return { error: "Importo non valido" };
  const amount = p.data.refund ? -p.data.amount : p.data.amount;
  const r = await bookingRpc("beach_add_payment", { p_booking: p.data.booking_id, p_amount: amount, p_method: p.data.method });
  return r.error ? r : { ok: true, message: p.data.refund ? "Rimborso registrato." : "Incasso registrato." };
}

export async function setPrice(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ booking_id: uuid, price: money("Prezzo non valido"), reason: z.string().trim().min(1, "Indica il motivo").max(300) }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const r = await bookingRpc("beach_set_price", { p_booking: p.data.booking_id, p_price: p.data.price, p_reason: p.data.reason });
  return r.error ? r : { ok: true, message: "Prezzo aggiornato." };
}

export async function cancelBooking(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ booking_id: uuid, reason: optText(300) }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Prenotazione non valida" };
  const r = await bookingRpc("beach_cancel", { p_booking: p.data.booking_id, p_reason: p.data.reason });
  return r.error ? r : { ok: true, message: "Prenotazione annullata." };
}

export async function updateCustomer(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z
    .object({
      booking_id: uuid,
      customer_name: z.string().trim().min(1, "Inserisci il nome del cliente").max(120),
      customer_phone: optText(40),
      customer_email: z.union([z.literal(""), z.string().trim().email("Email non valida")]).optional().transform((v) => v || null),
      notes: optText(1000),
    })
    .safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  const r = await bookingRpc("beach_update_customer", { p_booking: d.booking_id, p_name: d.customer_name, p_phone: d.customer_phone, p_email: d.customer_email, p_notes: d.notes });
  return r.error ? r : { ok: true, message: "Dati cliente aggiornati." };
}

// ---------------------------------------------------------------------------
// Manutenzione
// ---------------------------------------------------------------------------
export async function setOutOfService(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ point_id: uuid, out: z.enum(["0", "1"]), note: optText(300) }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Dati non validi" };
  const r = await bookingRpc("beach_set_out_of_service", { p_point: p.data.point_id, p_out: p.data.out === "1", p_note: p.data.note });
  return r.error ? r : { ok: true, message: p.data.out === "1" ? "Segnata fuori servizio." : "Di nuovo in servizio." };
}
