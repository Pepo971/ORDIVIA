"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { normalizeAllergens, zonedTimeToUtc } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const dec = (msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).finite(msg));
const BASE = "/servizio/menu/haccp";

/** "AAAA-MM-GGTHH:MM" (input datetime-local) nel fuso della struttura → ISO UTC. */
function localToIso(v: string | undefined, tz: string): string | null | "invalid" {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return "invalid";
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz).toISOString();
}

// ---------------------------------------------------------------------------
// Attrezzature
// ---------------------------------------------------------------------------
const equipmentSchema = z
  .object({
    name: z.string().trim().min(1, "Inserisci il nome").max(80),
    kind: z.enum(["frigorifero", "congelatore", "abbattitore", "cella", "vetrina", "altro"]),
    min_temp: dec("Temperatura minima non valida").pipe(z.number().min(-60).max(100)),
    max_temp: dec("Temperatura massima non valida").pipe(z.number().min(-60).max(100)),
    department_id: z
      .string()
      .optional()
      .transform((v) => (v && uuid.safeParse(v).success ? v : null)),
    sort: z.coerce.number().int().min(0).max(999).default(0),
  })
  .refine((v) => v.min_temp < v.max_temp, { message: "La minima deve essere inferiore alla massima" });

export async function createEquipment(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = equipmentSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("haccp_equipment").insert({ org_id: ctx.org.id, facility_id: ctx.facility.id, ...parsed.data });
  if (error) return { error: error.code === "23505" ? "Esiste già un'attrezzatura con questo nome." : humanError(error) };
  revalidatePath(BASE, "layout");
  return { ok: true, message: `«${parsed.data.name}» aggiunto.` };
}

export async function updateEquipment(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const parsed = equipmentSchema.safeParse(Object.fromEntries(data));
  if (!id.success) return { error: "Attrezzatura non valida" };
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("haccp_equipment")
    .update({ ...parsed.data, active: data.get("active") === "on" }, { count: "exact" })
    .eq("id", id.data);
  if (error) return { error: error.code === "23505" ? "Esiste già un'attrezzatura con questo nome." : humanError(error) };
  if (count === 0) return { error: "Non hai i permessi per modificare le attrezzature." };
  revalidatePath(BASE, "layout");
  return { ok: true, message: "Attrezzatura aggiornata." };
}

// ---------------------------------------------------------------------------
// Temperature: giro di rilevazione (più attrezzature in un invio)
// ---------------------------------------------------------------------------
export async function recordTemperatures(_: ActionState, data: FormData): Promise<ActionState> {
  const ids = data.getAll("equipment_id").map(String);
  const values = data.getAll("value").map(String);
  const actions = data.getAll("corrective_action").map(String);
  const rows = ids
    .map((id, i) => ({ id, raw: (values[i] ?? "").replace(",", ".").trim(), action: (actions[i] ?? "").trim() }))
    .filter((r) => r.raw !== "");
  if (rows.length === 0) return { error: "Inserisci almeno una temperatura" };
  for (const r of rows) {
    if (!uuid.safeParse(r.id).success) return { error: "Attrezzatura non valida" };
    const v = Number(r.raw);
    if (!Number.isFinite(v) || v < -60 || v > 120) return { error: `Temperatura non valida: ${r.raw}` };
    if (r.action.length > 500) return { error: "L'azione correttiva è troppo lunga (max 500 caratteri)" };
  }
  const supabase = await createClient();
  let out = 0;
  for (const r of rows) {
    const { data: log, error } = await supabase.rpc("haccp_record_temperature", {
      p_equipment: r.id,
      p_value: Number(r.raw),
      p_corrective_action: r.action || null,
      p_note: null,
    });
    if (error) return { error: humanError(error) };
    if ((log as { out_of_range?: boolean } | null)?.out_of_range) out++;
  }
  revalidatePath(BASE, "layout");
  return out > 0
    ? { ok: true, message: `${rows.length} rilevazioni registrate: ${out} fuori range. Registra l'azione correttiva se non l'hai già fatto.` }
    : { ok: true, message: `${rows.length} rilevazioni registrate, tutte nei limiti.` };
}

