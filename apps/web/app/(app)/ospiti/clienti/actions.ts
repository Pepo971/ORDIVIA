"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cleanList, CONSENT_SOURCES, parseSegmentFilters } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const BASE = "/ospiti/clienti";
function refresh() {
  revalidatePath(BASE, "layout");
  revalidatePath("/ospiti/prenotazioni", "layout");
}

const uuid = z.string().uuid();
const optText = (max: number) => z.string().trim().max(max, `Massimo ${max} caratteri`).optional().transform((v) => v || null);

const customerSchema = z.object({
  id: z
    .string()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v == null || uuid.safeParse(v).success, "Cliente non valido"),
  full_name: z.string().trim().min(1, "Inserisci il nome").max(160),
  phone: optText(40),
  email: z.union([z.literal(""), z.string().trim().email("Email non valida").max(160)]).optional().transform((v) => v || null),
  language: z.string().regex(/^[a-z]{2}$/).default("it"),
  birthday: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida")]).optional().transform((v) => v || null),
  allergies: z.string().max(600).optional().transform((v) => cleanList(v ?? "")),
  tags: z.string().max(600).optional().transform((v) => cleanList(v ?? "")),
  preferences: optText(2000),
  notes: optText(2000),
  force: z.literal("1").optional(),
  ritorno: z.string().optional(),
});

export async function saveCustomer(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const p = customerSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("crm_save_customer", {
    p_org: ctx.org.id,
    p_id: d.id,
    p_name: d.full_name,
    p_phone: d.phone,
    p_email: d.email,
    p_language: d.language,
    p_birthday: d.birthday,
    p_allergies: d.allergies,
    p_preferences: d.preferences,
    p_notes: d.notes,
    p_tags: d.tags,
    p_force: d.force === "1",
  });
  if (error) {
    const msg = humanError(error);
    return { error: error.message?.startsWith("Esiste già") ? `${msg}. Apri la scheda esistente oppure spunta «Salva comunque» (potrai unirle dopo).` : msg };
  }
  refresh();
  if (d.id) return { ok: true, message: "Scheda salvata." };
  const back = d.ritorno && d.ritorno.startsWith("/ospiti/prenotazioni/nuova") ? d.ritorno : null;
  if (back) redirect(`${back}${back.includes("?") ? "&" : "?"}cliente=${id as string}#dati`);
  redirect(`${BASE}/${id as string}?nuovo=1`);
}

const consentSchema = z.object({
  customer_id: uuid,
  kind: z.enum(["privacy", "marketing"]),
  granted: z.enum(["0", "1"]),
  source: z.enum(CONSENT_SOURCES, { message: "Indica la fonte del consenso" }),
});

export async function setConsent(_: ActionState, data: FormData): Promise<ActionState> {
  const p = consentSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("crm_set_consent", {
    p_customer: p.data.customer_id,
    p_kind: p.data.kind,
    p_granted: p.data.granted === "1",
    p_source: p.data.source,
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Consenso registrato con fonte e data." };
}

export async function mergeCustomers(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ keep_id: uuid, merge_id: uuid }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Scegli le due schede da unire" };
  if (p.data.keep_id === p.data.merge_id) return { error: "Scegli due clienti diversi" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("crm_merge_customers", { p_keep: p.data.keep_id, p_merge: p.data.merge_id });
  if (error) return { error: humanError(error) };
  refresh();
  redirect(`${BASE}/${p.data.keep_id}?unito=1`);
}

export async function anonymizeCustomer(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ customer_id: uuid, confirm: z.literal("ANONIMIZZA", { message: "Scrivi ANONIMIZZA per confermare" }) }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("crm_anonymize_customer", { p_customer: p.data.customer_id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Dati personali rimossi. Lo storico economico resta." };
}

export async function saveSegment(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const name = z.string().trim().min(1, "Dai un nome al segmento").max(80).safeParse(data.get("name"));
  if (!name.success) return { error: name.error.issues[0]?.message };
  const filters = parseSegmentFilters(Object.fromEntries(data));
  if (Object.keys(filters).length === 0) return { error: "Imposta almeno un filtro prima di salvare il segmento" };
  const supabase = await createClient();
  const { error } = await supabase.from("customer_segments").insert({ org_id: ctx.org.id, name: name.data, filters });
  if (error) return { error: error.code === "23505" ? "Esiste già un segmento con questo nome." : humanError(error) };
  refresh();
  return { ok: true, message: "Segmento salvato." };
}

export async function deleteSegment(data: FormData) {
  const id = uuid.safeParse(data.get("segment_id"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.from("customer_segments").delete().eq("id", id.data);
  refresh();
}
