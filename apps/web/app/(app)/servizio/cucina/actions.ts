"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const status = z.enum(["inviata", "in_preparazione", "pronta", "servita"]);

/** Cambia stato a una o più righe (tocco sul ticket, «tutto pronto», incastro). */
export async function setLinesStatus(_: ActionState, data: FormData): Promise<ActionState> {
  const ids = z.array(uuid).min(1).max(200).safeParse(data.getAll("line_id"));
  const to = status.safeParse(data.get("to"));
  if (!ids.success || !to.success) return { error: "Richiesta non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_lines_status", { p_lines: ids.data, p_to: to.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  return { ok: true };
}

const availSchema = z.object({
  item_id: uuid,
  mode: z.enum(["esaurito", "disponibile", "porzioni"]),
  portions: z.union([z.literal(""), z.coerce.number().int().min(0, "Porzioni non valide").max(10000, "Porzioni non valide")]).optional(),
});

export async function setAvailability(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = availSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const { item_id, mode, portions } = parsed.data;
  if (mode === "porzioni" && (portions === "" || portions == null)) return { error: "Indica quante porzioni restano" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_item_availability", {
    p_item: item_id,
    p_available: mode !== "esaurito",
    p_portions_left: mode === "porzioni" ? (portions as number) : null,
  });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  return { ok: true, message: mode === "esaurito" ? "Segnato esaurito." : mode === "porzioni" ? `Porzioni: ${portions}.` : "Di nuovo disponibile, senza limite." };
}
