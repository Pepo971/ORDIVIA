import { compareRoomLabels, TICKET_CATEGORIES, TICKET_PRIORITY } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { openTicket } from "../actions";
import { MaintenanceTabs, pointLabel } from "../maintenance-ui";

export const metadata = { title: "Segnala un guasto" };
export const dynamic = "force-dynamic";

export default async function NuovaSegnalazionePage({ searchParams }: { searchParams: Promise<{ punto?: string; cespite?: string }> }) {
  const ctx = await requirePerm("maintenance.report", "maintenance.manage");
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: points }, { data: assets }] = await Promise.all([
    supabase.from("service_points").select("id, kind, label").eq("facility_id", ctx.facility.id).eq("active", true),
    supabase.from("assets").select("id, name, location").eq("facility_id", ctx.facility.id).eq("active", true).order("name"),
  ]);
  const sorted = ((points ?? []) as { id: string; kind: string; label: string }[]).sort((a, b) => a.kind.localeCompare(b.kind) || compareRoomLabels(a.label, b.label));
  const kinds = [...new Set(sorted.map((p) => p.kind))];

  return (
    <div>
      <PageHeader title="Segnala un guasto" subtitle="Bastano dove e cosa. Una foto aiuta chi deve intervenire." />
      <MaintenanceTabs ctx={ctx} active="nuova" />
      <Card className="max-w-xl p-4">
        <ActionForm action={openTicket} className="space-y-3">
          <Field label="Cosa non va">
            <Textarea name="description" required minLength={3} maxLength={2000} rows={3} placeholder="Es. la lavastoviglie perde acqua dal fondo" />
          </Field>
          <Field label="Dove" hint="Scegli una camera, un tavolo o un'area; altrimenti scrivi il luogo qui sotto.">
            <Select name="point_id" defaultValue={sp.punto ?? ""}>
              <option value="">— Altro luogo —</option>
              {kinds.map((k) => (
                <optgroup key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}>
                  {sorted
                    .filter((p) => p.kind === k)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {pointLabel(p)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Luogo (se non è nell'elenco)">
            <Input name="location" maxLength={120} placeholder="Es. Cucina, Hall, Piscina" />
          </Field>
          {(assets ?? []).length > 0 && (
            <Field label="Impianto o attrezzatura (facoltativo)">
              <Select name="asset_id" defaultValue={sp.cespite ?? ""}>
                <option value="">—</option>
                {(assets ?? []).map((a) => (
                  <option key={a.id as string} value={a.id as string}>
                    {a.name as string}
                    {a.location ? ` · ${a.location as string}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label="Tipo">
              <Select name="category" defaultValue="altro">
                {Object.entries(TICKET_CATEGORIES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priorità">
              <Select name="priority" defaultValue="media">
                {Object.entries(TICKET_PRIORITY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Foto (facoltativa)">
            <Input name="photo" type="file" accept="image/*" capture="environment" className="py-2" />
          </Field>
          <SubmitButton full className="min-h-12" pendingText="Invio…">
            Invia segnalazione
          </SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
