"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cleanList, RESERVATION_SOURCES, RESERVATION_STATUSES, SERVICE_KINDS } from "@ordivia/domain";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const BASE = "/ospiti/prenotazioni";
function refresh() {
  revalidatePath(BASE, "layout");
}

const uuid = z.string().uuid();
const optUuid = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v == null || z.string().uuid().safeParse(v).success, "Valore non valido");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida");
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Orario non valido (HH:MM)");
const optText = (max: number) => z.string().trim().max(max, `Massimo ${max} caratteri`).optional().transform((v) => v || null);
const optMoney = z
  .string()
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? null : Number(v.replace(",", "."))))
  .refine((v) => v == null || (Number.isFinite(v) && v >= 0 && v <= 100000), "Importo non valido");
const party = z.coerce.number({ message: "Numero di persone non valido" }).int("Numero di persone non valido").min(1, "Almeno 1 persona").max(500, "Numero di persone non valido");
const optEmail = z.union([z.literal(""), z.string().trim().email("Email non valida").max(160)]).optional().transform((v) => v || null);
const allergiesField = z.string().max(600).optional().transform((v) => cleanList(v ?? ""));

// ---------------------------------------------------------------------------
// Prenotazioni
// ---------------------------------------------------------------------------
const createSchema = z.object({
  service_id: uuid,
  res_date: isoDate,
  res_time: hm,
  party_size: party,
  customer_id: optUuid,
  name: optText(120),
  phone: optText(40),
  email: optEmail,
  source: z.enum(RESERVATION_SOURCES),
  status: z.enum(["in_attesa_conferma", "confermata", "arrivata"]).default("confermata"),
  notes: optText(1000),
  special_requests: optText(1000),
  allergies: allergiesField,
  table_id: optUuid,
  deposit: optMoney,
  back: z.enum(["giorno", "scheda"]).optional(),
});

export async function createReservation(_: ActionState, data: FormData): Promise<ActionState> {
  await getContext();
  const parsed = createSchema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const d = parsed.data;
  if (!d.customer_id && d.source !== "walk-in" && !d.name) return { error: "Inserisci il nome del cliente" };
  if (!d.customer_id && d.source !== "walk-in" && !d.phone && !d.email) return { error: "Inserisci telefono o email del cliente" };
  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("res_create", {
    p_service: d.service_id,
    p_date: d.res_date,
    p_time: d.res_time,
    p_party: d.party_size,
    p_customer: d.customer_id,
    p_name: d.name,
    p_phone: d.phone,
    p_email: d.email,
    p_source: d.source,
    p_status: d.status,
    p_notes: d.notes,
    p_special: d.special_requests,
    p_allergies: d.allergies,
    p_point: d.table_id,
    p_deposit: d.deposit,
  });
  if (error) return { error: humanError(error) };
  refresh();
  if (d.back === "giorno") return { ok: true, message: d.source === "walk-in" ? "Walk-in registrato." : "Prenotazione salvata." };
  redirect(`${BASE}/${id as string}?nuova=1`);
}

const statusSchema = z.object({ reservation_id: uuid, to: z.enum(RESERVATION_STATUSES), reason: optText(300) });
const STATUS_MSG: Record<string, string> = {
  confermata: "Confermata.",
  arrivata: "Arrivo registrato.",
  completata: "Tavolo chiuso.",
  no_show: "Segnato come non presentato.",
  annullata: "Prenotazione annullata.",
};

export async function setStatus(_: ActionState, data: FormData): Promise<ActionState> {
  const p = statusSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Dati non validi" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_set_status", { p_reservation: p.data.reservation_id, p_status: p.data.to, p_reason: p.data.reason });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: STATUS_MSG[p.data.to] ?? "Aggiornata." };
}

export async function assignTable(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ reservation_id: uuid, table_id: optUuid }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Dati non validi" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_assign_table", { p_reservation: p.data.reservation_id, p_point: p.data.table_id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: p.data.table_id ? "Tavolo assegnato." : "Tavolo tolto." };
}

const updateSchema = z.object({
  reservation_id: uuid,
  res_date: isoDate,
  res_time: hm,
  party_size: party,
  notes: optText(1000),
  special_requests: optText(1000),
  allergies: allergiesField,
  deposit: optMoney,
});

