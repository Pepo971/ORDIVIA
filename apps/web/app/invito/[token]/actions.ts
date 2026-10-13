"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { humanError, type ActionState } from "@/lib/action-state";
import { FAC_COOKIE, ORG_COOKIE } from "@/lib/context";

export async function acceptInvitation(_: ActionState, data: FormData): Promise<ActionState> {
  const token = String(data.get("token") ?? "");
  const supabase = await createClient();
  const { data: orgId, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) return { error: humanError(error) };
  const store = await cookies();
  store.set(ORG_COOKIE, orgId as string, { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 365 });
  store.delete(FAC_COOKIE);
  redirect("/oggi");
}