export async function setCorrectiveAction(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = z
    .object({ id: uuid, action: z.string().trim().min(3, "Descrivi l'azione correttiva").max(500) })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("haccp_set_corrective_action", { p_log: parsed.data.id, p_action: parsed.data.action });
  if (error) return { error: humanError(error) };
  revalidatePath(BASE, "layout");
  return { ok: true, message: "Azione correttiva registrata." };
}

// ---------------------------------------------------------------------------
// Etichette
// ---------------------------------------------------------------------------
const labelSchema = z.object({
  kind: z.enum(["preparazione", "apertura"]),
  subject: z.string().optional(),
  name: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => v || null),
  quantity: z
    .string()
    .trim()
    .max(60)
    .optional()
    .transform((v) => v || null),
  shelf_life_days: dec("Durata non valida").pipe(z.number().min(0, "Durata non valida").max(730, "Massimo 730 giorni")),
  prepared_at: z.string().optional(),
  opened_at: z.string().optional(),
  storage: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || null),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
});

export async function createLabel(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = labelSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const tz = ctx.facility.timezone;

  let menuItem: string | null = null;
  let product: string | null = null;
  const [type, sid] = (d.subject ?? "").split(":");
  if (type === "item" && uuid.safeParse(sid).success) menuItem = sid!;
  else if (type === "product" && uuid.safeParse(sid).success) product = sid!;
  if (!menuItem && !product && !d.name) return { error: "Scegli cosa etichettare o scrivi il nome della preparazione" };

  const prepared = localToIso(d.prepared_at, tz);
  const opened = localToIso(d.opened_at, tz);
  if (prepared === "invalid" || opened === "invalid") return { error: "Data e ora non valide" };

  // Lotti di origine: "product_id|lotto|scadenza" (selezionati) + lotto scritto a mano
  const sourceLots: { product_id?: string; product_name?: string; lot: string; expires_on?: string | null }[] = [];
  for (const raw of data.getAll("source_lot").map(String)) {
    const [pid, lot, exp, pname] = raw.split("|");
    if (!lot) continue;
    sourceLots.push({
      ...(pid && uuid.safeParse(pid).success ? { product_id: pid } : {}),
      ...(pname ? { product_name: pname.slice(0, 120) } : {}),
      lot: lot.slice(0, 60),
      expires_on: exp && /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : null,
    });
  }
  const manualLot = String(data.get("manual_lot") ?? "").trim();
  if (manualLot) {
    const manualExp = String(data.get("manual_lot_expires") ?? "").trim();
    sourceLots.push({ lot: manualLot.slice(0, 60), expires_on: /^\d{4}-\d{2}-\d{2}$/.test(manualExp) ? manualExp : null });
  }
  if (sourceLots.length > 30) return { error: "Troppi lotti di origine (massimo 30)" };

  const supabase = await createClient();
  const { data: label, error } = await supabase.rpc("haccp_create_label", {
    p_facility: ctx.facility.id,
    p_kind: d.kind,
    p_shelf_life_days: d.shelf_life_days,
    p_menu_item: menuItem,
    p_product: product,
    p_name: d.name,
    p_prepared_at: prepared,
    p_opened_at: opened,
    p_storage: d.storage,
    // con JavaScript la scelta è esplicita (anche nessun allergene); senza, il database eredita quelli della voce/prodotto
    p_allergens: data.get("allergens_explicit") ? normalizeAllergens(data.getAll("allergens").map(String)) : null,
    p_source_lots: sourceLots,
    p_quantity: d.quantity,
    p_note: d.note,
  });
  if (error) return { error: humanError(error) };
  revalidatePath(BASE, "layout");
  const id = (label as { id: string }).id;
  redirect(`${BASE}/etichette/${id}?stampa=1`);
}

export async function closeLabel(data: FormData) {
  const id = uuid.safeParse(data.get("id"));
  const status = z.enum(["consumata", "scartata"]).safeParse(data.get("status"));
  if (!id.success || !status.success) return;
  const supabase = await createClient();
  await supabase.rpc("haccp_close_label", { p_label: id.data, p_status: status.data });
  revalidatePath(BASE, "layout");
}
