import "server-only";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { createClient, supabaseEnv } from "./supabase/server";

// ---------------------------------------------------------------------------
// Lato pubblico (QR): client con la chiave anonima, SENZA sessione utente né cookie.
// Può solo eseguire le funzioni public_portal_* (nessuna tabella è leggibile da anon).
// ---------------------------------------------------------------------------
export function publicClient() {
  const { url, key } = supabaseEnv();
  return createPlainClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-ordivia-portal": "1" } },
  });
}

export const TOKEN_RE = /^[0-9a-f]{32}$/;

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  allergens: string[];
  sold_out: boolean;
}

export interface PublicPortal {
  enabled: boolean;
  facility: { name: string; timezone: string };
  point: { kind: string; label: string; zone: string | null } | null;
  settings: {
    welcome_it: string | null;
    welcome_en: string | null;
    accent: string;
    cover_url: string | null;
    hours_it: string | null;
    hours_en: string | null;
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    address: string | null;
    map_url: string | null;
    show_menu: boolean;
    show_order: boolean;
    show_booking: boolean;
    show_assistance: boolean;
    show_offers: boolean;
    show_info: boolean;
  };
  ordering: { allowed: boolean; reason: string | null; from: string | null; to: string | null };
  menu: { name: string; items: PublicMenuItem[] }[];
  offers: {
    title_it: string;
    title_en: string | null;
    description_it: string | null;
    description_en: string | null;
    price: number | null;
    valid_from: string | null;
    valid_to: string | null;
  }[];
  info: { title_it: string; title_en: string | null; body_it: string; body_en: string | null }[];
}

function normPortal(raw: unknown): PublicPortal {
  const p = raw as PublicPortal;
  return {
    ...p,
    menu: (p.menu ?? []).map((c) => ({
      name: c.name,
      items: (c.items ?? []).map((i) => ({ ...i, price: Number(i.price), allergens: i.allergens ?? [] })),
    })),
    offers: (p.offers ?? []).map((o) => ({ ...o, price: o.price == null ? null : Number(o.price) })),
    info: p.info ?? [],
  };
}

/** Portale di un punto di servizio; null se il token non è valido. */
export async function getPublicPoint(token: string): Promise<PublicPortal | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await publicClient().rpc("public_portal_point", { p_token: token });
  if (error || !data) return null;
  return normPortal(data);
}

/** Portale generico della struttura; null se il token non è valido. */
export async function getPublicFacility(token: string): Promise<PublicPortal | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await publicClient().rpc("public_portal_facility", { p_token: token });
  if (error || !data) return null;
  return normPortal(data);
}

export interface PublicOrderStatus {
  status: "da_confermare" | "accettato" | "rifiutato";
  total: number;
  created_at: string;
  lines: { name: string; qty: number; status: "da_confermare" | "confermata" | "annullata" }[];
}

export async function getPublicOrderStatus(token: string, reference: string): Promise<PublicOrderStatus | null> {
  if (!TOKEN_RE.test(token) || !/^[0-9a-f-]{36}$/.test(reference)) return null;
  const { data, error } = await publicClient().rpc("public_portal_order_status", { p_token: token, p_reference: reference });
  if (error || !data) return null;
  const s = data as PublicOrderStatus;
  return { ...s, total: Number(s.total) };
}

// ---------------------------------------------------------------------------
// Lato gestione (utente autenticato, RLS)
// ---------------------------------------------------------------------------
export interface PortalSettingsRow {
  enabled: boolean;
  display_name: string | null;
  welcome_it: string | null;
  welcome_en: string | null;
  accent: string;
  cover_url: string | null;
  hours_it: string | null;
  hours_en: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  address: string | null;
  map_url: string | null;
  show_menu: boolean;
  show_order: boolean;
  show_booking: boolean;
  show_assistance: boolean;
  show_offers: boolean;
  show_info: boolean;
  order_kinds: string[];
  order_from: string | null;
  order_to: string | null;
  updated_at: string | null;
}

export const DEFAULT_SETTINGS: PortalSettingsRow = {
  enabled: false,
  display_name: null,
  welcome_it: null,
  welcome_en: null,
  accent: "turchese",
  cover_url: null,
  hours_it: null,
  hours_en: null,
  phone: null,
  whatsapp: null,
  email: null,
  address: null,
  map_url: null,
  show_menu: true,
  show_order: true,
  show_booking: true,
  show_assistance: true,
  show_offers: true,
  show_info: true,
  order_kinds: ["tavolo", "ombrellone"],
  order_from: null,
  order_to: null,
  updated_at: null,
};

