"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, Select, Textarea } from "@/components/ui";
import { createRequest } from "../../actions";

interface P {
  id: string;
  name: string;
  unit: string;
}

let seq = 0;
const newRow = (product_id = "", qty: number | "" = "") => ({ key: ++seq, product_id, qty });

export function RequestForm({ products, departments, prefill }: { products: P[]; departments: { id: string; name: string }[]; prefill: { product_id: string; qty: number }[] }) {
  const [rows, setRows] = useState(() => (prefill.length ? prefill.map((p) => newRow(p.product_id, p.qty)) : [newRow()]));
  const unit = (id: string) => products.find((p) => p.id === id)?.unit ?? "";

  return (
    <ActionForm action={createRequest}>
      <Card className="mb-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Reparto">
            <Select name="department_id" defaultValue={departments[0]?.id ?? ""}>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Serve entro" hint="Facoltativo">
            <Input name="needed_by" type="date" />
          </Field>
        </div>
      </Card>
      <Card className="mb-4 overflow-hidden">
        <CardHeader title="Prodotti" hint="Quantità nell’unità del prodotto (pz, kg, l…)" />
        <div className="divide-y divide-sand">
          {rows.map((r, i) => (
            <div key={r.key} className="grid grid-cols-[1fr_7rem_auto] items-end gap-2 px-4 py-3">
              <Field label={i === 0 ? "Prodotto" : ""}>
                <Select
                  name="line_product"
                  value={r.product_id}
                  onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, product_id: e.target.value } : x)))}
                  aria-label="Prodotto"
                >
                  <option value="">Scegli…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label={i === 0 ? "Quantità" : ""}>
                <div className="relative">
                  <Input
                    name="line_qty"
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={r.qty}
                    aria-label="Quantità"
                    onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, qty: e.target.value === "" ? "" : Number(e.target.value) } : x)))}
                    className="pr-9 text-right font-bold"
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{unit(r.product_id)}</span>
                </div>
              </Field>
              <button
                type="button"
                aria-label="Rimuovi riga"
                className="h-11 w-11 rounded-xl text-xl text-muted hover:bg-danger-soft hover:text-danger"
                onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [newRow()]))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="px-4 py-3">
          <button type="button" className="min-h-11 text-sm font-bold text-teal-deep" onClick={() => setRows((rs) => [...rs, newRow()])}>
            + Aggiungi prodotto
          </button>
        </div>
      </Card>
      <Card className="mb-4 p-4">
        <Field label="Note">
          <Textarea name="note" placeholder="Es. serve per l’evento di sabato" maxLength={1000} />
        </Field>
      </Card>
      <div className="flex justify-end">
        <SubmitButton pendingText="Invio…">Invia richiesta</SubmitButton>
      </div>
    </ActionForm>
  );
}
