"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input } from "@/components/ui";
import { signIn, signUp } from "./actions";

export function LoginForms({ next, initialMode }: { next: string; initialMode: "signin" | "signup" }) {
  const [mode, setMode] = useState(initialMode);
  const isSignup = mode === "signup";
  return (
    <div>
      <h1 className="font-display text-[1.9rem] font-semibold text-night">{isSignup ? "Crea il tuo account" : "Bentornato"}</h1>
      <p className="mt-1 mb-6 text-muted">{isSignup ? "Il titolare crea l’account e poi invita il team." : "Accedi per vedere la giornata della tua struttura."}</p>
      <ActionForm key={mode} action={isSignup ? signUp : signIn} className="space-y-4">
        <input type="hidden" name="next" value={next} />
        {isSignup && (
          <Field label="Nome e cognome">
            <Input name="full_name" autoComplete="name" required />
          </Field>
        )}
        <Field label="Email">
          <Input name="email" type="email" autoComplete="email" inputMode="email" required />
        </Field>
        <Field label="Password" hint={isSignup ? "Almeno 8 caratteri" : undefined}>
          <Input name="password" type="password" autoComplete={isSignup ? "new-password" : "current-password"} minLength={8} required />
        </Field>
        <SubmitButton full pendingText={isSignup ? "Creazione account…" : "Accesso…"}>
          {isSignup ? "Crea account" : "Accedi"}
        </SubmitButton>
      </ActionForm>
      <p className="mt-6 text-center text-sm text-muted">
        {isSignup ? "Hai già un account?" : "Prima volta su Ordivia?"}{" "}
        <button type="button" className="min-h-0 font-bold text-teal-deep underline-offset-4 hover:underline" onClick={() => setMode(isSignup ? "signin" : "signup")}>
          {isSignup ? "Accedi" : "Crea un account"}
        </button>
      </p>
    </div>
  );
}
