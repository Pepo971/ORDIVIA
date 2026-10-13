import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, CardHeader, Field, Input, PageHeader, Select } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { FACILITY_TYPES } from "@/lib/format";
import { addDepartment, addFacility } from "./actions";

export const metadata = { title: "Gestione" };

export default async function GestionePage() {
  const ctx = await requirePerm("org.manage", "members.manage", "audit.view");
  const links = [
    can(ctx, "members.manage") && { href: "/gestione/team", title: "Team e inviti", text: "Ruoli, accessi per struttura, PIN per le postazioni." },
    can(ctx, "audit.view") && { href: "/gestione/registro", title: "Registro operazioni", text: "Chi ha fatto cosa, quando, da dove." },
    { href: "/acquisti/fornitori", title: "Fornitori", text: "Listini, cut-off, storico prezzi." },
  ].filter(Boolean) as { href: string; title: string; text: string }[];

  return (
    <div>
      <PageHeader title="Gestione" subtitle={`${ctx.org.name} · piano ${ctx.org.plan}`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="rounded-[var(--radius-card)] border border-sand-deep bg-white p-4 hover:border-teal">
            <span className="block font-bold text-night">{l.title}</span>
            <span className="mt-1 block text-sm text-muted">{l.text}</span>
          </Link>
        ))}
      </div>

      {can(ctx, "org.manage") && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader title={`Reparti · ${ctx.facility.name}`} hint="I reparti con scorte ricevono automaticamente un magazzino." />
            <ul className="divide-y divide-sand">
              {ctx.departments.map((d) => (
                <li key={d.id} className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="font-bold text-night">{d.name}</span>
                  <span className="text-muted">{d.kind}</span>
                </li>
              ))}
            </ul>
            <ActionForm action={addDepartment} resetOnSuccess className="grid grid-cols-[1fr_9rem_auto] items-end gap-2 border-t border-sand bg-warm p-4">
              <Field label="Nuovo reparto">
                <Input name="name" required />
              </Field>
              <Field label="Tipo">
                <Select name="kind" defaultValue="altro">
                  {["cucina", "bar", "sala", "spiaggia", "reception", "housekeeping", "manutenzione", "magazzino", "market", "altro"].map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              <SubmitButton>Aggiungi</SubmitButton>
            </ActionForm>
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title="Strutture" />
            <ul className="divide-y divide-sand">
              {ctx.facilities.map((f) => (
                <li key={f.id} className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="font-bold text-night">{f.name}</span>
                  <span className="text-muted">{FACILITY_TYPES[f.type]}</span>
                </li>
              ))}
            </ul>
            <ActionForm action={addFacility} resetOnSuccess className="grid grid-cols-[1fr_10rem_auto] items-end gap-2 border-t border-sand bg-warm p-4">
              <Field label="Nuova struttura">
                <Input name="name" required />
              </Field>
              <Field label="Tipo">
                <Select name="type" defaultValue="ristorante">
                  {Object.entries(FACILITY_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </Select>
              </Field>
              <SubmitButton>Aggiungi</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
    </div>
  );
}
