"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { zonedTimeToUtc } from "@ordivia/domain";

const uuid = z.string().uuid();
const MAX_PHOTO = 10 * 1024 * 1024;

export async function createTask(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      title: z.string().trim().min(2, "Scrivi cosa va fatto").max(200),
      description: z.string().trim().max(2000).optional(),
      assignee_id: uuid.or(z.literal("")).optional(),
      department_id: uuid.or(z.literal("")).optional(),
      due_date: z.string().optional(),
      due_time: z.string().optional(),
      requires_photo: z.literal("on").optional(),
      requires_verification: z.literal("on").optional(),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  let due: string | null = null;
  if (d.due_date) {
    const [y, m, day] = d.due_date.split("-").map(Number) as [number, number, number];
    const [hh, mm] = (d.due_time || "23:59").split(":").map(Number) as [number, number];
    due = zonedTimeToUtc(y, m, day, hh, mm, ctx.facility.timezone).toISOString();
  }
  const supabase = await createClient();
  const { error } = await supabase.from("tasks").insert({
    org_id: ctx.org.id,
    facility_id: ctx.facility.id,
    department_id: d.department_id || null,
    title: d.title,
    description: d.description || null,
    assignee_id: d.assignee_id || null,
    due_at: due,
    requires_photo: !!d.requires_photo,
    requires_verification: !!d.requires_verification,
    created_by: ctx.userId,
  });
  if (error) return { error: humanError(error) };
  revalidatePath("/lavoro/attivita");
  revalidatePath("/oggi");
  return { ok: true, message: "Attività assegnata." };
}

export async function markSeen(ids: string[]) {
  const supabase = await createClient();
  for (const id of ids.filter((i) => uuid.safeParse(i).success).slice(0, 50)) {
    await supabase.rpc("task_transition", { p_task: id, p_to: "vista" });
  }
}

export async function advanceTask(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const id = uuid.safeParse(data.get("task_id"));
  const to = z.enum(["iniziata", "completata", "verificata", "annullata"]).safeParse(data.get("to"));
  if (!id.success || !to.success) return { error: "Operazione non valida" };
  const supabase = await createClient();

  let photoPath: string | null = null;
  const photo = data.get("photo");
  if (photo instanceof File && photo.size > 0) {
    if (photo.size > MAX_PHOTO) return { error: "La foto supera i 10 MB" };
    if (!/^image\/(jpeg|png|webp|heic)$/.test(photo.type)) return { error: "Formato foto non supportato" };
    const ext = photo.type.split("/")[1] === "jpeg" ? "jpg" : photo.type.split("/")[1];
    photoPath = `${ctx.org.id}/tasks/${id.data}/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("ordivia-files").upload(photoPath, photo, { contentType: photo.type, upsert: false });
    if (upErr) return { error: "Caricamento foto non riuscito. Riprova." };
  }
  const note = ((data.get("note") as string) || "").trim() || null;
  const { error } = await supabase.rpc("task_transition", { p_task: id.data, p_to: to.data, p_note: note, p_photo: photoPath });
  if (error) return { error: humanError(error) };
  revalidatePath("/lavoro/attivita");
  revalidatePath("/oggi");
  const msg = { iniziata: "Attività iniziata.", completata: "Ottimo, attività completata.", verificata: "Attività verificata.", annullata: "Attività annullata." }[to.data];
  return { ok: true, message: msg };
}

export async function rejectTask(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("task_id"));
  if (!id.success) return { error: "Operazione non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("task_transition", { p_task: id.data, p_to: "iniziata", p_note: ((data.get("note") as string) || "").trim() || "Da rifare" });
  if (error) return { error: humanError(error) };
  revalidatePath("/lavoro/attivita");
  return { ok: true, message: "Rimandata al collega." };
}
