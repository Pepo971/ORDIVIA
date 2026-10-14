"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseRoomBlocks, parseStaysCsv } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid("Elemento non valido");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida");
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const optUuid = z
  .string()
  .optional()
  .transform((v) => v || null)
  .pipe(uuid.nullable());
const optInt = (min: number, max: number, msg: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? null : Number(v)))
    .refine((v) => v == null || (Number.isInteger(v) && v >= min && v <= max), msg);
const money = z
  .string()
  .transform((v) => Number(v.replace(",", ".")))
  .refine((v) => Number.isFinite(v) && v >= 0 && v <= 100000, "Importo non valido");

const BASE = "/servizio/camere";
function refresh() {
  revalidatePath(BASE, "layout");
  revalidatePath("/oggi");
}

// ---------------------------------------------------------------------------
// Configurazione camere
// ---------------------------------------------------------------------------
const createSchema = z.object({
  kind: z.enum(["camera", "piazzola"]),
  spec: z.string().trim().min(1, "Indica le camere, ad esempio 101-120, piano 1").max(4000),
  floor: optText(20),
  room_type: optText(60),
  capacity: optInt(0, 50, "Capienza non valida"),
});

export async function createRooms(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = createSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const blocks = parseRoomBlocks(d.spec, d.floor);
  if (!blocks.ok) return { error: blocks.error };
  const supabase = await createClient();
  let created = 0;
  for (const b of blocks.blocks) {
    const { data: n, error } = await supabase.rpc("rooms_create_units", {
      p_facility: ctx.facility.id,
      p_kind: d.kind,
      p_labels: b.labels,
      p_floor: b.floor,
      p_room_type: d.room_type,
      p_capacity: d.capacity,
    });
    if (error) return { error: humanError(error) };
    created += Number(n ?? 0);
  }
  refresh();
  const skipped = blocks.total - created;
  return {
    ok: true,
    message: `${created} ${d.kind === "piazzola" ? "piazzole create" : "camere create"}` + (skipped > 0 ? ` (${skipped} già esistenti, saltate).` : "."),
  };
}

const unitSchema = z.object({
  point_id: uuid,
  floor: optText(20),
  room_type: optText(60),
  capacity: optInt(0, 50, "Capienza non valida"),
  notes: optText(500),
});

