import Link from "next/link";
import { deadlineUrgency, rankToday, todayScore, zonedTimeToUtc, type TodayItem } from "@ordivia/domain";
import { Badge, Card, cx, EmptyState, Notice } from "@/components/ui";
import { can, getContext } from "@/lib/context";
import { formatDate, formatTime, relativeFromNow } from "@/lib/format";
import { bestOfferByProduct, getOffers, getStock, getSuppliers, supplierWindow, today } from "@/lib/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Oggi" };
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<TodayItem["kind"], string> = {
  ordine_da_inviare: "Ordine",
  ordine_da_approvare: "Da approvare",
  richiesta_reparto: "Richiesta",
  consegna_attesa: "Consegna",
  sotto_scorta: "Scorte",
  attivita_scaduta: "In ritardo",
  attivita_oggi: "Attività",
  attivita_da_verificare: "Verifica",
  haccp: "HACCP",
  richiesta_personale: "Personale",
};

export default async function OggiPage({ searchParams }: { searchParams: Promise<{ benvenuto?: string; negato?: string }> }) {
  const sp = await searchParams;
  const ctx = await getContext();
  const supabase = await createClient();
  const tz = ctx.facility.timezone;
  const now = new Date();
  const todayStr = today(ctx);
  const items: TodayItem[] = [];

  const isApprover = can(ctx, "purchasing.approve");
  const canReceive = can(ctx, "receiving.perform");
  const canManageTasks = can(ctx, "tasks.manage");
  const canSeeStock = can(ctx, "inventory.view");

  const [stock, suppliers, offers, ordersRes, requestsRes, myTasksRes, teamTasksRes] = await Promise.all([
    canSeeStock ? getStock(ctx) : Promise.resolve([]),
    isApprover ? getSuppliers(ctx.org.id) : Promise.resolve([]),
    isApprover ? getOffers(ctx.org.id) : Promise.resolve([]),
    isApprover || canReceive
      ? supabase.from("purchase_orders").select("id, number, status, expected_delivery, supplier_id, suppliers(name)").eq("facility_id", ctx.facility.id).in("status", ["bozza", "approvato", "inviato", "parziale"])
      : Promise.resolve({ data: [] }),
    isApprover
      ? supabase.from("purchase_requests").select("id, created_at, department_id, purchase_request_lines(count)").eq("facility_id", ctx.facility.id).eq("status", "inviata")
      : Promise.resolve({ data: [] }),
    supabase.from("tasks").select("id, title, due_at, status").eq("facility_id", ctx.facility.id).eq("assignee_id", ctx.userId).in("status", ["assegnata", "vista", "iniziata"]),
    canManageTasks
      ? supabase.from("tasks").select("id, title, due_at, status, assignee_id").eq("facility_id", ctx.facility.id).in("status", ["assegnata", "vista", "iniziata", "completata"]).neq("assignee_id", ctx.userId)
      : Promise.resolve({ data: [] }),
  ]);

  // --- Ordini: cut-off fornitori per i prodotti sotto scorta ---
  const below = stock.filter((s) => s.belowMin);
  const orders = (ordersRes.data ?? []) as unknown as { id: string; number: string; status: string; expected_delivery: string | null; supplier_id: string; suppliers: { name: string } | null }[];
  if (isApprover) {
    const activeSuppliers = new Map(suppliers.filter((s) => s.active).map((s) => [s.id, s]));
    const best = bestOfferByProduct(offers, new Set(activeSuppliers.keys()));
    const bySupplier = new Map<string, string[]>();
    const orphan: string[] = [];
    for (const l of below) {
      const o = best.get(l.product.id);
      if (!o) orphan.push(l.product.name);
      else bySupplier.set(o.supplier_id, [...(bySupplier.get(o.supplier_id) ?? []), l.product.name]);
    }
    for (const [supId, names] of bySupplier) {
      const sup = activeSuppliers.get(supId)!;
      const w = supplierWindow(sup, tz, now);
      const draft = orders.find((o) => o.supplier_id === supId && o.status === "bozza");
      items.push({
        id: `cut-${supId}`,
        kind: "ordine_da_inviare",
        title: `Ordina da ${sup.name}`,
        detail: `${names.length} ${names.length === 1 ? "prodotto" : "prodotti"} sotto scorta: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}${w ? ` · consegna ${formatDate(w.deliveryDate, tz)}` : ""}`,
        deadline: w?.orderBy,
        href: draft ? `/acquisti/ordini/${draft.id}` : `/acquisti/riordino?fornitore=${supId}`,
        weight: names.length,
      });
    }
    if (orphan.length > 0) {
      items.push({
        id: "orphan",
        kind: "sotto_scorta",
        title: `${orphan.length} prodotti sotto scorta senza fornitore a listino`,
        detail: orphan.slice(0, 4).join(", "),
        href: "/acquisti/fornitori",
      });
    }
    for (const o of orders.filter((o) => o.status === "bozza" && !bySupplier.has(o.supplier_id))) {
      items.push({ id: `po-${o.id}`, kind: "ordine_da_approvare", title: `Ordine ${o.number} in bozza`, detail: o.suppliers?.name, href: `/acquisti/ordini/${o.id}` });
    }
    for (const o of orders.filter((o) => o.status === "approvato")) {
      const sup = suppliers.find((s) => s.id === o.supplier_id);
      const w = sup ? supplierWindow(sup, tz, now) : null;
      items.push({ id: `po-${o.id}`, kind: "ordine_da_inviare", title: `Invia l’ordine ${o.number}`, detail: `Approvato · ${o.suppliers?.name ?? ""}`, deadline: w?.orderBy, href: `/acquisti/ordini/${o.id}` });
    }
    for (const r of (requestsRes.data ?? []) as unknown as { id: string; department_id: string | null; purchase_request_lines: { count: number }[] }[]) {
      const dep = ctx.departments.find((d) => d.id === r.department_id)?.name ?? "Reparto";
      const n = r.purchase_request_lines?.[0]?.count ?? 0;
      items.push({ id: `req-${r.id}`, kind: "richiesta_reparto", title: `Richiesta d’acquisto: ${dep}`, detail: `${n} ${n === 1 ? "prodotto" : "prodotti"}`, href: `/acquisti?tab=richieste` });
    }
  } else if (below.length > 0 && can(ctx, "purchasing.request")) {
    items.push({
      id: "below",
      kind: "sotto_scorta",
      title: `${below.length} prodotti sotto scorta`,
      detail: below.slice(0, 4).map((b) => b.product.name).join(", "),
      href: "/acquisti/richieste/nuova?da=scorte",
      weight: below.length,
    });
  }

  // --- Consegne attese ---
  if (canReceive) {
    for (const o of orders.filter((o) => (o.status === "inviato" || o.status === "parziale") && (!o.expected_delivery || o.expected_delivery <= todayStr))) {
      items.push({
        id: `del-${o.id}`,
        kind: "consegna_attesa",
        title: `Consegna ${o.suppliers?.name ?? ""}`,
        detail: `${o.number}${o.status === "parziale" ? " · arrivata in parte" : ""}${o.expected_delivery ? ` · prevista ${formatDate(o.expected_delivery, tz)}` : ""}`,
        href: `/acquisti/ordini/${o.id}`,
      });
    }
  }

  // --- Attività ---
  for (const t of (myTasksRes.data ?? []) as { id: string; title: string; due_at: string | null; status: string }[]) {
    const due = t.due_at ? new Date(t.due_at) : undefined;
    const overdue = due && due < now;
    if (!due || overdue || todayStr === new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(due)) {
      items.push({ id: `t-${t.id}`, kind: overdue ? "attivita_scaduta" : "attivita_oggi", title: t.title, detail: due ? `Entro le ${formatTime(due, tz)}` : "Senza scadenza", deadline: due, href: `/lavoro#${t.id}` });
    }
  }
  if (canManageTasks) {
    const team = (teamTasksRes.data ?? []) as { id: string; title: string; due_at: string | null; status: string }[];
    const toVerify = team.filter((t) => t.status === "completata");
    if (toVerify.length > 0) {
      items.push({ id: "verify", kind: "attivita_da_verificare", title: `${toVerify.length} attività da verificare`, detail: toVerify.slice(0, 3).map((t) => t.title).join(", "), href: "/lavoro?vista=team" });
    }
    for (const t of team.filter((t) => t.status !== "completata" && t.due_at && new Date(t.due_at) < now)) {
      items.push({ id: `tl-${t.id}`, kind: "attivita_scaduta", title: t.title, detail: "Non ancora completata dal collega", deadline: new Date(t.due_at!), href: "/lavoro?vista=team" });
    }
  }

  // --- HACCP: temperature non ancora registrate oggi, etichette in scadenza entro 24 h ---
  if (can(ctx, "haccp.record")) {
    const dayStart = zonedTimeToUtc(...(todayStr.split("-").map(Number) as [number, number, number]), 0, 0, tz).toISOString();
    const [{ data: equipment }, { data: logs }, { data: labels }] = await Promise.all([
      supabase.from("haccp_equipment").select("id, name").eq("facility_id", ctx.facility.id).eq("active", true),
      supabase.from("haccp_temperature_logs").select("equipment_id, out_of_range").eq("facility_id", ctx.facility.id).gte("recorded_at", dayStart),
      supabase
        .from("haccp_labels")
        .select("id, name, expires_at")
        .eq("facility_id", ctx.facility.id)
        .eq("status", "attiva")
        .lte("expires_at", new Date(now.getTime() + 24 * 3600_000).toISOString())
        .order("expires_at"),
    ]);
    const done = new Set((logs ?? []).map((l) => l.equipment_id));
    const missing = (equipment ?? []).filter((e) => !done.has(e.id));
    if (missing.length > 0) {
      items.push({ id: "haccp-temp", kind: "haccp", title: `Temperature da registrare: ${missing.length}`, detail: missing.slice(0, 4).map((e) => e.name).join(", "), href: "/servizio/menu/haccp/temperature", weight: missing.length });
    }
    const outOfRange = (logs ?? []).filter((l) => l.out_of_range).length;
    if (outOfRange > 0) {
      items.push({ id: "haccp-out", kind: "haccp", title: `${outOfRange} temperature fuori limite oggi`, detail: "Verifica l’azione correttiva", href: "/servizio/menu/haccp/temperature", weight: 10 });
    }
    for (const l of (labels ?? []) as { id: string; name: string; expires_at: string }[]) {
      const exp = new Date(l.expires_at);
      items.push({ id: `lbl-${l.id}`, kind: "haccp", title: exp < now ? `Scaduto: ${l.name}` : `In scadenza: ${l.name}`, detail: "Consuma o scarta e aggiorna l’etichetta", deadline: exp, href: `/servizio/menu/haccp/etichette/${l.id}` });
    }
  }

  // --- Personale: ferie e cambi turno ---
  if (can(ctx, "shifts.manage")) {
    const [{ count: leaves }, { count: swaps }] = await Promise.all([
      supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("facility_id", ctx.facility.id).eq("status", "in_attesa"),
      supabase.from("shift_swaps").select("id", { count: "exact", head: true }).eq("facility_id", ctx.facility.id).eq("status", "accettato"),
    ]);
    const n = (leaves ?? 0) + (swaps ?? 0);
    if (n > 0) items.push({ id: "staff-req", kind: "richiesta_personale", title: `${n} richieste del personale da decidere`, detail: `${leaves ?? 0} assenze · ${swaps ?? 0} cambi turno`, href: "/lavoro/richieste" });
  }
  if (can(ctx, "shifts.view")) {
    const { count: offered } = await supabase
      .from("shift_swaps")
      .select("id", { count: "exact", head: true })
      .eq("facility_id", ctx.facility.id)
      .eq("status", "offerto")
      .eq("to_user", ctx.userId);
    if ((offered ?? 0) > 0) items.push({ id: "swap-offer", kind: "richiesta_personale", title: `Un collega ti offre ${offered === 1 ? "un turno" : `${offered} turni`}`, href: "/lavoro/richieste" });
  }

  const ranked = rankToday(items, now);
  const now_ = ranked.filter((i) => todayScore(i, now) >= 80);
  const rest = ranked.filter((i) => todayScore(i, now) < 80);

  const hour = Number(new Intl.DateTimeFormat("it-IT", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
  const greeting = hour < 13 ? "Buongiorno" : hour < 18 ? "Buon pomeriggio" : "Buonasera";
  const firstName = ctx.fullName.split(" ")[0];

  const setupNeeded = can(ctx, "suppliers.manage") && suppliers.length === 0;

  return (
    <div>
      <div className="mb-6">
        <p className="text-sm font-bold tracking-wide text-teal-deep uppercase">{formatDate(now, tz)} · {ctx.facility.name}</p>
        <h1 className="mt-1 font-display text-[2rem] leading-tight font-semibold text-night">
          {greeting}, {firstName}
        </h1>
        <p className="mt-1 text-muted">
          {ranked.length === 0 ? "Niente in sospeso: la giornata è in ordine." : `${ranked.length} ${ranked.length === 1 ? "cosa richiede" : "cose richiedono"} attenzione${now_.length ? `, ${now_.length} adesso` : ""}.`}
        </p>
      </div>

      {sp.negato && <div className="mb-4"><Notice tone="warn">Non hai accesso a quella sezione con il tuo ruolo.</Notice></div>}
      {sp.benvenuto && <div className="mb-4"><Notice>Struttura creata. Reparti e magazzini sono pronti: completa i primi passi qui sotto.</Notice></div>}

      {setupNeeded && <SetupSteps />}

      {now_.length > 0 && <Section title="Adesso" items={now_} tz={tz} now={now} urgent />}
      {rest.length > 0 && <Section title="Oggi" items={rest} tz={tz} now={now} />}
      {ranked.length === 0 && !setupNeeded && (
        <Card>
          <EmptyState title="Tutto in ordine" text="Nessun ordine in scadenza, nessuna consegna da controllare, nessuna attività in ritardo." />
        </Card>
      )}
    </div>
  );
}

function Section({ title, items, tz, now, urgent = false }: { title: string; items: TodayItem[]; tz: string; now: Date; urgent?: boolean }) {
  return (
    <section className="mb-6">
      <h2 className={cx("mb-2 text-sm font-extrabold tracking-wide uppercase", urgent ? "text-danger" : "text-muted")}>{title}</h2>
      <Card className="overflow-hidden">
        <ul>
          {items.map((i) => {
            const u = i.deadline ? deadlineUrgency(i.deadline, tz, now) : null;
            return (
              <li key={i.id} className="border-b border-sand last:border-b-0">
                <Link href={i.href} className="flex items-start gap-3 px-4 py-3.5 hover:bg-warm">
                  <span
                    className={cx(
                      "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                      u === "scaduto" || u === "critico" ? "bg-danger" : u === "oggi" ? "bg-warn" : i.kind.startsWith("attivita") ? "bg-night-3" : "bg-teal",
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-night">{i.title}</span>
                      <Badge tone={i.kind === "attivita_scaduta" ? "danger" : "neutral"}>{KIND_LABEL[i.kind]}</Badge>
                    </span>
                    {i.detail && <span className="mt-0.5 block truncate text-sm text-muted">{i.detail}</span>}
                  </span>
                  {i.deadline && (
                    <span className="shrink-0 text-right">
                      <span className={cx("block text-sm font-extrabold", u === "scaduto" || u === "critico" ? "text-danger" : "text-night")}>
                        {u === "scaduto" ? "Scaduto" : `entro ${formatTime(i.deadline, tz)}`}
                      </span>
                      <span className="block text-xs text-muted">{u === "prossimo" ? formatDate(i.deadline, tz) : relativeFromNow(i.deadline, now)}</span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
  );
}

function SetupSteps() {
  const steps = [
    { href: "/acquisti/fornitori/nuovo", title: "Aggiungi il primo fornitore", text: "Giorni di consegna e ora limite: Ordivia ti avviserà prima del cut-off." },
    { href: "/scorte/prodotti", title: "Crea i prodotti e le scorte minime", text: "Bastano i 20 prodotti che finiscono più spesso." },
    { href: "/gestione/team", title: "Invita il team", text: "Ognuno vede solo ciò che gli serve per il proprio lavoro." },
  ];
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-extrabold tracking-wide text-muted uppercase">Primi passi</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        {steps.map((s, i) => (
          <Link key={s.href} href={s.href} className="rounded-[var(--radius-card)] border border-sand-deep bg-white p-4 hover:border-teal">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-night text-sm font-bold text-warm">{i + 1}</span>
            <span className="mt-3 block font-bold text-night">{s.title}</span>
            <span className="mt-1 block text-sm text-muted">{s.text}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
