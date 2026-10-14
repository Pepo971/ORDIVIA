import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { mergeCustomers } from "../actions";

export const metadata = { title: "Clienti doppi" };
export const dynamic = "force-dynamic";

const REASON: Record<string, string> = { telefono: "Stesso telefono", email: "Stessa email", nome: "Stesso nome" };

export default async function DoppioniPage() {
  const ctx = await requirePerm("crm.manage");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("crm_find_duplicates", { p_org: ctx.org.id });
  if (error) throw new Error(error.message);
  const pairs = (data ?? []) as { a_id: string; a_name: string; b_id: string; b_name: string; reason: string }[];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Possibili doppioni"
        subtitle="Schede con stesso telefono, email o nome. Unendole, prenotazioni, spiaggia, conti e consensi passano alla scheda più vecchia."
        action={<LinkButton href="/ospiti/clienti" variant="secondary">Clienti</LinkButton>}
      />
      <Card className="overflow-hidden">
        <CardHeader title={`${pairs.length} coppie`} hint="Lo stesso nome non basta: controlla prima di unire." />
        {pairs.length === 0 ? (
          <EmptyState title="Nessun doppione" text="Le nuove prenotazioni si collegano da sole alla scheda con lo stesso telefono o email." />
        ) : (
          <ul className="divide-y divide-sand">
            {pairs.map((p) => (
              <li key={`${p.a_id}-${p.b_id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <Link href={`/ospiti/clienti/${p.a_id}`} className="font-bold text-night hover:underline">
                      {p.a_name}
                    </Link>
                    <span className="text-muted">e</span>
                    <Link href={`/ospiti/clienti/${p.b_id}`} className="font-bold text-night hover:underline">
                      {p.b_name}
                    </Link>
                  </p>
                  <Badge tone={p.reason === "nome" ? "warn" : "teal"}>{REASON[p.reason] ?? p.reason}</Badge>
                </div>
                <ActionForm action={mergeCustomers}>
                  <input type="hidden" name="keep_id" value={p.a_id} />
                  <input type="hidden" name="merge_id" value={p.b_id} />
                  <SubmitButton variant="secondary" pendingText="…" confirm={`Unire «${p.b_name}» in «${p.a_name}»? L'operazione non si può annullare.`}>
                    Unisci
                  </SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
