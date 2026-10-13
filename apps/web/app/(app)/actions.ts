"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { FAC_COOKIE, getContext } from "@/lib/context";

export async function switchFacility(data: FormData) {
  const ctx = await getContext();
  const id = String(data.get("facility_id") ?? "");
  // Solo strutture effettivamente visibili all'utente (filtrate da RLS in getContext).
  if (ctx.facilities.some((f) => f.id === id)) {
    (await cookies()).set(FAC_COOKIE, id, { path: "/", httpOnly: true, sameSite: "lax", secure: true, maxAge: 60 * 60 * 24 * 365 });
  }
  redirect("/oggi");
}
