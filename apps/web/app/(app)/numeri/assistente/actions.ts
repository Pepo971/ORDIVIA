"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { can, getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const schema = z.object({
  key: z.string().trim().min(1).max(200),
  action: z.enum(["ignorato", "rimandato", "ripristina"]),
  days: z.coerce.number().int().min(1).max(90).optional(),
});

/** Ignora (30 giorni), rimanda (1–7 giorni) o ripristina un suggerimento: vale solo per la persona corrente. */
export async function setInsightFeedback(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  if (!can(ctx, "analytics.view", "finance.view")) return { error: "Non hai i permessi per questa operazione." };
  const parsed = schema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: "Dati non validi" };
  const d = parsed.data;
  const supabase = await createClient();

  if (d.action === "ripristina") {
    const { error } = await supabase.from("insight_feedback").delete().eq("facility_id", ctx.facility.id).eq("user_id", ctx.userId).eq("insight_key", d.key);
    if (error) return { error: humanError(error) };
    revalidatePath("/numeri/assistente");
    return { ok: true, message: "Suggerimento ripristinato." };
  }

  const days = d.action === "ignorato" ? 30 : Math.min(d.days ?? 1, 7);
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const { error } = await supabase.from("insight_feedback").upsert(
    { org_id: ctx.org.id, facility_id: ctx.facility.id, user_id: ctx.userId, insight_key: d.key, action: d.action, until, created_at: new Date().toISOString() },
    { onConflict: "user_id,facility_id,insight_key" },
  );
  if (error) return { error: humanError(error) };
  revalidatePath("/numeri/assistente");
  return { ok: true, message: d.action === "ignorato" ? "Suggerimento ignorato per 30 giorni." : `Suggerimento rimandato di ${days === 1 ? "un giorno" : `${days} giorni`}.` };
}
