import Link from "next/link";
import { expiryState, todayIn, zonedTimeToUtc } from "@ordivia/domain";
import { Badge, Card, CardHeader, cx, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime, relativeFromNow } from "@/lib/format";
import { getEquipment, getLabels, getTempLogs } from "@/lib/menu-queries";
import { fmtTemp, MenuNav } from "../menu-nav";

export const metadata = { title: "HACCP" };
export const dynamic = "force-dynamic";

export default async function HaccpPage() {
  const ctx = await requirePerm("haccp.record", "menu.manage", "pos.kitchen");
  const tz = ctx.facility.timezone;
  const [y, m, d] = todayIn(tz).split("-").map(Number) as [number, number, number];
  const startOfDay = zonedTimeToUtc(y, m, d, 0, 0, tz).toISOString();
  const now = new Date();

  const [equipment, logsToday, labels] = await Promise.all([
    getEquipment(ctx.facility.id),
    getTempLogs(ctx.facility.id, { since: startOfDay, limit: 500 }),
    getLabels(ctx.facility.id, { status: "attiva", limit: 300 }),
  ]);
  const active = equipment.filter((e) => e.active);
  const lastBy = new Map<string, (typeof logsToday)[number]>();
  for (const l of logsToday) if (!lastBy.has(l.equipment_id)) lastBy.set(l.equipment_id, l);
  const missing = active.filter((e) => !lastBy.has(e.id));
  const openIssues = logsToday.filter((l) => l.out_of_range && !l.corrective_action);
  const expiring = labels.filter((l) => expiryState(new Date(l.expires_at), now) !== "ok");
  const canRecord = can(ctx, "haccp.record");

  return (
    <div>
      <PageHeader
        title="HACCP"
        subtitle="Temperature delle attrezzature, etichette di preparazione e apertura, lotti."
        action={
          canRecord ? (
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/servizio/menu/haccp/temperature">Rileva temperature</LinkButton>
              <LinkButton href="/servizio/menu/haccp/etichette/nuova" variant="secondary">Nuova etichetta</LinkButton>
            </div>
          ) : undefined
        }
      />
      <MenuNav ctx={ctx} active="haccp" />

      <div className="mb-5 grid grid-cols-3 gap-3">
        <Stat label="Da rilevare oggi" value={active.length ? `${missing.length}/${active.length}` : "—"} tone={missing.length ? "warn" : "ok"} />
        <Stat label="Fuori range senza azione" value={String(openIssues.length)} tone={openIssues.length ? "danger" : "ok"} />
        <Stat label="Etichette in scadenza" value={String(expiring.length)} tone={expiring.some((l) => new Date(l.expires_at) <= now) ? "danger" : expiring.length ? "warn" : "ok"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Temperature di oggi" action={<Link href="/servizio/menu/haccp/temperature" className="text-sm font-bold text-teal-deep">Registro</Link>} />
          {active.length === 0 ? (
            <EmptyState
              title="Nessuna attrezzatura"
              text="Aggiungi frigoriferi, congelatori e abbattitori con i limiti di temperatura."
              action={can(ctx, "menu.manage", "org.manage") ? <LinkButton href="/servizio/menu/haccp/temperature#attrezzature" variant="secondary">Aggiungi</LinkButton> : undefined}
            />
          ) : (
            <ul className="divide-y divide-sand">
              {active.map((e) => {
                const l = lastBy.get(e.id);
                return (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="flex-1">
                      <p className="font-bold text-night">{e.name}</p>
                      <p className="text-xs text-muted">Limiti {fmtTemp(e.min_temp)} / {fmtTemp(e.max_temp)}</p>
                    </div>
                    {l ? (
                      <div className="text-right">
                        <p className={cx("font-extrabold", l.out_of_range ? "text-danger" : "text-ok")}>{fmtTemp(l.value)}</p>
                        <p className="text-xs text-muted">{relativeFromNow(new Date(l.recorded_at), now)}</p>
                      </div>
                    ) : (
                      <Badge tone="warn">Da rilevare</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Etichette in scadenza" hint="Scadute o in scadenza entro 48 ore" action={<Link href="/servizio/menu/haccp/etichette" className="text-sm font-bold text-teal-deep">Tutte</Link>} />
          {expiring.length === 0 ? (
            <EmptyState title="Niente in scadenza" text={labels.length ? `${labels.length} etichette attive, nessuna in scadenza.` : "Crea un'etichetta quando prepari o apri un prodotto."} />
          ) : (
            <ul className="divide-y divide-sand">
              {expiring.slice(0, 12).map((l) => {
                const st = expiryState(new Date(l.expires_at), now);
                return (
                  <li key={l.id}>
                    <Link href={`/servizio/menu/haccp/etichette/${l.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-warm">
                      <div className="flex-1">
                        <p className="font-bold text-night">{l.name}</p>
                        <p className="text-xs text-muted">{l.lot_code} · {l.storage ?? ""}</p>
                      </div>
                      <div className="text-right">
                        <Badge tone={st === "scaduta" ? "danger" : st === "oggi" ? "warn" : "neutral"}>{st === "scaduta" ? "Scaduta" : relativeFromNow(new Date(l.expires_at), now)}</Badge>
                        <p className="mt-0.5 text-xs text-muted">{formatDateTime(l.expires_at, tz)}</p>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" | "ok" | "warn" }) {
  return (
    <Card className="p-3.5">
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className={cx("mt-1 text-xl font-extrabold", tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-night")}>{value}</p>
    </Card>
  );
}