export async function updateReservation(_: ActionState, data: FormData): Promise<ActionState> {
  const p = updateSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_update", {
    p_reservation: d.reservation_id,
    p_date: d.res_date,
    p_time: d.res_time,
    p_party: d.party_size,
    p_notes: d.notes,
    p_special: d.special_requests,
    p_allergies: d.allergies,
    p_deposit: d.deposit,
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Prenotazione aggiornata." };
}

export async function setDepositPaid(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ reservation_id: uuid, paid: z.enum(["0", "1"]) }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: "Dati non validi" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_set_deposit_paid", { p_reservation: p.data.reservation_id, p_paid: p.data.paid === "1" });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: p.data.paid === "1" ? "Acconto segnato come ricevuto." : "Acconto da ricevere." };
}

export async function markReminded(data: FormData) {
  const ids = data.getAll("reservation_id").filter((v): v is string => typeof v === "string" && uuid.safeParse(v).success);
  if (ids.length === 0) return;
  const supabase = await createClient();
  await supabase.rpc("res_mark_reminded", { p_reservations: ids.slice(0, 500) });
  refresh();
}

// ---------------------------------------------------------------------------
// Lista d'attesa
// ---------------------------------------------------------------------------
const waitSchema = z.object({
  service_id: uuid,
  wait_date: isoDate,
  preferred_time: z.union([z.literal(""), hm]).optional().transform((v) => v || null),
  party_size: party,
  customer_id: optUuid,
  name: optText(120),
  phone: optText(40),
  email: optEmail,
  notes: optText(500),
  notify: z.literal("1").optional(),
});

export async function addToWaitlist(_: ActionState, data: FormData): Promise<ActionState> {
  const p = waitSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  if (!d.customer_id && (!d.name || (!d.phone && !d.email))) return { error: "Inserisci nome e telefono (o email) per poter avvisare il cliente" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_waitlist_add", {
    p_service: d.service_id,
    p_date: d.wait_date,
    p_party: d.party_size,
    p_time: d.preferred_time,
    p_customer: d.customer_id,
    p_name: d.name,
    p_phone: d.phone,
    p_email: d.email,
    p_notes: d.notes,
    p_notify: d.notify === "1",
  });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Aggiunto alla lista d'attesa." };
}

export async function promoteWaitlist(_: ActionState, data: FormData): Promise<ActionState> {
  const p = z.object({ entry_id: uuid, time: hm, table_id: optUuid }).safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.rpc("res_waitlist_promote", { p_entry: p.data.entry_id, p_time: p.data.time, p_point: p.data.table_id });
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Prenotazione confermata dalla lista d'attesa." };
}

export async function setWaitlistStatus(data: FormData) {
  const p = z.object({ entry_id: uuid, status: z.enum(["in_attesa", "avvisato", "annullata"]) }).safeParse(Object.fromEntries(data));
  if (!p.success) return;
  const supabase = await createClient();
  await supabase.rpc("res_waitlist_set", { p_entry: p.data.entry_id, p_status: p.data.status });
  refresh();
}

// ---------------------------------------------------------------------------
// Servizi prenotabili (configurazione, RLS: reservations.manage)
// ---------------------------------------------------------------------------
const serviceSchema = z
  .object({
    id: optUuid,
    name: z.string().trim().min(1, "Inserisci il nome del servizio").max(80),
    kind: z.enum(SERVICE_KINDS),
    description: optText(1000),
    capacity_unit: z.enum(["coperti", "posti"]),
    duration_min: z.coerce.number().int().min(10, "Durata minima 10 minuti").max(720, "Durata massima 12 ore"),
    max_party_size: z.coerce.number().int().min(1, "Gruppo massimo non valido").max(500, "Gruppo massimo non valido"),
    deposit_amount: optMoney,
    price_per_person: optMoney,
    cancellation_policy: optText(1000),
    booking_notice_min: z.coerce.number().int().min(0).max(10080, "Preavviso massimo 7 giorni"),
    event_date: z.union([z.literal(""), isoDate]).optional().transform((v) => v || null),
    event_time: z.union([z.literal(""), hm]).optional().transform((v) => v || null),
    event_capacity: z
      .string()
      .optional()
      .transform((v) => (v == null || v.trim() === "" ? null : Number(v)))
      .refine((v) => v == null || (Number.isInteger(v) && v >= 1 && v <= 5000), "Posti dell'evento non validi"),
    sort_order: z.coerce.number().int().min(0).max(999).default(0),
  })
  .refine((d) => (d.event_date == null) === (d.event_time == null) && (d.event_date == null) === (d.event_capacity == null), {
    message: "Per un evento a data unica indica data, ora e posti (oppure lascia vuoti tutti e tre).",
  });

