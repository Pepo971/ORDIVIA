"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { humanError, type ActionState } from "@/lib/action-state";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

const uuid = z.string().uuid();

export async function inviteMember(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      email: z.string().trim().toLowerCase().email("Email non valida"),
      role_id: uuid,
      scope: z.enum(["facility", "all"]),
      department_ids: z.array(uuid).default([]),
    })
    .safeParse({ email: data.get("email"), role_id: data.get("role_id"), scope: data.get("scope"), department_ids: data.getAll("department_ids") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data: inv, error } = await supabase
    .from("invitations")
    .insert({
      org_id: ctx.org.id,
      email: parsed.data.email,
      role_id: parsed.data.role_id,
      all_facilities: parsed.data.scope === "all",
      facility_ids: parsed.data.scope === "all" ? [] : [ctx.facility.id],
      department_ids: parsed.data.department_ids,
      invited_by: ctx.userId,
    })
    .select("token")
    .single();
  if (error) return { error: humanError(error) };
  revalidatePath("/gestione/team");
  return { ok: true, message: `Invito creato. Condividi il link: ${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/invito/${inv.token}` };
}

export async function revokeInvitation(data: FormData) {
  const id = uuid.parse(data.get("id"));
  const supabase = await createClient();
  await supabase.from("invitations").delete().eq("id", id).is("accepted_at", null);
  revalidatePath("/gestione/team");
}

export async function updateMember(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const id = uuid.safeParse(data.get("membership_id"));
  const role = uuid.safeParse(data.get("role_id"));
  if (!id.success || !role.success) return { error: "Dati non validi" };
  if (id.data === ctx.membershipId) return { error: "Non puoi cambiare il tuo stesso ruolo." };
  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("memberships")
    .update({ role_id: role.data, active: data.get("active") === "on" })
    .eq("id", id.data)
    .select("id");
  if (error) return { error: humanError(error) };
  if (!rows?.length) return { error: "Non hai i permessi per modificare questa persona." };
  revalidatePath("/gestione/team");
  return { ok: true, message: "Aggiornato." };
}

export async function setPin(_: ActionState, data: FormData): Promise<ActionState> {
  const id = uuid.safeParse(data.get("membership_id"));
  const pin = String(data.get("pin") ?? "");
  if (!id.success) return { error: "Dati non validi" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_member_pin", { p_membership: id.data, p_pin: pin });
  if (error) return { error: humanError(error) };
  return { ok: true, message: "PIN impostato per le postazioni condivise." };
}

export async function addDepartment(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({ name: z.string().trim().min(1, "Inserisci il nome").max(80), kind: z.string().trim().max(40) })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("departments").insert({ org_id: ctx.org.id, facility_id: ctx.facility.id, name: parsed.data.name, kind: parsed.data.kind || "altro" });
  if (error) return { error: humanError(error) };
  revalidatePath("/gestione");
  return { ok: true, message: "Reparto aggiunto." };
}

export async function addFacility(_: ActionState, data: FormData): Promise<ActionState> {
  const ctx = await getContext();
  const parsed = z
    .object({
      name: z.string().trim().min(2, "Inserisci il nome").max(120),
      type: z.enum(["lido", "ristorante", "hotel", "camping", "resort", "ibrida"]),
    })
    .safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.from("facilities").insert({ org_id: ctx.org.id, name: parsed.data.name, type: parsed.data.type });
  if (error) return { error: humanError(error) };
  revalidatePath("/gestione");
  return { ok: true, message: "Struttura aggiunta: aggiungi i reparti selezionandola dal menu." };
}
