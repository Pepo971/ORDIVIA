"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const num = (msg: string) => z.coerce.number({ message: msg }).finite(msg);

// ---------------------------------------------------------------------------
// Fornitori
// ---------------------------------------------------------------------------
const supplierSchema = z.object({
  name: z.string().trim().min(1, "Inserisci il nome del fornitore").max(160),
  contact_name: z.string().trim().max(120).optional().transform((v) => v || null),
  email: z.union([z.literal(""), z.string().trim().email("Email non valida")]).transform((v) => v || null),
  phone: z.string().trim().max(40).optional().transform((v) => v || null),
  order_channel: z.enum(["email", "whatsapp", "telefono", "portale"]),
  delivery_weekdays: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Scegli almeno un giorno di consegna"),
  cutoff_time: z.string().regex(/^\d{2}:\d{2}$/, "Ora limite non valida"),
  lead_days: z.coerce.number().int().min(0).max(30),
  min_order_amount: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(2000).optional().transform((v) => v || null),
});

function readSupplier(data: FormData) {
  return supplierSchema.safeParse({
    ...Object.fromEntries(data),
    delivery_weekdays: data.getAll("delivery_weekdays"),
  });
}

export async function createSupplier(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = readSupplier(data);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data: row, error } = await supabase.from("suppliers").insert({ ...parsed.data, org_id: ctx.org.id }).select("id").single();
  if (error) return { error: humanError(error) };
  redirect(`/acquisti/fornitori/${row.id}?nuovo=1`);
}

export async function updateSupplier(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const parsed = readSupplier(data);
  if (!id.success) return { error: "Fornitore non valido" };
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("suppliers").update({ ...parsed.data, active: data.get("active") === "on" }).eq("id", id.data);
  if (error) return { error: humanError(error) };
  revalidatePath(`/acquisti/fornitori/${id.data}`);
  return { ok: true, message: "Fornitore aggiornato." };
}

// Riga di listino: prodotto esistente o nuovo (creato al volo).
const offerSchema = z.object({
  supplier_id: uuid,
  product_id: z.string().optional(),
  new_product_name: z.string().trim().max(160).optional(),
  new_product_unit: z.enum(["pz", "kg", "g", "l", "ml"]).optional(),
  supplier_code: z.string().trim().max(60).optional().transform((v) => v || null),
  pack_label: z.string().trim().min(1, "Descrivi la confezione (es. cassa 6 bottiglie)").max(80),
  pack_qty: num("Quantità per confezione non valida").positive("La confezione deve contenere almeno una unità"),
  price: num("Prezzo non valido").min(0, "Prezzo non valido"),
  vat_rate: z.coerce.number().min(0).max(30).default(22),
  preferred: z.literal("on").optional(),
});

export async function addOffer(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = offerSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  const supabase = await createClient();

  let productId = d.product_id && d.product_id !== "__new" ? d.product_id : null;
  if (!productId) {
    if (!d.new_product_name) return { error: "Scegli un prodotto o inserisci il nome di un nuovo prodotto" };
    const { data: p, error } = await supabase
      .from("products")
      .insert({ org_id: ctx.org.id, name: d.new_product_name, base_unit: d.new_product_unit ?? "pz" })
      .select("id")
      .single();
    if (error) return { error: error.code === "23505" ? "Esiste già un prodotto con questo nome: selezionalo dall'elenco." : humanError(error) };
    productId = p.id;
  }

  if (d.preferred) {
    await supabase.from("supplier_products").update({ preferred: false }).eq("org_id", ctx.org.id).eq("product_id", productId!);
  }
  const { error } = await supabase.from("supplier_products").insert({
    org_id: ctx.org.id,
    supplier_id: d.supplier_id,
    product_id: productId!,
    supplier_code: d.supplier_code,
    pack_label: d.pack_label,
    pack_qty: d.pack_qty,
    price: d.price,
    vat_rate: d.vat_rate,
    preferred: !!d.preferred,
  });
  if (error) return { error: error.code === "23505" ? "Questo prodotto con questa confezione è già a listino." : humanError(error) };
  revalidatePath(`/acquisti/fornitori/${d.supplier_id}`);
  return { ok: true, message: "Aggiunto al listino." };
}

