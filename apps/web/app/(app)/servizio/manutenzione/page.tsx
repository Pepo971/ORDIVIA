import Link from "next/link";
import { elapsedLabel, OPEN_TICKET_STATUSES, sortTickets, TICKET_CATEGORIES } from "@ordivia/domain";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, EmptyState, LinkButton, PageHeader, Select, Tabs, cx } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { getNames, nameMap } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { MaintenanceTabs, PriorityBadge, SOURCE_LABEL, TICKET_COLUMNS, TicketStatusBadge, pointLabel, type TicketRow } from "./maintenance-ui";

export const metadata = { title: "Manutenzione" };
export const dynamic = "force-dynamic";

type View = "aperti" | "miei" | "da_verificare" | "chiusi";

export default async function ManutenzionePage({ searchParams }: { searchParams: Promise<{ vista?: string; cat?: string }> }) {
  const ctx = await requirePerm("maintenance.report", "maintenance.manage");
  const sp = await searchParams;
  const manage = can(ctx, "maintenance.manage");
  const tz = ctx.facility.timezone;
  const view: View = (["aperti", "miei", "da_verificare", "chiusi"] as const).includes(sp.vista as View) ? (sp.vista as View) : "aperti";
  const cat = sp.cat && sp.cat in TICKET_CATEGORIES ? sp.cat : null;
  const supabase = await createClient();

  // Senza maintenance.manage RLS restituisce solo i propri interventi (segnalati o assegnati).
  let q = supabase.from("maintenance_tickets").select(TICKET_COLUMNS).eq("facility_id", ctx.facility.id);
  if (view === "aperti") q = q.in("status", OPEN_TICKET_STATUSES);
  if (view === "miei") q = q.eq("assigned_to", ctx.userId).in("status", OPEN_TICKET_STATUSES);
  if (view === "da_verificare") q = q.eq("status", "risolto");
  if (view === "chiusi") q = q.in("status", ["verificato", "annullato"]);
  if (cat) q = q.eq("category", cat);
  const [{ data }, { data: points }, { data: counts }] = await Promise.all([
    q.order("created_at", { ascending: false }).limit(200),
    supabase.from("service_points").select("id, kind, label").eq("facility_id", ctx.facility.id),
    supabase.from("maintenance_tickets").select("status, assigned_to").eq("facility_id", ctx.facility.id).in("status", [...OPEN_TICKET_STATUSES, "risolto"]),
  ]);
  const tickets = sortTickets((data ?? []) as TicketRow[]);
  const pointBy = new Map((points ?? []).map((p) => [p.id as string, p as { kind: string; label: string }]));
  const names = nameMap(await getNames(tickets.flatMap((t) => [t.assigned_to, t.reported_by])));
  const c = counts ?? [];
  const n = {
    aperti: c.filter((t) => t.status !== "risolto").length,
    miei: c.filter((t) => t.status !== "risolto" && t.assigned_to === ctx.userId).length,
    da_verificare: c.filter((t) => t.status === "risolto").length,
  };
  const href = (v: View) => `/servizio/manutenzione?vista=${v}${cat ? `&cat=${cat}` : ""}`;

  return (
    <div>
      <LiveRefresh tables={["maintenance_tickets"]} facilityId={ctx.facility.id} intervalMs={30000} />
      <PageHeader
        title="Manutenzione"
        subtitle={manage ? "Guasti e interventi, dal più urgente." : "Le tue segnalazioni e il loro stato."}
        action={<LinkButton href="/servizio/manutenzione/nuova">Segnala un guasto</LinkButton>}
      />
      <MaintenanceTabs ctx={ctx} active="interventi" />

      <div className="mb-3 flex flex-wrap items-start gap-2">
        <Tabs
          active={view}
          items={[
            { key: "aperti", label: "Aperti", href: href("aperti"), count: n.aperti },
            ...(manage ? [{ key: "miei", label: "Assegnati a me", href: href("miei"), count: n.miei }] : []),
            { key: "da_verificare", label: "Da verificare", href: href("da_verificare"), count: n.da_verificare },
            { key: "chiusi", label: "Chiusi", href: href("chiusi") },
          ]}
        />
        <form action="/servizio/manutenzione" className="mb-4 flex gap-2">
          <input type="hidden" name="vista" value={view} />
          <Select name="cat" defaultValue={cat ?? ""} aria-label="Categoria" className="min-h-11 py-2">
            <option value="">Tutte le categorie</option>
            {Object.entries(TICKET_CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <button className="rounded-xl bg-night px-3 text-sm font-bold text-warm">Filtra</button>
        </form>
      </div>

      <Card className="overflow-hidden">
        {tickets.length === 0 ? (
          <EmptyState
            title={view === "aperti" ? "Nessun intervento aperto" : "Niente da mostrare"}
            text={view === "aperti" ? "Quando qualcuno segnala un guasto lo trovi qui, in ordine di urgenza." : undefined}
            action={<LinkButton href="/servizio/manutenzione/nuova" variant="secondary">Segnala un guasto</LinkButton>}
          />
        ) : (
          <ul className="divide-y divide-sand">
            {tickets.map((t) => {
              const where = t.service_point_id && pointBy.get(t.service_point_id) ? pointLabel(pointBy.get(t.service_point_id)!) : t.location_text;
              const open = OPEN_TICKET_STATUSES.includes(t.status);
              return (
                <li key={t.id}>
                  <Link href={`/servizio/manutenzione/${t.id}`} className={cx("block px-4 py-3 hover:bg-warm", t.priority === "urgente" && open && "border-l-4 border-danger")}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-bold text-muted">#{t.number}</span>
                      <span className="font-bold text-night">{where ?? "—"}</span>
                      <PriorityBadge priority={t.priority} />
                      <TicketStatusBadge status={t.status} />
                      {t.photo_path && <span className="text-xs font-bold text-muted">Foto</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-sm text-ink">{t.description}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {TICKET_CATEGORIES[t.category] ?? t.category} · {SOURCE_LABEL[t.source] ?? t.source}
                      {t.reported_by && ` · da ${names.get(t.reported_by) ?? "—"}`}
                      {t.assigned_to && ` · a ${names.get(t.assigned_to) ?? "—"}`}
                      {" · "}
                      {open ? `aperto da ${elapsedLabel(t.created_at)}` : formatDateTime(t.created_at, tz)}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