export interface PortalOffer {
  id: string;
  title_it: string;
  title_en: string | null;
  description_it: string | null;
  description_en: string | null;
  price: number | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  sort: number;
}

export interface PortalInfoBlock {
  id: string;
  title_it: string;
  title_en: string | null;
  body_it: string;
  body_en: string | null;
  active: boolean;
  sort: number;
}

export async function getPortalSettings(facilityId: string): Promise<{ settings: PortalSettingsRow; exists: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("portal_settings")
    .select(
      "enabled, display_name, welcome_it, welcome_en, accent, cover_url, hours_it, hours_en, phone, whatsapp, email, address, map_url, show_menu, show_order, show_booking, show_assistance, show_offers, show_info, order_kinds, order_from, order_to, updated_at",
    )
    .eq("facility_id", facilityId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { settings: data as PortalSettingsRow, exists: true } : { settings: DEFAULT_SETTINGS, exists: false };
}

export async function getPortalOffers(facilityId: string): Promise<PortalOffer[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("portal_offers")
    .select("id, title_it, title_en, description_it, description_en, price, valid_from, valid_to, active, sort")
    .eq("facility_id", facilityId)
    .order("sort")
    .order("title_it");
  if (error) throw new Error(error.message);
  return (data ?? []).map((o) => ({ ...o, price: o.price == null ? null : Number(o.price) })) as PortalOffer[];
}

export async function getPortalInfoBlocks(facilityId: string): Promise<PortalInfoBlock[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("portal_info_blocks")
    .select("id, title_it, title_en, body_it, body_en, active, sort")
    .eq("facility_id", facilityId)
    .order("sort")
    .order("title_it");
  if (error) throw new Error(error.message);
  return (data ?? []) as PortalInfoBlock[];
}

export async function getFacilityPublicToken(facilityId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("facilities").select("public_token").eq("id", facilityId).maybeSingle();
  return (data?.public_token as string | undefined) ?? null;
}

export interface QrPoint {
  id: string;
  kind: string;
  label: string;
  zone: string | null;
  public_token: string;
  active: boolean;
}

export async function getQrPoints(facilityId: string): Promise<QrPoint[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("service_points")
    .select("id, kind, label, zone, public_token, active")
    .eq("facility_id", facilityId)
    .eq("active", true);
  if (error) throw new Error(error.message);
  return (data ?? []) as QrPoint[];
}

export interface PortalSubmission {
  id: string;
  order_id: string;
  service_point_id: string | null;
  guest_name: string | null;
  notes: string | null;
  allergies: string | null;
  lang: string;
  total: number;
  status: string;
  created_at: string;
  handled_at: string | null;
  reject_reason: string | null;
  destination_label: string | null;
  lines: { id: string; name: string; qty: number; notes: string | null; status: string }[];
}

/** Ordini dal portale da confermare (e gli ultimi gestiti) della struttura. */
export async function getPortalSubmissions(facilityId: string, limit = 30): Promise<PortalSubmission[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("portal_submissions")
    .select("id, order_id, service_point_id, guest_name, notes, allergies, lang, total, status, created_at, handled_at, reject_reason")
    .eq("facility_id", facilityId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const subs = data ?? [];
  if (subs.length === 0) return [];
  const orderIds = [...new Set(subs.map((s) => s.order_id as string))];
  const [orders, lines] = await Promise.all([
    supabase.from("pos_orders").select("id, destination_label").in("id", orderIds),
    supabase.from("pos_order_lines").select("id, portal_submission_id, name, qty, notes, status").in("portal_submission_id", subs.map((s) => s.id as string)),
  ]);
  const dest = new Map((orders.data ?? []).map((o) => [o.id as string, o.destination_label as string]));
  return subs.map((s) => ({
    ...(s as Omit<PortalSubmission, "destination_label" | "lines">),
    total: Number(s.total),
    destination_label: dest.get(s.order_id as string) ?? null,
    lines: (lines.data ?? [])
      .filter((l) => l.portal_submission_id === s.id)
      .map((l) => ({ id: l.id as string, name: l.name as string, qty: Number(l.qty), notes: (l.notes as string | null) ?? null, status: l.status as string })),
  }));
}
