import Link from "next/link";
import { frequencyLabel, parseSegmentFilters, segmentQuery, type SegmentFilters } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, EmptyState, Field, Input, LinkButton, PageHeader, Select, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatEur } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { CustomerListRow } from "@/lib/reservations-queries";
import { deleteSegment, saveSegment } from "./actions";

export const metadata = { title: "Clienti" };
export const dynamic = "force-dynamic";

type SP = Record<string, string | undefined>;

export default async function ClientiPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requirePerm("crm.view", "crm.manage", "reservations.manage");
  const sp = await searchParams;
  const finance = can(ctx, "finance.view");
  const manage = can(ctx, "crm.manage");
  const f: SegmentFilters = parseSegmentFilters(sp);
  if (!finance) delete f.minSpend;
  const picking = sp.scegli === "1" && typeof sp.ritorno === "string" && sp.ritorno.startsWith("/ospiti/prenotazioni/nuova");
  const supabase = await createClient();

  const [{ data, error }, { data: segments }] = await Promise.all([
    supabase.rpc("crm_customers", {
      p_org: ctx.org.id,
      p_search: f.q ?? null,
      p_tags: f.tags ?? null,
      p_min_visits: f.minVisits ?? null,
      p_last_visit_after: f.lastVisitAfter ?? null,
      p_last_visit_before: f.lastVisitBefore ?? null,
      p_marketing: f.marketing ?? null,
      p_min_spend: f.minSpend ?? null,
      p_include_anonymized: false,
      p_limit: 300,
    }),
    supabase.from("customer_segments").select("id, name, filters").eq("org_id", ctx.org.id).order("name"),
  ]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as CustomerListRow[];
  const filtered = Object.keys(f).length > 0;

  return (
    <div>
      <PageHeader
        title={picking ? "Scegli il cliente" : "Clienti"}
        subtitle={picking ? "Tocca un cliente per collegarlo alla prenotazione." : "Schede condivise tra le strutture: visite, prenotazioni, allergie, preferenze e consensi."}
        action={
          picking ? (
            <LinkButton href={sp.ritorno!} variant="secondary">Torna alla prenotazione</LinkButton>
          ) : (
            <div className="flex gap-2">
              {manage && <LinkButton href="/ospiti/clienti/doppioni" variant="secondary">Doppioni</LinkButton>}
              <LinkButton href="/ospiti/clienti/nuovo">Nuovo cliente</LinkButton>
            </div>
          )
        }
      />

      {!picking && (segments ?? []).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" aria-label="Segmenti salvati">
          {(segments ?? []).map((s) => {
            const qs = segmentQuery(parseSegmentFilters(s.filters as Record<string, unknown>));
            return (
              <span key={s.id} className="inline-flex items-center rounded-full bg-sand">
                <Link href={`/ospiti/clienti?${qs}`} className="px-3 py-1.5 text-sm font-bold text-night hover:underline">
                  {s.name}
                </Link>
                {manage && (
                  <form action={deleteSegment}>
                    <input type="hidden" name="segment_id" value={s.id} />
                    <button className="px-2 py-1.5 text-sm font-bold text-muted hover:text-danger" aria-label={`Elimina segmento ${s.name}`}>
                      ×
                    </button>
                  </form>
                )}
              </span>
            );
          })}
        </div>
      )}

      <Card className="mb-4 p-4">
        <form action="/ospiti/clienti" className="space-y-3">
          {picking && (
            <>
              <input type="hidden" name="scegli" value="1" />
              <input type="hidden" name="ritorno" value={sp.ritorno} />
            </>
          )}
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="q">Cerca</label>
            <Input id="q" name="q" type="search" defaultValue={f.q ?? ""} placeholder="Nome, telefono o email" />
            <button className="rounded-xl bg-night px-4 font-bold text-warm">Cerca</button>
          </div>
          {!picking && (
            <details open={filtered && !f.q}>
              <summary className="cursor-pointer text-sm font-bold text-night">Filtri e segmenti</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Field label="Tag" hint="Separati da virgola">
                  <Input name="tags" defaultValue={f.tags?.join(", ") ?? ""} placeholder="abituale, vip" />
                </Field>
                <Field label="Visite almeno">
                  <Input name="minVisits" type="number" min={0} defaultValue={f.minVisits ?? ""} />
                </Field>
                <Field label="Consenso marketing">
                  <Select name="marketing" defaultValue={f.marketing == null ? "" : f.marketing ? "1" : "0"}>
                    <option value="">Indifferente</option>
                    <option value="1">Sì</option>
                    <option value="0">No</option>
                  </Select>
                </Field>
                <Field label="Ultima visita dal">
                  <Input name="lastVisitAfter" type="date" defaultValue={f.lastVisitAfter ?? ""} />
                </Field>
                <Field label="Non vengono dal" hint="Clienti da riconquistare">
                  <Input name="lastVisitBefore" type="date" defaultValue={f.lastVisitBefore ?? ""} />
                </Field>
                {finance && (
                  <Field label="Spesa almeno (€)">
                    <Input name="minSpend" type="number" min={0} defaultValue={f.minSpend ?? ""} />
                  </Field>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="min-h-11 rounded-xl bg-night px-4 font-bold text-warm">Applica</button>
                {filtered && (
                  <Link href="/ospiti/clienti" className="inline-flex min-h-11 items-center rounded-xl px-4 font-bold text-night hover:bg-sand">
                    Azzera
                  </Link>
                )}
              </div>
            </details>
          )}
        </form>
        {!picking && manage && filtered && (
          <ActionForm action={saveSegment} className="mt-3 flex flex-wrap items-end gap-2 border-t border-sand pt-3">
            {f.q && <input type="hidden" name="q" value={f.q} />}
            {f.tags && <input type="hidden" name="tags" value={f.tags.join(",")} />}
            {f.minVisits != null && <input type="hidden" name="minVisits" value={f.minVisits} />}
            {f.lastVisitAfter && <input type="hidden" name="lastVisitAfter" value={f.lastVisitAfter} />}
            {f.lastVisitBefore && <input type="hidden" name="lastVisitBefore" value={f.lastVisitBefore} />}
            {f.marketing != null && <input type="hidden" name="marketing" value={f.marketing ? "1" : "0"} />}
            {f.minSpend != null && <input type="hidden" name="minSpend" value={f.minSpend} />}
            <div className="min-w-0 flex-1">
              <Field label="Salva questi filtri come segmento">
                <Input name="name" maxLength={80} placeholder="Clienti abituali con consenso marketing" required />
              </Field>
            </div>
            <SubmitButton variant="secondary" pendingText="…">Salva segmento</SubmitButton>
          </ActionForm>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title={`${rows.length}${rows.length === 300 ? "+" : ""} clienti`} hint={filtered ? "Filtrati" : "Ordinati per ultima visita"} />
        {rows.length === 0 ? (
          <EmptyState
            title={filtered ? "Nessun cliente con questi filtri" : "Ancora nessun cliente"}
            text={filtered ? "Allarga la ricerca o azzera i filtri." : "Le schede si creano da sole con le prenotazioni (telefono o email) o a mano."}
            action={!filtered ? <LinkButton href="/ospiti/clienti/nuovo">Nuovo cliente</LinkButton> : undefined}
          />
        ) : (
          <ul>
            {rows.map((c) => (
              <li key={c.id} className="border-b border-sand last:border-b-0">
                <Link
                  href={picking ? `${sp.ritorno}${sp.ritorno!.includes("?") ? "&" : "?"}cliente=${c.id}#dati` : `/ospiti/clienti/${c.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-warm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-bold text-night">
                      {c.full_name}
                      {c.tags.map((t) => (
                        <Badge key={t} tone="neutral">{t}</Badge>
                      ))}
                      {c.marketing_consent && <Badge tone="teal">Marketing</Badge>}
                      {c.allergies.length > 0 && <Badge tone="danger">Allergie</Badge>}
                      {c.no_shows > 0 && <Badge tone="warn">{c.no_shows} no-show</Badge>}
                    </p>
                    <p className="truncate text-sm text-muted">{[c.phone, c.email].filter(Boolean).join(" · ") || "Senza recapiti"}</p>
                  </div>
                  <div className="text-right text-sm">
                    <p className={cx("font-bold", c.visits >= 5 ? "text-teal-deep" : "text-night")}>
                      {frequencyLabel(c.visits)}
                      {c.visits > 0 ? ` · ${c.visits}` : ""}
                    </p>
                    <p className="text-muted">{c.last_visit ? `Ultima: ${formatDate(c.last_visit)}` : "—"}</p>
                    {finance && c.spend != null && c.spend > 0 && <p className="font-bold text-night">{formatEur(c.spend)}</p>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
