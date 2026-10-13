import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

export const ORG_COOKIE = "ordivia_org";
export const FAC_COOKIE = "ordivia_fac";

export interface Facility {
  id: string;
  org_id: string;
  name: string;
  type: string;
  timezone: string;
}

export interface Department {
  id: string;
  facility_id: string;
  name: string;
  kind: string;
}

export interface AppContext {
  userId: string;
  email: string;
  fullName: string;
  org: { id: string; name: string; plan: string };
  orgs: { id: string; name: string }[];
  role: { key: string; name: string };
  membershipId: string;
  perms: Set<string>;
  facilities: Facility[];
  facility: Facility;
  departments: Department[];
  /** Reparti a cui la persona è assegnata (vuoto = tutti) */
  myDepartmentIds: string[];
}

/**
 * Contesto della richiesta: utente, organizzazione e struttura attive, permessi effettivi.
 * I permessi qui servono solo a decidere cosa mostrare: l'autorizzazione vera è nel database (RLS + RPC).
 */
export const getContext = cache(async (): Promise<AppContext> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships, error } = await supabase
    .from("memberships")
    .select("id, org_id, all_facilities, facility_ids, department_ids, roles(key, name, permissions), organizations(id, name, plan)")
    .eq("user_id", user.id)
    .eq("active", true);
  if (error) throw new Error(`Impossibile caricare le appartenenze: ${error.message}`);
  if (!memberships || memberships.length === 0) redirect("/onboarding");

  const store = await cookies();
  const wantedOrg = store.get(ORG_COOKIE)?.value;
  const m = memberships.find((x) => x.org_id === wantedOrg) ?? memberships[0]!;
  const role = m.roles as unknown as { key: string; name: string; permissions: string[] };
  const org = m.organizations as unknown as { id: string; name: string; plan: string };

  const [{ data: facilities }, { data: departments }, { data: profile }] = await Promise.all([
    supabase.from("facilities").select("id, org_id, name, type, timezone").eq("org_id", m.org_id).order("created_at"),
    supabase.from("departments").select("id, facility_id, name, kind").eq("org_id", m.org_id).order("name"),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);
  if (!facilities || facilities.length === 0) {
    throw new Error("Nessuna struttura accessibile: chiedi al titolare di assegnarti a una struttura.");
  }
  const wantedFac = store.get(FAC_COOKIE)?.value;
  const facility = facilities.find((f) => f.id === wantedFac) ?? facilities[0]!;

  const perms = new Set(role.permissions);
  if (role.key === "owner") perms.add("*");

  return {
    userId: user.id,
    email: user.email ?? "",
    fullName: profile?.full_name ?? user.email ?? "",
    org,
    orgs: memberships.map((x) => {
      const o = x.organizations as unknown as { id: string; name: string };
      return { id: o.id, name: o.name };
    }),
    role: { key: role.key, name: role.name },
    membershipId: m.id,
    perms,
    facilities,
    facility,
    departments: (departments ?? []).filter((d) => d.facility_id === facility.id),
    myDepartmentIds: m.department_ids ?? [],
  };
});

export function can(ctx: AppContext, ...anyOf: string[]): boolean {
  return ctx.perms.has("*") || anyOf.some((p) => ctx.perms.has(p));
}

export async function requirePerm(...anyOf: string[]): Promise<AppContext> {
  const ctx = await getContext();
  if (!can(ctx, ...anyOf)) redirect("/oggi?negato=1");
  return ctx;
}
