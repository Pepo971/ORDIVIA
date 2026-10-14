"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { normalizeAllergens } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const optUuid = z
  .string()
  .optional()
  .transform((v) => (v && uuid.safeParse(v).success ? v : null));
const dec = (msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).finite(msg));

// ---------------------------------------------------------------------------
// Categorie
// ---------------------------------------------------------------------------
export async function createCategory(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({ name: z.string().trim().min(1, "Inserisci il nome della categoria").max(60), sort: z.coerce.number().int().min(0).max(999).default(0) })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("menu_categories").insert({ org_id: ctx.org.id, facility_id: ctx.facility.id, ...parsed.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu");
  return { ok: true, message: `Categoria «${parsed.data.name}» aggiunta.` };
}

export async function updateCategory(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = z
    .object({ id: uuid, name: z.string().trim().min(1, "Inserisci il nome").max(60), sort: z.coerce.number().int().min(0).max(999).default(0) })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { id, ...rest } = parsed.data;
  const { error } = await supabase.from("menu_categories").update(rest).eq("id", id);
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu");
  return { ok: true, message: "Categoria aggiornata." };
}

export async function deleteCategory(data: FormData) {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.from("menu_categories").delete().eq("id", id.data);
  revalidatePath("/servizio/menu");
}

// ---------------------------------------------------------------------------
// Voci di menu
// ---------------------------------------------------------------------------
const itemSchema = z.object({
  name: z.string().trim().min(1, "Inserisci il nome").max(120),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
  category_id: optUuid,
  prep_station_id: optUuid,
  price: dec("Prezzo non valido").pipe(z.number().min(0, "Il prezzo non può essere negativo").max(99999)),
  vat_rate: dec("IVA non valida").pipe(z.number().min(0).max(30)),
  course: z.coerce.number().int().min(1).max(9),
  sort: z.coerce.number().int().min(0).max(9999).default(0),
  target_food_cost_pct: dec("Food cost obiettivo non valido").pipe(z.number().gt(0, "Il food cost obiettivo deve essere maggiore di zero").max(100)),
  yield_portions: dec("Resa non valida").pipe(z.number().gt(0, "La resa deve essere maggiore di zero").max(10000)),
});

function readItem(data: FormData) {
  const parsed = itemSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dati non validi" } as const;
  return {
    value: {
      ...parsed.data,
      allergens: normalizeAllergens(data.getAll("allergens").map(String)),
      active: data.get("active") === "on",
      available: data.get("available") === "on",
    },
  } as const;
}

export async function createMenuItem(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const r = readItem(data);
  if ("error" in r) return { error: r.error };
  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("menu_items")
    .insert({ org_id: ctx.org.id, facility_id: ctx.facility.id, ...r.value })
    .select("id")
    .single();
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu");
  redirect(`/servizio/menu/${row.id}?nuovo=1`);
}

export async function updateMenuItem(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return { error: "Voce non valida" };
  const r = readItem(data);
  if ("error" in r) return { error: r.error };
  const supabase = await createClient();
  const { error, count } = await supabase.from("menu_items").update(r.value, { count: "exact" }).eq("id", id.data);
  if (error) return { error: humanError(error) };
  if (count === 0) return { error: "Non hai i permessi per modificare questa voce." };
  revalidatePath("/servizio/menu");
  revalidatePath(`/servizio/menu/${id.data}`);
  return { ok: true, message: "Voce aggiornata." };
}

export async function setItemPrice(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const price = dec("Prezzo non valido").pipe(z.number().min(0).max(99999)).safeParse(data.get("price"));
  if (!id.success || !price.success) return { error: "Prezzo non valido" };
  const supabase = await createClient();
  const { error } = await supabase.from("menu_items").update({ price: price.data }).eq("id", id.data);
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu", "layout");
  return { ok: true, message: "Prezzo aggiornato." };
}

export async function deleteMenuItem(data: FormData) {
  const id = uuid.safeParse(data.get("id"));
  if (!id.success) return;
  const supabase = await createClient();
  const { error } = await supabase.from("menu_items").delete().eq("id", id.data);
  if (error) {
    // Se la voce è già usata (comande, etichette) la disattiviamo invece di cancellarla.
    await supabase.from("menu_items").update({ active: false }).eq("id", id.data);
    redirect(`/servizio/menu/${id.data}?disattivata=1`);
  }
  revalidatePath("/servizio/menu");
  redirect("/servizio/menu");
}

// ---------------------------------------------------------------------------
// Distinta base
// ---------------------------------------------------------------------------
const lineSchema = z.object({
  menu_item_id: uuid,
  product_id: uuid,
  qty: dec("Quantità non valida").pipe(z.number().gt(0, "La quantità deve essere maggiore di zero").max(100000)),
  waste_pct: dec("Scarto non valido").pipe(z.number().min(0, "Scarto non valido").lt(100, "Lo scarto deve essere inferiore al 100%")).default(0),
});

export async function addRecipeLine(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const raw = Object.fromEntries(data);
  const parsed = lineSchema.safeParse({ ...raw, waste_pct: raw.waste_pct || 0 });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("recipe_lines").insert({ org_id: ctx.org.id, ...parsed.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/menu/${parsed.data.menu_item_id}`);
  return { ok: true, message: "Ingrediente aggiunto." };
}

export async function updateRecipeLine(_: ActionState, data: FormData): Promise<ActionState> {
  const raw = Object.fromEntries(data);
  const parsed = lineSchema.omit({ product_id: true }).extend({ id: uuid }).safeParse({ ...raw, waste_pct: raw.waste_pct || 0 });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("recipe_lines").update({ qty: parsed.data.qty, waste_pct: parsed.data.waste_pct }).eq("id", parsed.data.id);
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/menu/${parsed.data.menu_item_id}`);
  return { ok: true, message: "Salvato." };
}

export async function removeRecipeLine(data: FormData) {
  const id = uuid.safeParse(data.get("id"));
  const item = uuid.safeParse(data.get("menu_item_id"));
  if (!id.success || !item.success) return;
  const supabase = await createClient();
  await supabase.from("recipe_lines").delete().eq("id", id.data);
  revalidatePath(`/servizio/menu/${item.data}`);
}

// ---------------------------------------------------------------------------
// Centri di produzione
// ---------------------------------------------------------------------------
const stationSchema = z.object({
  name: z.string().trim().min(1, "Inserisci il nome").max(60),
  kind: z.enum(["cucina", "pizzeria", "bar", "dessert", "griglia", "altro"]),
  warehouse_id: optUuid,
  department_id: optUuid,
  sort: z.coerce.number().int().min(0).max(999).default(0),
});

export async function createPrepStation(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = stationSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("prep_stations").insert({ org_id: ctx.org.id, facility_id: ctx.facility.id, ...parsed.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu/centri");
  return { ok: true, message: `«${parsed.data.name}» aggiunto.` };
}

export async function updatePrepStation(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const parsed = stationSchema.safeParse(Object.fromEntries(data));
  if (!id.success) return { error: "Centro non valido" };
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase
    .from("prep_stations")
    .update({ ...parsed.data, active: data.get("active") === "on" })
    .eq("id", id.data);
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/menu/centri");
  return { ok: true, message: "Centro di produzione aggiornato." };
}
