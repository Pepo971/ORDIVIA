import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { saveCustomer } from "../actions";
import { CustomerFields } from "../customer-fields";

export const metadata = { title: "Nuovo cliente" };

export default async function NuovoClientePage({ searchParams }: { searchParams: Promise<{ ritorno?: string }> }) {
  await requirePerm("crm.view", "crm.manage", "reservations.manage");
  const sp = await searchParams;
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Nuovo cliente"
        subtitle="I consensi privacy e marketing si registrano dalla scheda, con fonte e data."
        action={<LinkButton href="/ospiti/clienti" variant="secondary">Clienti</LinkButton>}
      />
      <Card className="p-4">
        <ActionForm action={saveCustomer}>
          {sp.ritorno?.startsWith("/ospiti/prenotazioni/nuova") && <input type="hidden" name="ritorno" value={sp.ritorno} />}
          <CustomerFields />
          <div className="mt-4">
            <SubmitButton pendingText="Salvataggio…">Crea scheda</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
