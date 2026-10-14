"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseChecklistItems } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();

function done() {
  revalidatePath("/lavoro/checklist");
  revalidatePath("/lavoro/attivita");
  revalidatePath("/oggi");
}

const templateSchema = z
  .object({
    id: z.union([uuid, z.literal("")]).optional().transform((v) => v || null),
    title: z.string().trim().min(2, "Dai un titolo alla checklist").max(200),
    items: z.array(z.string()).min(1, "Aggiungi almeno una voce").max(60, "Massimo 60 voci"),
    department_id: z.union([uuid, z.literal("")]).transform((v) => v || null),
    weekdays: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Scegli almeno un giorno"),
    due_time: z.string().regex(/^\d{2}:\d{2}$/, "Orario non valido"),
    assignee_mode: z.enum(["in_turno", "persona"]),
    assignee_id: z.union([uuid, z.literal("")]).optional().transform((v) => v || null),
    requires_photo: z.literal("on").optional(),
    requires_verification: z.literal("on").optional(),
  })
  .refine((d) => d.assignee_mode !== "in_turno" || d.department_id, { message: "Per «chi è in turno» scegli il reparto", path: ["department_id"] })
  .refine((d) => d.assignee_mode !== "persona" || d.assignee_id, { message: "Scegli la persona", path: ["assignee_id"] });

export async function saveTemplate(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = templateSchema.safeParse({
    ...Object.fromEntries(data),
    items: parseChecklistItems(String(data.get("items") ?? "")),
    weekdays: data.getAll("weekdays"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const row = {
    title: d.title,
    items: d.items,
    department_id: d.department_id,
    weekdays: [...new Set(d.weekdays)].sort(),
    due_time: d.due_time,
    assignee_mode: d.assignee_mode,
    assignee_id: d.assignee_mode === "persona" ? d.assignee_id : null,
    requires_photo: !!d.requires_photo,
    requires_verification: !!d.requires_verification,
  };
  const supabase = await createClient();
  const { error } = d.id
    ? await supabase.from("checklist_templates").update(row).eq("id", d.id).eq("facility_id", ctx.facility.id)
    : await supabase.from("checklist_templates").insert({ ...row, org_id: ctx.org.id, facility_id: ctx.facility.id, created_by: ctx.userId });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: d.id ? "Checklist aggiornata." : "Checklist creata: verrà generata nei giorni scelti." };
}

export async function toggleTemplate(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Checklist non valida" };
  const active = data.get("active") === "1";
  const supabase = await createClient();
  const { error } = await supabase.from("checklist_templates").update({ active }).eq("id", id.data);
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: active ? "Riattivata." : "Sospesa: non verrà più generata." };
}

export async function generateToday(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().safeParse(data.get("date") || undefined);
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("generate_daily_checklists", { p_facility: ctx.facility.id, p_date: date.success ? date.data ?? null : null });
  if (error) return { error: humanError(error) };
  done();
  return { ok: true, message: n ? `Create ${n} attività.` : "Già tutte generate: nessun duplicato." };
}
