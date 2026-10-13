"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field, Input, Select } from "@/components/ui";
import { recordMovement } from "./actions";

const KINDS = [
  { v: "scarico", label: "Scarico (uso interno)", needs: "move" },
  { v: "spreco", label: "Spreco", needs: "move" },
  { v: "scaduto", label: "Scaduto", needs: "move" },
  { v: "reso", label: "Reso al fornitore", needs: "move" },
  { v: "trasferimento", label: "Trasferimento", needs: "move" },
  { v: "carico", label: "Carico senza ordine", needs: "load" },
] as const;

export function MovementForm({
  warehouses,
  products,
  defaultWarehouse,
  canLoad,
  canMove,
}: {
  warehouses: { id: string; name: string }[];
  products: { id: string; name: string; unit: string }[];
  defaultWarehouse?: string;
  canLoad: boolean;
  canMove: boolean;
}) {
  const kinds = KINDS.filter((k) => (k.needs === "load" ? canLoad : canMove));
  const [kind, setKind] = useState<string>(kinds[0]?.v ?? "scarico");
  const [product, setProduct] = useState(products[0]?.id ?? "");
  const unit = products.find((p) => p.id === product)?.unit ?? "";

  return (
    <ActionForm action={recordMovement} resetOnSuccess className="space-y-3">
      <Field label="Tipo">
        <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.v} value={k.v}>{k.label}</option>
          ))}
        </Select>
      </Field>
      <Field label={kind === "trasferimento" ? "Da magazzino" : "Magazzino"}>
        <Select name="warehouse_id" defaultValue={defaultWarehouse}>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </Select>
      </Field>
      {kind === "trasferimento" && (
        <Field label="A magazzino">
          <Select name="to_warehouse_id" defaultValue={warehouses.find((w) => w.id !== defaultWarehouse)?.id}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Prodotto">
        <Select name="product_id" value={product} onChange={(e) => setProduct(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
      </Field>
      <Field label={`Quantità${unit ? ` (${unit})` : ""}`}>
        <Input name="qty" type="number" min={0} step="any" inputMode="decimal" required className="font-bold" />
      </Field>
      {kind === "carico" && (
        <Field label={`Costo per ${unit || "unità"} (€)`} hint="Facoltativo: aggiorna il costo medio">
          <Input name="unit_cost" type="number" min={0} step="0.0001" inputMode="decimal" />
        </Field>
      )}
      <Field label="Nota">
        <Input name="note" placeholder={kind === "spreco" ? "Es. bottiglie rotte" : ""} maxLength={500} />
      </Field>
      <SubmitButton full pendingText="Registrazione…">Registra</SubmitButton>
    </ActionForm>
  );
}