export async function updateOfferPrice(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("id"));
  const price = num("Prezzo non valido").min(0).safeParse(data.get("price"));
  if (!id.success || !price.success) return { error: "Prezzo non valido" };
  const supabase = await createClient();
  const { data: row, error } = await supabase.from("supplier_products").update({ price: price.data }).eq("id", id.data).select("supplier_id").single();
  if (error) return { error: humanError(error) };
  revalidatePath(`/acquisti/fornitori/${row.supplier_id}`);
  return { ok: true, message: "Prezzo aggiornato e storicizzato." };
}

export async function removeOffer(data: FormData) {
  const id = uuid.parse(data.get("id"));
  const supabase = await createClient();
  const { data: row } = await supabase.from("supplier_products").delete().eq("id", id).select("supplier_id").single();
  if (row) revalidatePath(`/acquisti/fornitori/${row.supplier_id}`);
}

// ---------------------------------------------------------------------------
// Richieste d'acquisto
// ---------------------------------------------------------------------------
const requestSchema = z.object({
  department_id: z.string().optional().transform((v) => v || null),
  note: z.string().trim().max(1000).optional().transform((v) => v || null),
  needed_by: z.string().optional().transform((v) => v || null),
  lines: z
    .array(z.object({ product_id: uuid, qty: num("Quantità non valida").positive("Quantità non valida") }))
    .min(1, "Aggiungi almeno un prodotto"),
});

