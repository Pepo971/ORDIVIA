import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Logo } from "@/components/logo";
import { Card, LinkButton } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { acceptInvitation } from "./actions";

export const metadata = { title: "Invito" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{48}$/.test(token)) redirect("/login?errore=invito");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto max-w-md px-5 py-12">
      <Logo />
      <Card className="mt-8 p-6">
        <h1 className="font-display text-2xl font-semibold text-night">Sei stato invitato su Ordivia</h1>
        {user ? (
          <>
            <p className="mt-2 text-muted">
              Accetterai l’invito con l’account <strong className="text-night">{user.email}</strong>. L’invito funziona solo con l’indirizzo a cui è stato inviato.
            </p>
            <ActionForm action={acceptInvitation} className="mt-5">
              <input type="hidden" name="token" value={token} />
              <SubmitButton full pendingText="Accettazione…">
                Accetta e entra
              </SubmitButton>
            </ActionForm>
          </>
        ) : (
          <>
            <p className="mt-2 text-muted">Accedi o crea un account con l’email a cui è arrivato l’invito, poi tornerai qui.</p>
            <div className="mt-5 grid gap-2">
              <LinkButton href={`/login?mode=registrati&next=/invito/${token}`} full>
                Crea account
              </LinkButton>
              <LinkButton href={`/login?next=/invito/${token}`} variant="secondary" full>
                Ho già un account
              </LinkButton>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
