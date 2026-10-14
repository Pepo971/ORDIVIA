"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { can, getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const factor = z.coerce
  .number({ message: "Moltiplicatore non valido" })
  .finite()
  .min(0.1, "Il moltiplicatore va da 0,1 a 3")
  .max(3, "Il moltiplicatore va da 0,1 a 3");

const schema = z.object({
  weather_sunny: factor,
  weather_variable: factor,
  weather_rain: factor,
  prep_weeks: z.coerce.number().int().min(1, "Da 1 a 26 settimane").max(26, "Da 1 a 26 settimane"),
  ticket_target_minutes: z.coerce.number().int().min(1, "Obiettivo da 1 a 180 minuti").max(180, "Obiettivo da 1 a 180 minuti"),
});

/** Moltiplicatori meteo, settimane di storico e obiettivo tempi cucina della struttura (menu.manage o org.manage; RLS ricontrolla). */
export async function saveAnalyticsSettings(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  if (!can(ctx, "menu.manage", "org.manage")) return { error: "Non hai i permessi per questa operazione." };
  const raw = Object.fromEntries([...data.entries()].map(([k, v]) => [k, typeof v === "string" ? v.replace(",", ".") : v]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dati non validi" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("analytics_settings")
    .upsert({ org_id: ctx.org.id, facility_id: ctx.facility.id, ...parsed.data, updated_by: ctx.userId, updated_at: new Date().toISOString() }, { onConflict: "facility_id" });
  if (error) return { error: humanError(error) };
  revalidatePath("/numeri/preparazioni");
  revalidatePath("/numeri/andamento");
  revalidatePath("/numeri/assistente");
  return { ok: true, message: "Impostazioni salvate." };
}
