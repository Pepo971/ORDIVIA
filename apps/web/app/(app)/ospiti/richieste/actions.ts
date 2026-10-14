"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TICKET_CATEGORIES } from "@ordivia/domain";
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

function refresh() {
  revalidatePath("/ospiti/richieste");
  revalidatePath("/oggi");
}

const createSchema = z.object({
  service_point_id: optUuid,
  customer_id: optUuid,
  source: z.enum(["staff", "telefono", "whatsapp", "email"]),
  category: z.enum(["assistenza", "pulizia", "manutenzione", "room_service", "informazioni", "reclamo", "altro"]),
  message: z.string().trim().min(1, "Scrivi la richiesta").max(1000),
  guest_name: optText(160),
  guest_contact: optText(160),
});

/** Richiesta registrata dallo staff per conto dell'ospite (telefono, banco, WhatsApp…). */
export async function createGuestRequest(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = createSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("guest_requests").insert({
    ...parsed.data,
    org_id: ctx.org.id,
    facility_id: ctx.facility.id,
    created_by: ctx.userId,
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Richiesta registrata." };
}

const statusSchema = z.object({
  request_id: uuid,
  to: z.enum(["presa_in_carico", "risolta", "annullata"]),
  note: optText(1000),
});

export async function setGuestRequestStatus(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = statusSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (parsed.data.to === "annullata" && !parsed.data.note) return { error: "Indica il motivo." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("guest_request_set_status", { p_request: parsed.data.request_id, p_to: parsed.data.to, p_note: parsed.data.note });
  if (error) return { error: humanError(error) };
  refresh();
  const msg = { presa_in_carico: "Presa in carico.", risolta: "Risolta.", annullata: "Annullata." }[parsed.data.to];
  return { ok: true, message: msg };
}

const ticketSchema = z.object({
  request_id: uuid,
  priority: z.enum(["bassa", "media", "alta", "urgente"]).default("media"),
  category: z.enum(Object.keys(TICKET_CATEGORIES) as [string, ...string[]]).default("altro"),
});

export async function requestToTicket(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = ticketSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("guest_request_to_ticket", {
    p_request: parsed.data.request_id,
    p_priority: parsed.data.priority,
    p_category: parsed.data.category,
  });
  if (error) return { error: humanError(error) };
  refresh();
  revalidatePath("/servizio/manutenzione", "layout");
  return { ok: true, message: "Inviata alla manutenzione: intervento creato." };
}

export async function requestToHousekeeping(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("request_id"));
  if (!id.success) return { error: "Richiesta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("guest_request_to_housekeeping", { p_request: id.data });
  if (error) return { error: humanError(error) };
  refresh();
  revalidatePath("/servizio/camere", "layout");
  revalidatePath("/lavoro/attivita");
  return { ok: true, message: "Inviata all'housekeeping." };
}