export async function updateRoom(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = unitSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("room_update_unit", {
    p_point: d.point_id,
    p_floor: d.floor,
    p_room_type: d.room_type,
    p_capacity: d.capacity,
    p_notes: d.notes,
    p_active: data.get("active") === "on",
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Salvato." };
}

const settingsSchema = z.object({
  checkin_time: z.string().regex(/^\d{2}:\d{2}$/, "Orario non valido"),
  checkout_time: z.string().regex(/^\d{2}:\d{2}$/, "Orario non valido"),
});

export async function saveRoomSettings(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = settingsSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase
    .from("room_settings")
    .upsert({ facility_id: ctx.facility.id, org_id: ctx.org.id, ...parsed.data, updated_at: new Date().toISOString() });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Orari salvati." };
}

const statusSchema = z.object({
  point_id: uuid,
  status: z.enum(["libera_pulita", "libera_sporca", "da_controllare", "fuori_servizio"]),
  note: optText(300),
});

export async function setRoomStatus(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = statusSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("room_set_status", { p_point: parsed.data.point_id, p_status: parsed.data.status, p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Stato aggiornato." };
}

const mbPriceSchema = z.object({ product_id: uuid, price: money });

export async function saveMinibarPrice(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = mbPriceSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("minibar_prices").upsert({
    facility_id: ctx.facility.id,
    product_id: parsed.data.product_id,
    org_id: ctx.org.id,
    price: Math.round(parsed.data.price * 100) / 100,
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Prezzo salvato." };
}

// ---------------------------------------------------------------------------
// Soggiorni
// ---------------------------------------------------------------------------
const staySchema = z.object({
  stay_id: optUuid,
  point_id: uuid,
  guest_name: z.string().trim().min(1, "Inserisci il nome dell'ospite").max(160),
  customer_id: optUuid,
  adults: z.coerce.number().int().min(0, "Adulti non validi").max(50, "Adulti non validi"),
  children: z.coerce.number().int().min(0, "Bambini non validi").max(50, "Bambini non validi"),
  arrival_date: isoDate,
  departure_date: isoDate,
  eta: z
    .string()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v == null || /^\d{2}:\d{2}$/.test(v), "Orario non valido"),
  notes: optText(1000),
  external_ref: optText(80),
});

export async function saveStay(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = staySchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (d.departure_date <= d.arrival_date) return { error: "La partenza deve essere dopo l'arrivo." };
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("room_stay_save", {
    p_stay: d.stay_id,
    p_point: d.point_id,
    p_guest_name: d.guest_name,
    p_customer: d.customer_id,
    p_adults: d.adults,
    p_children: d.children,
    p_arrival: d.arrival_date,
    p_departure: d.departure_date,
    p_eta: d.eta,
    p_notes: d.notes,
    p_external_ref: d.external_ref,
  });
  if (error) return { error: humanError(error) };
  refresh();
  if (!d.stay_id) redirect(`${BASE}/soggiorni/${id as string}?nuovo=1`);
  return { ok: true, message: "Soggiorno salvato." };
}

const stayIdSchema = z.object({ stay_id: uuid, reason: optText(300) });

export async function checkInStay(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = stayIdSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("room_checkin", { p_stay: parsed.data.stay_id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Check-in fatto: camera occupata." };
}

export async function checkOutStay(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = stayIdSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("room_checkout", { p_stay: parsed.data.stay_id });
  if (error) return { error: humanError(error) };
  refresh();
  revalidatePath("/lavoro/attivita");
  return { ok: true, message: "Check-out fatto: camera da pulire, attività creata per l'housekeeping." };
}

export async function cancelStay(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = stayIdSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("room_stay_cancel", { p_stay: parsed.data.stay_id, p_reason: parsed.data.reason });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Soggiorno annullato." };
}

/** Importazione CSV: il testo viene rivalidato qui (mai fidarsi dell'anteprima nel browser). */
export async function importStays(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const text = z.string().max(200_000, "Testo troppo lungo").safeParse(data.get("csv") ?? "");
  if (!text.success) return { error: text.error.issues[0]?.message };
  if (!text.data.trim()) return { error: "Incolla le righe da importare." };
  const supabase = await createClient();
  const { data: points, error: pErr } = await supabase
    .from("service_points")
    .select("label")
    .eq("facility_id", ctx.facility.id)
    .in("kind", ["camera", "piazzola"])
    .eq("active", true);
  if (pErr) return { error: humanError(pErr) };
  const res = parseStaysCsv(text.data, (points ?? []).map((p) => p.label as string));
  if (res.errors.length) return { error: `Ci sono ${res.errors.length} righe da correggere (la prima alla riga ${res.errors[0]!.line}: ${res.errors[0]!.error}).` };
  if (res.rows.length === 0) return { error: "Nessuna riga da importare." };
  const { data: out, error } = await supabase.rpc("room_stays_import", {
    p_facility: ctx.facility.id,
    p_rows: res.rows.map((r) => ({
      room: r.room,
      guest_name: r.guest_name,
      arrival: r.arrival,
      departure: r.departure,
      adults: r.adults,
      children: r.children,
      external_ref: r.external_ref,
    })),
  });
  if (error) return { error: humanError(error) };
  refresh();
  const o = (out ?? {}) as { inserted?: number; skipped?: number };
  return {
    ok: true,
    message: `Importati ${o.inserted ?? 0} soggiorni` + (o.skipped ? `; ${o.skipped} già presenti, saltati.` : "."),
  };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
const pointSchema = z.object({ point_id: uuid, note: optText(500) });

export async function startCleaning(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = pointSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("hk_start", { p_point: parsed.data.point_id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Pulizia iniziata." };
}

export async function finishCleaning(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = pointSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("hk_finish", { p_point: parsed.data.point_id, p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  refresh();
  revalidatePath("/lavoro/attivita");
  return { ok: true, message: "Pulizia finita." };
}

const inspectSchema = z.object({ point_id: uuid, ok: z.enum(["1", "0"]), note: optText(500) });

export async function inspectRoom(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = inspectSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (parsed.data.ok === "0" && !parsed.data.note) return { error: "Scrivi cosa va rifatto." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("hk_inspect", { p_point: parsed.data.point_id, p_ok: parsed.data.ok === "1", p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: parsed.data.ok === "1" ? "Camera ispezionata: pronta." : "Rimandata in pulizia." };
}

const assignSchema = z.object({
  user_id: optUuid,
  date: isoDate.optional(),
});

export async function assignRooms(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = assignSchema.safeParse({ user_id: data.get("user_id") ?? "", date: data.get("date") ?? undefined });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const points = data.getAll("point_id").map(String).filter((p) => uuid.safeParse(p).success);
  if (points.length === 0) return { error: "Seleziona almeno una camera." };
  if (points.length > 300) return { error: "Troppe camere selezionate." };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("hk_assign", { p_points: points, p_user: parsed.data.user_id, p_date: parsed.data.date ?? null });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: parsed.data.user_id ? `${n} camere assegnate.` : `${n} camere senza assegnazione.` };
}

// ---------------------------------------------------------------------------
// Minibar e addebiti
// ---------------------------------------------------------------------------
export async function postMinibar(_: ActionState, data: FormData): Promise<ActionState> {
  const point = uuid.safeParse(data.get("point_id"));
  if (!point.success) return { error: "Camera non valida" };
  const warehouse = optUuid.safeParse(data.get("warehouse_id") ?? "");
  if (!warehouse.success) return { error: "Magazzino non valido" };
  const items: { product_id: string; qty: number }[] = [];
  for (const [k, v] of data.entries()) {
    if (!k.startsWith("qty_")) continue;
    const pid = k.slice(4);
    const qty = Number(String(v).replace(",", "."));
    if (!uuid.safeParse(pid).success) continue;
    if (String(v).trim() === "" || qty === 0) continue;
    if (!Number.isFinite(qty) || qty < 0 || qty > 99) return { error: "Quantità non valida" };
    items.push({ product_id: pid, qty });
  }
  if (items.length === 0) return { error: "Indica almeno un prodotto consumato." };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("post_minibar", { p_point: point.data, p_warehouse: warehouse.data, p_items: items });
  if (error) return { error: humanError(error) };
  refresh();
  revalidatePath("/scorte");
  return { ok: true, message: `Minibar registrato: ${n} ${n === 1 ? "prodotto" : "prodotti"} addebitati e scaricati dal magazzino.` };
}

const chargeSchema = z.object({
  stay_id: uuid,
  description: z.string().trim().min(1, "Descrivi l'addebito").max(160),
  qty: z.coerce.number().positive("Quantità non valida").max(999, "Quantità non valida"),
  unit_price: money,
  source: z.enum(["room_service", "minibar", "altro"]),
});

export async function postCharge(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = chargeSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("post_room_charge", {
    p_stay: d.stay_id,
    p_description: d.description,
    p_qty: d.qty,
    p_unit_price: d.unit_price,
    p_source: d.source,
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Addebito registrato." };
}

const priceSchema = z.object({ charge_id: uuid, unit_price: money });

export async function priceCharge(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = priceSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_stay_charge_price", { p_charge: parsed.data.charge_id, p_unit_price: parsed.data.unit_price });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Prezzo salvato." };
}

const voidSchema = z.object({ charge_id: uuid, reason: z.string().trim().min(1, "Indica il motivo dello storno").max(300) });

export async function voidCharge(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = voidSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("void_stay_charge", { p_charge: parsed.data.charge_id, p_reason: parsed.data.reason });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Addebito stornato." };
}

// ---------------------------------------------------------------------------
// Segnalazione guasto dalla camera (housekeeping → manutenzione)
// ---------------------------------------------------------------------------
const issueSchema = z.object({
  point_id: uuid,
  category: z.string().trim().max(40).optional().default("altro"),
  priority: z.enum(["bassa", "media", "alta", "urgente"]).default("media"),
  description: z.string().trim().min(3, "Descrivi il problema").max(2000),
});

export async function reportRoomIssue(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = issueSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("open_maintenance_ticket", {
    p_facility: ctx.facility.id,
    p_point: d.point_id,
    p_location: null,
    p_asset: null,
    p_category: d.category,
    p_priority: d.priority,
    p_description: d.description,
    p_source: "housekeeping",
  });
  if (error) return { error: humanError(error) };
  const photo = data.get("photo");
  if (photo instanceof File && photo.size > 0 && id) {
    const err = await uploadTicketPhoto(ctx.org.id, id as string, photo);
    if (err) return { ok: true, message: `Segnalazione inviata, ma la foto non è stata caricata: ${err}` };
  }
  revalidatePath("/servizio/manutenzione");
  refresh();
  return { ok: true, message: "Segnalazione inviata alla manutenzione." };
}

const MAX_PHOTO = 10 * 1024 * 1024;

/** Carica la foto di un intervento in <org>/maintenance/<ticket>/<file> e la collega. Restituisce un errore leggibile o null. */
async function uploadTicketPhoto(orgId: string, ticketId: string, photo: File): Promise<string | null> {
  if (photo.size > MAX_PHOTO) return "la foto supera i 10 MB";
  if (!/^image\/(jpeg|png|webp|heic)$/.test(photo.type)) return "formato non supportato";
  const ext = photo.type === "image/jpeg" ? "jpg" : photo.type.split("/")[1];
  const path = `${orgId}/maintenance/${ticketId}/${crypto.randomUUID()}.${ext}`;
  const supabase = await createClient();
  const { error: upErr } = await supabase.storage.from("ordivia-files").upload(path, photo, { contentType: photo.type, upsert: false });
  if (upErr) return "caricamento non riuscito";
  const { error } = await supabase.rpc("maintenance_set_photo", { p_ticket: ticketId, p_path: path });
  return error ? humanError(error) : null;
}
