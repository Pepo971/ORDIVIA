"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/action-state";

/** Accetta solo percorsi interni per evitare open redirect. */
function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/oggi";
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Email non valida"),
  password: z.string().min(8, "La password deve avere almeno 8 caratteri"),
});

export async function signIn(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({ email: data.get("email"), password: data.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: error.message.includes("Email not confirmed") ? "Conferma prima l'indirizzo email dal link che ti abbiamo inviato." : "Email o password non corretti." };
  }
  redirect(safeNext(data.get("next")));
}

export async function signUp(_: ActionState, data: FormData): Promise<ActionState> {
  const parsed = credentials.extend({ full_name: z.string().trim().min(2, "Inserisci nome e cognome").max(120) }).safeParse({
    email: data.get("email"),
    password: data.get("password"),
    full_name: data.get("full_name"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const next = safeNext(data.get("next"));
  const supabase = await createClient();
  const { data: res, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.full_name },
      emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) return { error: error.message.includes("already") ? "Esiste già un account con questa email: accedi." : "Registrazione non riuscita. Riprova." };
  if (res.session) redirect(next);
  // Supabase non rivela se l'email esiste già: in quel caso l'utente torna senza identità e nessuna email parte.
  if (res.user && (res.user.identities?.length ?? 0) === 0) {
    return { error: "Esiste già un account con questa email: accedi con la tua password oppure usa «Password dimenticata»." };
  }
  return { ok: true, message: "Ti abbiamo inviato un'email: apri il link per confermare l'account. Controlla anche lo spam." };
}

export async function requestPasswordReset(_: ActionState, data: FormData): Promise<ActionState> {
  const email = z.string().trim().toLowerCase().email("Email non valida").safeParse(data.get("email"));
  if (!email.success) return { error: email.error.issues[0]?.message };
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data, { redirectTo: `${origin}/auth/callback?next=/reimposta-password` });
  if (error) return { error: error.status === 429 ? "Troppi tentativi: riprova tra qualche minuto." : "Invio non riuscito. Riprova." };
  return { ok: true, message: "Se l'indirizzo è registrato, ti abbiamo inviato un link per scegliere una nuova password. Controlla anche lo spam." };
}

export async function setNewPassword(_: ActionState, data: FormData): Promise<ActionState> {
  const pw = z.string().min(8, "La password deve avere almeno 8 caratteri").safeParse(data.get("password"));
  if (!pw.success) return { error: pw.error.issues[0]?.message };
  if (data.get("password") !== data.get("confirm")) return { error: "Le due password non coincidono" };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: pw.data });
  if (error) return { error: "Il link è scaduto o non valido: richiedine uno nuovo." };
  redirect("/oggi");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
