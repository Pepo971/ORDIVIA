import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { createSupplier } from "../../actions";
import { SupplierFields } from "../supplier-fields";

export const metadata = { title: "Nuovo fornitore" };

export default async function NewSupplierPage() {
  await requirePerm("suppliers.manage");
  return (
    <div>
      <PageHeader title="Nuovo fornitore" subtitle="Dopo il salvataggio aggiungi i prodotti a listino con confezione e prezzo." />
      <Card className="p-4 sm:p-5">
        <ActionForm action={createSupplier}>
          <SupplierFields />
          <div className="mt-5 flex justify-end">
            <SubmitButton>Salva e aggiungi listino</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
