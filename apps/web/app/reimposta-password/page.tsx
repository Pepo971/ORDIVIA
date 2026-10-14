import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/logo";
import { Card, Field, Input } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { setNewPassword } from "../login/actions";

export const metadata = { title: "Nuova password" };

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?errore=link");
  return (
    <main className="mx-auto max-w-md px-5 py-12">
      <Logo />
      <Card className="mt-8 p-6">
        <h1 className="font-display text-2xl font-semibold text-night">Scegli una nuova password</h1>
        <p className="mt-1 text-sm text-muted">Account {user.email}</p>
        <ActionForm action={setNewPassword} className="mt-5 space-y-4">
          <Field label="Nuova password" hint="Almeno 8 caratteri">
            <Input name="password" type="password" autoComplete="new-password" minLength={8} required />
          </Field>
          <Field label="Ripeti la password">
            <Input name="confirm" type="password" autoComplete="new-password" minLength={8} required />
          </Field>
          <SubmitButton full pendingText="Salvataggio…">Salva e entra</SubmitButton>
        </ActionForm>
      </Card>
    </main>
  );
}