export async function createRequest(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const lines = data
    .getAll("line_product")
    .map((p, i) => ({ product_id: String(p), qty: data.getAll("line_qty")[i] }))
    .filter((l) => l.product_id && l.qty !== "" && l.qty != null);
  const parsed = requestSchema.safeParse({ department_id: data.get("department_id"), note: data.get("note"), needed_by: data.get("needed_by"), lines });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data: req, error } = await supabase
    .from("purchase_requests")
    .insert({
      org_id: ctx.org.id,
      facility_id: ctx.facility.id,
      department_id: parsed.data.department_id,
      note: parsed.data.note,
      needed_by: parsed.data.needed_by,
      status: "bozza",
      requested_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { error: humanError(error) };
  const merged = new Map<string, number>();
  for (const l of parsed.data.lines) merged.set(l.product_id, (merged.get(l.product_id) ?? 0) + l.qty);
  const { error: e2 } = await supabase
    .from("purchase_request_lines")
    .insert([...merged].map(([product_id, qty]) => ({ org_id: ctx.org.id, request_id: req.id, product_id, qty })));
  if (e2) {
    await supabase.from("purchase_requests").delete().eq("id", req.id);
    return { error: humanError(e2) };
  }
  const { error: e3 } = await supabase.from("purchase_requests").update({ status: "inviata" }).eq("id", req.id);
  if (e3) return { error: humanError(e3) };
  revalidatePath("/acquisti");
  redirect("/acquisti?tab=richieste&inviata=1");
}

export async function convertRequests(_: ActionState, data: FormData): Promise<ActionState> {
  const ids = data.getAll("request_id").map(String).filter((v) => uuid.safeParse(v).success);
  if (ids.length === 0) return { error: "Seleziona almeno una richiesta" };
  const supabase = await createClient();
  const { data: orders, error } = await supabase.rpc("orders_from_requests", { p_requests: ids });
  if (error) return { error: humanError(error) };
  revalidatePath("/acquisti");
  const list = (orders ?? []) as string[];
  if (list.length === 1) redirect(`/acquisti/ordini/${list[0]}`);
  redirect("/acquisti?tab=ordini&creati=" + list.length);
}

export async function rejectRequest(data: FormData) {
  const id = uuid.parse(data.get("id"));
  const ctx = await getContext();
  const supabase = await createClient();
  await supabase.from("purchase_requests").update({ status: "rifiutata", decided_by: ctx.userId, decided_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/acquisti");
}

// ---------------------------------------------------------------------------
// Ordini
// ---------------------------------------------------------------------------
/** Crea un ordine in bozza da un riordino suggerito (righe = offerte del fornitore con numero di confezioni). */
export async function createOrderFromReorder(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const supplier = uuid.safeParse(data.get("supplier_id"));
  if (!supplier.success) return { error: "Fornitore non valido" };
  const offerIds = data.getAll("offer_id").map(String);
  const packs = data.getAll("packs").map((v) => Number(v));
  const chosen = offerIds.map((id, i) => ({ id, packs: packs[i] ?? 0 })).filter((l) => uuid.safeParse(l.id).success && l.packs > 0);
  if (chosen.length === 0) return { error: "Indica almeno una quantità da ordinare" };

  const supabase = await createClient();
  const { data: offers, error: e0 } = await supabase
    .from("supplier_products")
    .select("id, product_id, pack_label, pack_qty, price, supplier_id")
    .in("id", chosen.map((c) => c.id));
  if (e0) return { error: humanError(e0) };
  if (!offers || offers.some((o) => o.supplier_id !== supplier.data)) return { error: "Le righe devono appartenere allo stesso fornitore" };

  const warehouse = data.get("warehouse_id") ? String(data.get("warehouse_id")) : null;
  const { data: po, error } = await supabase
    .from("purchase_orders")
    .insert({
      org_id: ctx.org.id,
      facility_id: ctx.facility.id,
      supplier_id: supplier.data,
      status: "bozza",
      expected_delivery: (data.get("expected_delivery") as string) || null,
      delivery_warehouse_id: warehouse,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { error: humanError(error) };
  const { error: e2 } = await supabase.from("purchase_order_lines").insert(
    chosen.map((c) => {
      const o = offers.find((x) => x.id === c.id)!;
      return { org_id: ctx.org.id, order_id: po.id, product_id: o.product_id, supplier_product_id: o.id, pack_label: o.pack_label, pack_qty: o.pack_qty, qty_packs: c.packs, unit_price: o.price };
    }),
  );
  if (e2) {
    await supabase.from("purchase_orders").delete().eq("id", po.id);
    return { error: humanError(e2) };
  }
  redirect(`/acquisti/ordini/${po.id}`);
}

export async function saveOrderDraft(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("order_id"));
  if (!id.success) return { error: "Ordine non valido" };
  const supabase = await createClient();
  const lineIds = data.getAll("line_id").map(String);
  const qtys = data.getAll("line_packs").map((v) => Number(v));
  for (let i = 0; i < lineIds.length; i++) {
    const q = qtys[i] ?? 0;
    const lid = lineIds[i]!;
    const res = q > 0
      ? await supabase.from("purchase_order_lines").update({ qty_packs: q }).eq("id", lid).eq("order_id", id.data).select("id")
      : await supabase.from("purchase_order_lines").delete().eq("id", lid).eq("order_id", id.data).select("id");
    if (res.error) return { error: humanError(res.error) };
    if (!res.data?.length) return { error: "L'ordine non è più modificabile (forse è già stato approvato)." };
  }
  const addOffer = String(data.get("add_offer_id") ?? "");
  const addPacks = Number(data.get("add_packs") ?? 0);
  if (uuid.safeParse(addOffer).success && addPacks > 0) {
    const { data: o } = await supabase.from("supplier_products").select("id, org_id, product_id, pack_label, pack_qty, price").eq("id", addOffer).single();
    if (o) {
      const { error } = await supabase.from("purchase_order_lines").insert({
        org_id: o.org_id, order_id: id.data, product_id: o.product_id, supplier_product_id: o.id, pack_label: o.pack_label, pack_qty: o.pack_qty, qty_packs: addPacks, unit_price: o.price,
      });
      if (error) return { error: humanError(error) };
    }
  }
  const { error } = await supabase
    .from("purchase_orders")
    .update({
      expected_delivery: (data.get("expected_delivery") as string) || null,
      delivery_warehouse_id: (data.get("warehouse_id") as string) || null,
      note: ((data.get("note") as string) || "").trim() || null,
    })
    .eq("id", id.data);
  if (error) return { error: humanError(error) };
  revalidatePath(`/acquisti/ordini/${id.data}`);
  return { ok: true, message: "Bozza salvata." };
}

export async function transitionOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("order_id"));
  const to = z.enum(["approvato", "inviato", "bozza", "annullato"]).safeParse(data.get("to"));
  if (!id.success || !to.success) return { error: "Operazione non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("po_transition", { p_order: id.data, p_to: to.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/acquisti/ordini/${id.data}`);
  revalidatePath("/oggi");
  const msg = { approvato: "Ordine approvato.", inviato: "Ordine segnato come inviato.", bozza: "Ordine riportato in bozza.", annullato: "Ordine annullato." }[to.data];
  return { ok: true, message: msg };
}

export async function deleteDraftOrder(data: FormData) {
  const id = uuid.parse(data.get("order_id"));
  const supabase = await createClient();
  await supabase.from("purchase_orders").delete().eq("id", id).eq("status", "bozza");
  redirect("/acquisti");
}

// ---------------------------------------------------------------------------
// Ricezione
// ---------------------------------------------------------------------------
export async function startReceipt(_: ActionState, data: FormData): Promise<ActionState> {
  const order = uuid.safeParse(data.get("order_id"));
  const wh = uuid.safeParse(data.get("warehouse_id"));
  if (!order.success) return { error: "Ordine non valido" };
  if (!wh.success) return { error: "Scegli il magazzino in cui scaricare la merce" };
  const supabase = await createClient();
  const { data: rc, error } = await supabase.rpc("start_receipt", { p_order: order.data, p_warehouse: wh.data });
  if (error) return { error: humanError(error) };
  redirect(`/acquisti/ricezione/${rc}`);
}

export async function saveReceipt(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("receipt_id"));
  if (!id.success) return { error: "Ricezione non valida" };
  const confirm = data.get("intent") === "confirm";
  const supabase = await createClient();

  const lineIds = data.getAll("line_id").map(String);
  const get = (k: string) => data.getAll(k).map(String);
  const [packs, prices, lots, exps, issues] = [get("qty_packs"), get("unit_price"), get("lot"), get("expires_on"), get("issue")];
  for (let i = 0; i < lineIds.length; i++) {
    const q = Number(packs[i]);
    if (!Number.isFinite(q) || q < 0) return { error: "Quantità ricevuta non valida" };
    const price = prices[i] ? Number(String(prices[i]).replace(",", ".")) : null;
    if (price != null && (!Number.isFinite(price) || price < 0)) return { error: "Prezzo non valido" };
    const { error } = await supabase
      .from("receipt_lines")
      .update({ qty_packs: q, unit_price: price, lot: lots[i] || null, expires_on: exps[i] || null, issue: issues[i] || null })
      .eq("id", lineIds[i]!)
      .eq("receipt_id", id.data);
    if (error) return { error: humanError(error) };
  }
  const { error } = await supabase
    .from("receipts")
    .update({
      doc_type: (data.get("doc_type") as string) || "ddt",
      doc_number: ((data.get("doc_number") as string) || "").trim() || null,
      doc_date: (data.get("doc_date") as string) || null,
      note: ((data.get("note") as string) || "").trim() || null,
    })
    .eq("id", id.data);
  if (error) return { error: humanError(error) };

  if (confirm) {
    const { data: rc, error: e2 } = await supabase.rpc("confirm_receipt", { p_receipt: id.data });
    if (e2) return { error: humanError(e2) };
    revalidatePath("/oggi");
    revalidatePath("/scorte");
    const order = (rc as { order_id: string | null } | null)?.order_id;
    redirect(order ? `/acquisti/ordini/${order}?ricevuto=1` : "/scorte");
  }
  revalidatePath(`/acquisti/ricezione/${id.data}`);
  return { ok: true, message: "Spunta salvata. Conferma quando hai controllato tutto." };
}
