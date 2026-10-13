"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const qty = z.coerce.number({ message: "Quantità non valida" }).finite().positive("La quantità deve essere maggiore di zero");

export async function recordMovement(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      warehouse_id: uuid,
      product_id: uuid,
      kind: z.enum(["scarico", "spreco", "reso", "scaduto", "trasferimento", "carico"]),
      qty,
      to_warehouse_id: z.string().optional(),
      unit_cost: z.string().optional(),
      note: z.string().trim().max(500).optional(),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dati non validi" };
  const d = parsed.data;
  const supabase = await createClient();

  if (d.kind === "trasferimento") {
    if (!d.to_warehouse_id || !uuid.safeParse(d.to_warehouse_id).success) return { error: "Scegli il magazzino di destinazione" };
    const { error } = await supabase.rpc("transfer_stock", { p_from: d.warehouse_id, p_to: d.to_warehouse_id, p_product: d.product_id, p_qty: d.qty, p_note: d.note || null });
    if (error) return { error: humanError(error) };
  } else if (d.kind === "carico") {
    const cost = d.unit_cost ? Number(d.unit_cost.replace(",", ".")) : null;
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return { error: "Costo non valido" };
    const { error } = await supabase.rpc("manual_load", { p_warehouse: d.warehouse_id, p_product: d.product_id, p_qty: d.qty, p_unit_cost: cost, p_note: d.note || null });
    if (error) return { error: humanError(error) };
  } else {
    const { error } = await supabase.from("stock_movements").insert({
      org_id: ctx.org.id,
      warehouse_id: d.warehouse_id,
      product_id: d.product_id,
      qty: d.qty,
      kind: d.kind,
      note: d.note || null,
      created_by: ctx.userId,
      facility_id: ctx.facility.id, // sovrascritto dal trigger con la struttura del magazzino
    });
    if (error) return { error: humanError(error) };
  }
  revalidatePath("/scorte");
  return { ok: true, message: "Movimento registrato." };
}

export async function applyCount(_: ActionState, data: FormData): Promise<ActionState> {
  const wh = uuid.safeParse(data.get("warehouse_id"));
  if (!wh.success) return { error: "Magazzino non valido" };
  const ids = data.getAll("product_id").map(String);
  const vals = data.getAll("counted").map(String);
  const counts = ids
    .map((id, i) => ({ product_id: id, raw: vals[i] ?? "" }))
    .filter((c) => c.raw.trim() !== "")
    .map((c) => ({ product_id: c.product_id, qty: Number(c.raw.replace(",", ".")) }));
  if (counts.length === 0) return { error: "Inserisci almeno una quantità contata" };
  if (counts.some((c) => !Number.isFinite(c.qty) || c.qty < 0)) return { error: "Le quantità contate devono essere numeri non negativi" };
  const supabase = await createClient();
  const { data: n, error } = await supabase.rpc("apply_inventory_count", { p_warehouse: wh.data, p_counts: counts });
  if (error) return { error: humanError(error) };
  revalidatePath("/scorte");
  return { ok: true, message: n === 0 ? `Conta registrata: nessuna differenza su ${counts.length} prodotti.` : `Conta registrata: ${n} rettifiche su ${counts.length} prodotti contati.` };
}

export async function createProduct(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      name: z.string().trim().min(1, "Inserisci il nome").max(160),
      base_unit: z.enum(["pz", "kg", "g", "l", "ml"]),
      warehouse_id: z.string().optional(),
      min_qty: z.string().optional(),
      par_qty: z.string().optional(),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data: p, error } = await supabase.from("products").insert({ org_id: ctx.org.id, name: parsed.data.name, base_unit: parsed.data.base_unit }).select("id").single();
  if (error) return { error: error.code === "23505" ? "Esiste già un prodotto con questo nome." : humanError(error) };
  const min = Number(parsed.data.min_qty || 0);
  const par = Number(parsed.data.par_qty || 0);
  if (parsed.data.warehouse_id && uuid.safeParse(parsed.data.warehouse_id).success && (min > 0 || par > 0)) {
    const { error: e2 } = await supabase
      .from("stock_settings")
      .upsert({ org_id: ctx.org.id, warehouse_id: parsed.data.warehouse_id, product_id: p.id, min_qty: min, par_qty: Math.max(par, min) });
    if (e2) return { error: humanError(e2) };
  }
  revalidatePath("/scorte");
  return { ok: true, message: `${parsed.data.name} aggiunto.` };
}

export async function saveStockSettings(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const wh = uuid.safeParse(data.get("warehouse_id"));
  if (!wh.success) return { error: "Magazzino non valido" };
  const ids = data.getAll("product_id").map(String);
  const mins = data.getAll("min_qty").map(String);
  const pars = data.getAll("par_qty").map(String);
  const rows = ids
    .map((id, i) => ({ product_id: id, min: Number(mins[i] || 0), par: Number(pars[i] || 0) }))
    .filter((r) => uuid.safeParse(r.product_id).success);
  if (rows.some((r) => !Number.isFinite(r.min) || !Number.isFinite(r.par) || r.min < 0 || r.par < 0)) return { error: "Valori non validi" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("stock_settings")
    .upsert(rows.map((r) => ({ org_id: ctx.org.id, warehouse_id: wh.data, product_id: r.product_id, min_qty: r.min, par_qty: Math.max(r.par, r.min) })));
  if (error) return { error: humanError(error) };
  revalidatePath("/scorte");
  return { ok: true, message: "Scorte minime aggiornate." };
}

export async function goToWarehouse(data: FormData) {
  const id = String(data.get("warehouse_id") ?? "");
  const path = String(data.get("path") ?? "/scorte");
  redirect(`${path.startsWith("/scorte") ? path : "/scorte"}?magazzino=${encodeURIComponent(id)}`);
}
