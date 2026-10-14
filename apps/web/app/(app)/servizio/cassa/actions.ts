"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();
const money = (msg: string) =>
  z.preprocess((v) => (typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).finite(msg).min(0, msg).max(100000, msg));
const optMoney = (msg: string) =>
  z.preprocess((v) => (v === "" || v == null ? undefined : typeof v === "string" ? v.replace(",", ".").trim() : v), z.coerce.number({ message: msg }).finite(msg).min(0, msg).max(100000, msg).optional());

// ---------------------------------------------------------------------------
// Pagamenti
// ---------------------------------------------------------------------------
const paySchema = z.object({
  order_id: uuid,
  method: z.enum(["contanti", "carta", "altro"]),
  amount: optMoney("Importo non valido"),
  tendered: optMoney("Contante ricevuto non valido"),
  label: z.string().trim().max(80).optional().transform((v) => v || null),
});

export async function addPayment(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = paySchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const lineIds = z.array(uuid).safeParse(data.getAll("line_id"));
  if (!lineIds.success) return { error: "Piatti non validi" };
  const d = parsed.data;
  if (lineIds.data.length === 0 && !(d.amount && d.amount > 0)) return { error: "Indica l'importo o scegli i piatti" };
  const supabase = await createClient();
  const { data: p, error } = await supabase.rpc("pos_add_payment", {
    p_order: d.order_id,
    p_method: d.method,
    p_amount: lineIds.data.length ? null : d.amount,
    p_tendered: d.method === "contanti" ? (d.tendered ?? null) : null,
    p_line_ids: lineIds.data.length ? lineIds.data : null,
    p_label: d.label,
  });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/cassa/${d.order_id}`);
  const pay = p as { amount: number; change_given: number } | null;
  const change = Number(pay?.change_given ?? 0);
  const amount = Number(pay?.amount ?? 0).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
  return {
    ok: true,
    message: change > 0 ? `Incassati ${amount}. Resto da dare: ${change.toLocaleString("it-IT", { style: "currency", currency: "EUR" })}.` : `Incassati ${amount}.`,
  };
}

export async function closeOrder(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("order_id"));
  if (!id.success) return { error: "Comanda non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_close_order", { p_order: id.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio", "layout");
  redirect(`/servizio/cassa/${id.data}?chiusa=1`);
}

export async function markFiscalized(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("order_id"));
  if (!id.success) return { error: "Comanda non valida" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_mark_fiscalized", { p_order: id.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/cassa/${id.data}`);
  return { ok: true, message: "Segnato: scontrino emesso dal registratore telematico." };
}

// ---------------------------------------------------------------------------
// Sconti e annullamenti (responsabile)
// ---------------------------------------------------------------------------
const discountSchema = z.object({
  order_id: uuid,
  kind: z.enum(["percentuale", "importo", "nessuno"]),
  value: optMoney("Valore non valido"),
  reason: z.string().trim().max(300).optional().transform((v) => v || ""),
});

export async function setDiscount(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = discountSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (d.kind !== "nessuno") {
    if (!d.value || d.value <= 0) return { error: "Indica il valore dello sconto" };
    if (d.kind === "percentuale" && d.value > 100) return { error: "La percentuale non può superare 100" };
    if (d.reason.length < 3) return { error: "Indica il motivo dello sconto" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_discount", {
    p_order: d.order_id,
    p_kind: d.kind === "nessuno" ? null : d.kind,
    p_value: d.kind === "nessuno" ? 0 : d.value,
    p_reason: d.reason,
  });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/cassa/${d.order_id}`);
  return { ok: true, message: d.kind === "nessuno" ? "Sconto tolto." : "Sconto applicato." };
}

export async function voidLine(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("line_id"));
  const order = uuid.safeParse(data.get("order_id"));
  const reason = z.string().trim().min(3, "Indica il motivo dell'annullamento").max(300).safeParse(data.get("reason") ?? "");
  if (!id.success || !order.success) return { error: "Riga non valida" };
  if (!reason.success) return { error: reason.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_line_status", { p_line: id.data, p_to: "annullata", p_reason: reason.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/cassa/${order.data}`);
  return { ok: true, message: "Riga annullata." };
}

// ---------------------------------------------------------------------------
// Turno di cassa
// ---------------------------------------------------------------------------
export async function openCashSession(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const fl = money("Fondo cassa non valido").safeParse(data.get("float") ?? "0");
  if (!fl.success) return { error: fl.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_open_cash_session", { p_facility: ctx.facility.id, p_float: fl.data });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/cassa", "layout");
  return { ok: true, message: "Turno di cassa aperto." };
}

export async function closeCashSession(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("session_id"));
  const counted = money("Contante contato non valido").safeParse(data.get("counted"));
  const note = z.string().trim().max(1000).safeParse(data.get("note") ?? "");
  if (!id.success) return { error: "Turno non valido" };
  if (!counted.success || data.get("counted") === "") return { error: "Indica il contante contato nel cassetto" };
  const supabase = await createClient();
  const { data: s, error } = await supabase.rpc("pos_close_cash_session", {
    p_session: id.data,
    p_counted: counted.data,
    p_note: note.success ? note.data || null : null,
  });
  if (error) return { error: humanError(error) };
  revalidatePath("/servizio/cassa", "layout");
  redirect(`/servizio/cassa/turno?chiuso=${(s as { id: string }).id}`);
}

// ---------------------------------------------------------------------------
// Cliente CRM collegato al conto
// ---------------------------------------------------------------------------
export async function linkCustomer(_: ActionState, data: FormData): Promise<ActionState> {
  const order = uuid.safeParse(data.get("order_id"));
  const raw = data.get("customer_id");
  const customer = raw === "" || raw == null ? { success: true as const, data: null } : uuid.safeParse(raw);
  if (!order.success || !customer.success) return { error: "Cliente non valido" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("pos_set_order_customer", { p_order: order.data, p_customer: customer.data });
  if (error) return { error: humanError(error) };
  revalidatePath(`/servizio/cassa/${order.data}`);
  redirect(`/servizio/cassa/${order.data}`);
}
