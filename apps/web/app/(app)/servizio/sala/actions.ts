"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { expandLabelRange } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Tavoli e punti di servizio
// ---------------------------------------------------------------------------
const bulkSchema = z.object({
  kind: z.enum(["tavolo", "ritiro", "piscina", "camera", "gazebo", "piazzola", "altro"]),
  spec: z.string().trim().min(1, "Indica i tavoli, ad esempio 1-20 oppure T1-T8").max(1000),
  zone: z.string().trim().max(40).optional().transform((v) => v || null),
  seats: z
    .union([z.literal(""), z.coerce.number().int().min(0, "Coperti non validi").max(500, "Coperti non validi")])
    .optional()
    .transform((v) => (v === "" || v == null ? null : v)),
});

export async function createServicePoints(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = bulkSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const range = expandLabelRange(parsed.data.spec);
  if (!range.ok) return { error: range.error };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("pos_create_service_points", {
    p_facility: ctx.facility.id,
    p_kind: parsed.data.kind,
    p_labels: range.labels,
    p_zone: parsed.data.zone,
    p_seats: parsed.data.seats,
  });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/sala", "layout");
  const skipped = range.labels.length - Number(n);
  return { ok: true, message: `Creati ${n} punti${skipped > 0 ? ` (${skipped} esistevano già)` : ""}.` };
}

export async function toggleServicePoint(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Punto non valido" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_service_point_active", { p_point: id.data, p_active: data.get("active") === "1" });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/sala", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Comande
// ---------------------------------------------------------------------------
const openSchema = z.object({
  service_point_id: z.union([uuid, z.literal("")]).optional(),
  kind: z.enum(["asporto", "banco"]).optional(),
  covers: z.coerce.number().int().min(0, "Coperti non validi").max(500, "Coperti non validi").default(0),
});

export async function openOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = openSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const point = parsed.data.service_point_id || null;
  if (!point && !parsed.data.kind) return { error: "Scegli una destinazione" };
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("pos_open_order", {
    p_facility: ctx.facility.id,
    p_service_point: point,
    p_kind: point ? null : parsed.data.kind,
    p_covers: parsed.data.covers,
  });
  if (error) return { error: humanError(error) };
  redirect(`/servizio/sala/${id}`);
}

const updateSchema = z.object({
  order_id: uuid,
  covers: z.coerce.number().int().min(0, "Coperti non validi").max(500, "Coperti non validi"),
  note: z.string().trim().max(500).optional().transform((v) => v || null),
});

export async function updateOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = updateSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_update_order", { p_order: parsed.data.order_id, p_covers: parsed.data.covers, p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/sala/${parsed.data.order_id}`);
  return { ok: true, message: "Comanda aggiornata." };
}

export async function moveOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const order = uuid.safeParse(data.get("order_id"));
  const point = uuid.safeParse(data.get("service_point_id"));
  if (!order.success || !point.success) return { error: "Scegli il nuovo tavolo" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_move_order", { p_order: order.data, p_service_point: point.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/sala/${order.data}`);
  return { ok: true, message: "Comanda spostata." };
}

export async function cancelOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const order = uuid.safeParse(data.get("order_id"));
  if (!order.success) return { error: "Comanda non valida" };
  const reason = z.string().trim().max(300).safeParse(data.get("reason") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_cancel_order", { p_order: order.data, p_reason: reason.success ? reason.data || null : null });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/sala");
  redirect("/servizio/sala?annullata=1");
}

const lineSchema = z.object({
  menu_item_id: uuid,
  qty: z.number().int().min(1).max(99),
  course: z.number().int().min(1).max(9),
  notes: z.string().trim().max(300).optional(),
  without: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  allergy: z.boolean().optional(),
  allergy_note: z.string().trim().max(300).optional(),
});
const sendSchema = z.object({ order_id: uuid, lines: z.array(lineSchema).min(1, "Aggiungi almeno un piatto").max(100) });

/** Invio in produzione dal palmare: chiamata diretta dal client (non da form), tutto o niente. */
export async function sendLines(input: z.input<typeof sendSchema>): Promise<ActionState> {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Comanda non valida" };
  const supabase = await createClient();
  const lines = parsed.data.lines.map((l) => ({
    ...l,
    notes: l.notes || null,
    allergy_note: l.allergy_note || null,
    allergy: !!l.allergy || !!l.allergy_note,
  }));
  const { data: n, error } = await supabase.rpc("pos_add_lines", { p_order: parsed.data.order_id, p_lines: lines });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/sala/${parsed.data.order_id}`);
  return { ok: true, message: n === 1 ? "1 riga inviata in produzione." : `${n} righe inviate in produzione.` };
}

export async function serveLines(_: ActionState, data: FormData): Promise<ActionState> {
  const ids = z.array(uuid).min(1).safeParse(data.getAll("line_id"));
  if (!ids.success) return { error: "Nessuna riga selezionata" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_lines_status", { p_lines: ids.data, p_to: "servita" });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ordini degli ospiti dal portale QR
// ---------------------------------------------------------------------------
export async function acceptPortalSubmission(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("submission_id"));
  const order = uuid.safeParse(data.get("order_id"));
  if (!id.success || !order.success) return { error: "Ordine non valido" };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("portal_accept_submission", { p_submission: id.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  return { ok: true, message: n === 1 ? "Accettato: 1 riga inviata in produzione." : `Accettato: ${n} righe inviate in produzione.` };
}

const rejectSchema = z.object({
  submission_id: uuid,
  order_id: uuid,
  reason: z.string().trim().min(3, "Indica il motivo del rifiuto").max(300, "Motivo troppo lungo (massimo 300 caratteri)"),
});

export async function rejectPortalSubmission(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = rejectSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_reject_submission", { p_submission: parsed.data.submission_id, p_reason: parsed.data.reason });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  return { ok: true, message: "Ordine online rifiutato: porzioni restituite." };
}
