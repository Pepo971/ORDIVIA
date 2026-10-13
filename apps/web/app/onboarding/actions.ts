"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { humanError, type ActionState } from "@/lib/action-state";
import { FAC_COOKIE, ORG_COOKIE } from "@/lib/context";

const schema = z.object({
  org_name: z.string().trim().min(2, "Inserisci la ragione sociale o il nome dell'azienda").max(120),
  facility_name: z.string().trim().min(2, "Inserisci il nome della struttura").max(120),
  facility_type: z.enum(["lido", "ristorante", "hotel", "camping", "resort", "ibrida"], { message: "Scegli il tipo di struttura" }),
});

export async function createOrganization(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = schema.safeParse(Object.fromEntries(data));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { data: orgId, error } = await supabase.rpc("create_organization", {
    p_org_name: parsed.data.org_name,
    p_facility_name: parsed.data.facility_name,
    p_facility_type: parsed.data.facility_type,
  });
  if (error) return { error: humanError(error) };
  const store = await cookies();
  store.set(ORG_COOKIE, orgId as string, { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 365 });
  store.delete(FAC_COOKIE);
  redirect("/oggi?benvenuto=1");
}
