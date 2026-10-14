import Link from "next/link";
import { isPlanDue, TICKET_CATEGORIES, TICKET_PRIORITY, todayIn, warrantyState } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDate } from "@/lib/format";
import { getPeopleWith, nameMap } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { generatePlanned, saveAsset, savePlan } from "../actions";
import { MaintenanceTabs } from "../maintenance-ui";

export const metadata = { title: "Impianti e manutenzione programmata" };
export const dynamic = "force-dynamic";

interface Asset {
  id: string;
  name: string;
  location: string | null;
  category: string | null;
  purchase_date: string | null;
  warranty_until: string | null;
  notes: string | null;
  active: boolean;
}
interface Plan {
  id: string;
  asset_id: string;
  title: string;
  description: string | null;
  category: string;
  priority: keyof typeof TICKET_PRIORITY;
  every_days: number;
  next_due: string;
  assigned_to: string | null;
  active: boolean;
}

export default async function CespitiPage() {
  const ctx = await requirePerm("maintenance.manage");
  const tz = ctx.facility.timezone;
  const today = todayIn(tz);
  const supabase = await createClient();
  const [{ data: assetsData }, { data: plansData }, techs] = await Promise.all([
    supabase.from("assets").select("id, name, location, category, purchase_date, warranty_until, notes, active").eq("facility_id", ctx.facility.id).order("name"),
    supabase.from("maintenance_plans").select("id, asset_id, title, description, category, priority, every_days, next_due, assigned_to, active").eq("facility_id", ctx.facility.id).order("next_due"),
    getPeopleWith(ctx, ["maintenance.manage"]),
  ]);
  const assets = (assetsData ?? []) as Asset[];
  const plans = (plansData ?? []) as Plan[];
  const assetName = new Map(assets.map((a) => [a.id, a.name]));
  const names = nameMap(techs);
  const due = plans.filter((p) => p.active && isPlanDue(p.next_due, today)).length;

  return (
    <div>
      <PageHeader title="Impianti e manutenzione programmata" subtitle="Registro di impianti e attrezzature, con controlli periodici che diventano interventi alla scadenza." />
      <MaintenanceTabs ctx={ctx} active="cespiti" />

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <Card className="overflow-hidden">
          <CardHeader
            title={`Manutenzione programmata (${plans.length})`}
            hint={due ? `${due} in scadenza` : "Nessuna scadenza oggi"}
            action={
              <ActionForm action={generatePlanned}>
                <SubmitButton variant={due ? "primary" : "secondary"} pendingText="…">
                  Genera interventi
                </SubmitButton>
              </ActionForm>
            }
          />
          {plans.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted">{assets.length ? "Aggiungi un controllo periodico qui sotto." : "Aggiungi prima un impianto."}</p>
          ) : (
            <ul className="divide-y divide-sand">
              {plans.map((p) => (
                <li key={p.id}>
                  <details className="px-4 py-3">
                    <summary className="cursor-pointer">
                      <span className="font-bold text-night">{p.title}</span>{" "}
                      {!p.active ? <Badge>Sospeso</Badge> : isPlanDue(p.next_due, today) ? <Badge tone="warn">Da fare</Badge> : null}
                      <span className="block text-sm text-muted">
                        {assetName.get(p.asset_id) ?? "—"} · ogni {p.every_days} giorni · prossimo {formatDate(p.next_due, tz)}
                        {p.assigned_to && ` · ${names.get(p.assigned_to) ?? "—"}`}
                      </span>
                    </summary>
                    <PlanForm plan={p} assets={assets} techs={techs} today={today} />
                  </details>
                </li>
              ))}
            </ul>
          )}
          {assets.length > 0 && (
            <details className="border-t border-sand bg-warm px-4 py-3">
              <summary className="cursor-pointer font-bold text-night">+ Nuovo controllo periodico</summary>
              <PlanForm assets={assets} techs={techs} today={today} />
            </details>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title={`Impianti e attrezzature (${assets.length})`} />
          {assets.length === 0 ? (
            <EmptyState title="Nessun impianto registrato" text="Caldaie, condizionatori, frigoriferi, pompe della piscina: con data di acquisto e garanzia." />
          ) : (
            <ul className="divide-y divide-sand">
              {assets.map((a) => {
                const w = warrantyState(a.warranty_until, today);
                return (
                  <li key={a.id}>
                    <details className="px-4 py-3">
                      <summary className="cursor-pointer">
                        <span className="font-bold text-night">{a.name}</span>{" "}
                        {!a.active && <Badge>Dismesso</Badge>}
                        {w === "in_scadenza" && <Badge tone="warn">Garanzia in scadenza</Badge>}
                        {w === "scaduta" && <Badge>Garanzia scaduta</Badge>}
                        <span className="block text-sm text-muted">
                          {[a.category, a.location, a.warranty_until ? `garanzia fino al ${formatDate(a.warranty_until, tz)}` : null].filter(Boolean).join(" · ") || "—"}
                        </span>
                      </summary>
                      <AssetForm asset={a} />
                      <Link href={`/servizio/manutenzione/nuova?cespite=${a.id}`} className="mt-2 inline-block text-sm font-bold text-teal-deep">
                        Segnala un guasto su questo impianto
                      </Link>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          <details className="border-t border-sand bg-warm px-4 py-3" open={assets.length === 0}>
            <summary className="cursor-pointer font-bold text-night">+ Nuovo impianto</summary>
            <AssetForm />
          </details>
        </Card>
      </div>
    </div>
  );
}

function AssetForm({ asset }: { asset?: Asset }) {
  return (
    <ActionForm action={saveAsset} resetOnSuccess={!asset} className="mt-3 grid grid-cols-2 gap-2">
      {asset && <input type="hidden" name="asset_id" value={asset.id} />}
      <div className="col-span-2">
        <Field label="Nome">
          <Input name="name" required maxLength={120} defaultValue={asset?.name ?? ""} placeholder="Es. Caldaia centrale" />
        </Field>
      </div>
      <Field label="Dove">
        <Input name="location" maxLength={120} defaultValue={asset?.location ?? ""} placeholder="Locale tecnico" />
      </Field>
      <Field label="Categoria">
        <Input name="category" maxLength={60} defaultValue={asset?.category ?? ""} placeholder="Climatizzazione" />
      </Field>
      <Field label="Acquistato il">
        <Input type="date" name="purchase_date" defaultValue={asset?.purchase_date ?? ""} />
      </Field>
      <Field label="Garanzia fino al">
        <Input type="date" name="warranty_until" defaultValue={asset?.warranty_until ?? ""} />
      </Field>
      <div className="col-span-2">
        <Field label="Note">
          <Input name="notes" maxLength={1000} defaultValue={asset?.notes ?? ""} placeholder="Matricola, fornitore, assistenza" />
        </Field>
      </div>
      {asset && (
        <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-night">
          <input type="checkbox" name="active" defaultChecked={asset.active} className="h-5 w-5 accent-teal" /> In uso
        </label>
      )}
      <div className={asset ? "" : "col-span-2"}>
        <SubmitButton variant="secondary" pendingText="…">
          {asset ? "Salva" : "Aggiungi"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

function PlanForm({ plan, assets, techs, today }: { plan?: Plan; assets: Asset[]; techs: { id: string; name: string }[]; today: string }) {
  return (
    <ActionForm action={savePlan} resetOnSuccess={!plan} className="mt-3 grid grid-cols-2 gap-2">
      {plan && <input type="hidden" name="plan_id" value={plan.id} />}
      <div className="col-span-2">
        <Field label="Controllo">
          <Input name="title" required maxLength={160} defaultValue={plan?.title ?? ""} placeholder="Es. Pulizia filtri condizionatori" />
        </Field>
      </div>
      <div className="col-span-2">
        <Field label="Impianto">
          <Select name="asset_id" required defaultValue={plan?.asset_id ?? ""}>
            <option value="" disabled>
              Scegli…
            </option>
            {assets
              .filter((a) => a.active || a.id === plan?.asset_id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <Field label="Ogni (giorni)">
        <Input name="every_days" type="number" min={1} max={3660} required defaultValue={plan?.every_days ?? 30} inputMode="numeric" />
      </Field>
      <Field label="Prossima scadenza">
        <Input name="next_due" type="date" required defaultValue={plan?.next_due ?? today} />
      </Field>
      <Field label="Tipo">
        <Select name="category" defaultValue={plan?.category ?? "altro"}>
          {Object.entries(TICKET_CATEGORIES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Priorità">
        <Select name="priority" defaultValue={plan?.priority ?? "media"}>
          {Object.entries(TICKET_PRIORITY).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="col-span-2">
        <Field label="Assegna a (facoltativo)">
          <Select name="assigned_to" defaultValue={plan?.assigned_to ?? ""}>
            <option value="">Nessuno</option>
            {techs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="col-span-2">
        <Field label="Istruzioni">
          <Input name="description" maxLength={1000} defaultValue={plan?.description ?? ""} />
        </Field>
      </div>
      {plan && (
        <label className="flex min-h-11 items-center gap-2 text-sm font-bold text-night">
          <input type="checkbox" name="active" defaultChecked={plan.active} className="h-5 w-5 accent-teal" /> Attivo
        </label>
      )}
      <div className={plan ? "" : "col-span-2"}>
        <SubmitButton variant="secondary" pendingText="…">
          {plan ? "Salva" : "Crea controllo"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
