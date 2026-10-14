"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { TICKET_ACTION_TARGET, TICKET_CATEGORIES, type TicketAction } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid("Elemento non valido");
const optUuid = z
  .string()
  .optional()
  .transform((v) => v || null)
  .pipe(uuid.nullable());
const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const optDate = z
  .string()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Data non valida");
const category = z.enum(Object.keys(TICKET_CATEGORIES) as [string, ...string[]]);
const priority = z.enum(["bassa", "media", "alta", "urgente"]);

const BASE = "/servizio/manutenzione";
const MAX_PHOTO = 10 * 1024 * 1024;

function refresh() {
  revalidatePath(BASE, "layout");
  revalidatePath("/oggi");
}

async function uploadPhoto(orgId: string, ticketId: string, photo: File): Promise<string | null> {
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

const openSchema = z.object({
  point_id: optUuid,
  location: optText(120),
  asset_id: optUuid,
  category: category.default("altro"),
  priority: priority.default("media"),
  description: z.string().trim().min(3, "Descrivi il problema").max(2000),
});

export async function openTicket(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = openSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (!d.point_id && !d.location) return { error: "Indica dove si trova il problema." };
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("open_maintenance_ticket", {
    p_facility: ctx.facility.id,
    p_point: d.point_id,
    p_location: d.location,
    p_asset: d.asset_id,
    p_category: d.category,
    p_priority: d.priority,
    p_description: d.description,
    p_source: "segnalazione",
  });
  if (error) return { error: humanError(error) };
  const photo = data.get("photo");
  let warn: string | null = null;
  if (photo instanceof File && photo.size > 0) warn = await uploadPhoto(ctx.org.id, id as string, photo);
  refresh();
  if (warn) return { ok: true, message: `Segnalazione inviata, ma la foto non è stata caricata: ${warn}.` };
  redirect(`${BASE}/${id as string}?nuovo=1`);
}

export async function addTicketPhoto(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const id = uuid.safeParse(data.get("ticket_id"));
  if (!id.success) return { error: "Intervento non valido" };
  const photo = data.get("photo");
  if (!(photo instanceof File) || photo.size === 0) return { error: "Scegli una foto." };
  const err = await uploadPhoto(ctx.org.id, id.data, photo);
  if (err) return { error: `Foto non caricata: ${err}.` };
  refresh();
  return { ok: true, message: "Foto aggiunta." };
}

const actionEnum = z.enum(Object.keys(TICKET_ACTION_TARGET) as [TicketAction, ...TicketAction[]]);
const transitionSchema = z.object({
  ticket_id: uuid,
  action: actionEnum,
  note: optText(2000),
  assignee: optUuid,
});

export async function ticketTransition(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = transitionSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (d.action === "risolvi" && !d.note) return { error: "Scrivi cosa è stato fatto." };
  if (d.action === "assegna" && !d.assignee) return { error: "Scegli a chi assegnare." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("maintenance_transition", {
    p_ticket: d.ticket_id,
    p_to: TICKET_ACTION_TARGET[d.action],
    p_note: d.note,
    p_assignee: d.assignee,
  });
  if (error) return { error: humanError(error) };
  refresh();
  const msg: Record<TicketAction, string> = {
    assegna: "Assegnato.",
    inizia: "Intervento iniziato.",
    attesa_ricambi: "In attesa dei ricambi.",
    riprendi: "Intervento ripreso.",
    risolvi: "Segnato come risolto: in attesa di verifica.",
    verifica: "Verificato, intervento chiuso.",
    riapri: "Riaperto.",
    annulla: "Intervento annullato.",
  };
  return { ok: true, message: msg[d.action] };
}

// ---------------------------------------------------------------------------
// Cespiti e manutenzione programmata
// ---------------------------------------------------------------------------
const assetSchema = z.object({
  asset_id: optUuid,
  name: z.string().trim().min(1, "Nome obbligatorio").max(120),
  location: optText(120),
  category: optText(60),
  purchase_date: optDate,
  warranty_until: optDate,
  notes: optText(1000),
});

export async function saveAsset(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = assetSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { asset_id, ...d } = parsed.data;
  const supabase = await createClient();
  const { error } = asset_id
    ? await supabase.from("assets").update({ ...d, active: data.get("active") === "on" }).eq("id", asset_id)
    : await supabase.from("assets").insert({ ...d, org_id: ctx.org.id, facility_id: ctx.facility.id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: asset_id ? "Cespite salvato." : "Cespite aggiunto." };
}

const planSchema = z.object({
  plan_id: optUuid,
  asset_id: uuid,
  title: z.string().trim().min(2, "Titolo obbligatorio").max(160),
  description: optText(1000),
  category: category.default("altro"),
  priority: priority.default("media"),
  every_days: z.coerce.number().int("Giorni non validi").min(1, "Almeno 1 giorno").max(3660, "Massimo 10 anni"),
  next_due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida"),
  assigned_to: optUuid,
});

export async function savePlan(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = planSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { plan_id, ...d } = parsed.data;
  const supabase = await createClient();
  // facility_id viene sovrascritto dal database con quello del cespite
  const row = { ...d, org_id: ctx.org.id, facility_id: ctx.facility.id };
  const { error } = plan_id
    ? await supabase.from("maintenance_plans").update({ ...row, active: data.get("active") === "on" }).eq("id", plan_id)
    : await supabase.from("maintenance_plans").insert(row);
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: plan_id ? "Piano salvato." : "Piano creato." };
}

export async function generatePlanned(_: ActionState, _data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("generate_planned_maintenance", { p_facility: ctx.facility.id, p_date: null });
  if (error) return { error: humanError(error) };
  refresh();
  const count = Number(n ?? 0);
  return { ok: true, message: count === 0 ? "Nessun intervento in scadenza." : `${count} ${count === 1 ? "intervento creato" : "interventi creati"}.` };
}
