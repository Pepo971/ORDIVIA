import { redirect } from "next/navigation";
import { EmptyState, Card, LinkButton } from "@/components/ui";
import { getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Etichetta" };
export const dynamic = "force-dynamic";

/** Destinazione del QR stampato: risolve il token (solo per chi è autorizzato nella struttura) e apre l'etichetta. */
export default async function LabelQrPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await getContext(); // richiede l'accesso
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("haccp_label_by_token", { p_token: token });
  if (!error && data) redirect(`/servizio/menu/haccp/etichette/${data as string}`);
  return (
    <Card>
      <EmptyState
        title="Etichetta non trovata"
        text="Il codice non corrisponde a un'etichetta della tua struttura, oppure non hai i permessi HACCP. Se lavori in più strutture, cambia struttura e riprova."
        action={<LinkButton href="/servizio/menu/haccp" variant="secondary">Vai all'HACCP</LinkButton>}
      />
    </Card>
  );
}