export async function saveService(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const p = serviceSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const { id, ...rest } = p.data;
  const row = { ...rest, public_bookable: data.get("public_bookable") === "on", active: id ? data.get("active") === "on" : true };
  const supabase = await createClient();
  if (id) {
    const { error } = await supabase.from("reservation_services").update(row).eq("id", id).eq("facility_id", ctx.facility.id);
    if (error) return { error: humanError(error) };
    refresh();
    return { ok: true, message: "Servizio salvato." };
  }
  const { data: created, error } = await supabase
    .from("reservation_services")
    .insert({ ...row, org_id: ctx.org.id, facility_id: ctx.facility.id })
    .select("id")
    .single();
  if (error) return { error: humanError(error) };
  refresh();
  redirect(`${BASE}/servizi/${created.id}?nuovo=1`);
}

const slotSchema = z.object({
  service_id: uuid,
  weekdays: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Scegli almeno un giorno"),
  start_time: hm,
  end_time: hm,
  interval_min: z.coerce.number().int().min(5, "Intervallo minimo 5 minuti").max(240),
  capacity: z.coerce.number({ message: "Capacità non valida" }).int().min(1, "Capacità non valida").max(5000),
  max_party: z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? null : Number(v)))
    .refine((v) => v == null || (Number.isInteger(v) && v >= 1 && v <= 500), "Gruppo massimo non valido"),
});

export async function addSlots(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const p = slotSchema.safeParse({ ...Object.fromEntries(data), weekdays: data.getAll("weekdays") });
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  if (d.end_time < d.start_time) return { error: "L'ultimo arrivo è prima del primo" };
  const supabase = await createClient();
  const { error } = await supabase.from("reservation_slots").insert(
    [...new Set(d.weekdays)].map((weekday) => ({
      org_id: ctx.org.id,
      facility_id: ctx.facility.id,
      service_id: d.service_id,
      weekday,
      start_time: d.start_time,
      end_time: d.end_time,
      interval_min: d.interval_min,
      capacity: d.capacity,
      max_party: d.max_party,
    })),
  );
  if (error) return { error: humanError(error) };
  refresh();
  return { ok: true, message: "Orari aggiunti." };
}

export async function deleteSlot(data: FormData) {
  const id = uuid.safeParse(data.get("slot_id"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.from("reservation_slots").delete().eq("id", id.data);
  refresh();
}

const exceptionSchema = z.object({
  service_id: optUuid,
  on_date: isoDate,
  mode: z.enum(["chiuso", "capacita"]),
  capacity: z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? null : Number(v)))
    .refine((v) => v == null || (Number.isInteger(v) && v >= 1 && v <= 5000), "Capacità non valida"),
  note: optText(300),
});

export async function addException(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const p = exceptionSchema.safeParse(Object.fromEntries(data));
  if (!p.success) return { error: p.error.issues[0]?.message };
  const d = p.data;
  if (d.mode === "capacita" && (d.capacity == null || !d.service_id)) return { error: "Indica la capacità eccezionale per questo servizio" };
  const supabase = await createClient();
  const { error } = await supabase.from("reservation_exceptions").insert({
    org_id: ctx.org.id,
    facility_id: ctx.facility.id,
    service_id: d.service_id,
    on_date: d.on_date,
    closed: d.mode === "chiuso",
    capacity: d.mode === "capacita" ? d.capacity : null,
    note: d.note,
  });
  if (error) return { error: error.code === "23505" ? "Per quel giorno c'è già una data speciale." : humanError(error) };
  refresh();
  return { ok: true, message: d.mode === "chiuso" ? "Chiusura salvata." : "Capacità eccezionale salvata." };
}

export async function deleteException(data: FormData) {
  const id = uuid.safeParse(data.get("exception_id"));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.from("reservation_exceptions").delete().eq("id", id.data);
  refresh();
}
