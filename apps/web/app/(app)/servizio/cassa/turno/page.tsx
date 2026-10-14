import { ActionForm, SubmitButton } from "@/components/action-form";
import { LiveRefresh } from "@/components/live-refresh";
import { Card, CardHeader, Field, Input, LinkButton, Notice, PageHeader, Row, Textarea, cx } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { formatDateTime, formatEur } from "@/lib/format";
import { getOpenCashSession } from "@/lib/pos-queries";
import { createClient } from "@/lib/supabase/server";
import { closeCashSession, openCashSession } from "../actions";

export const metadata = { title: "Turno di cassa" };
export const dynamic = "force-dynamic";

interface Summary {
  opening_float: number;
  cash: number;
  card: number;
  other: number;
  expected_cash: number;
  payments: number;
  da_fiscalizzare: number;
}

export default async function TurnoPage({ searchParams }: { searchParams: Promise<{ chiuso?: string }> }) {
  const ctx = await requirePerm("pos.supervise");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const supabase = await createClient();
  const [session, historyRes] = await Promise.all([
    getOpenCashSession(ctx.facility.id),
    supabase
      .from("pos_cash_sessions")
      .select("id, opened_at, closed_at, opening_float, expected_cash, counted_cash, difference, note")
      .eq("facility_id", ctx.facility.id)
      .eq("status", "chiusa")
      .order("closed_at", { ascending: false })
      .limit(15),
  ]);
  let summary: Summary | null = null;
  if (session) {
    const { data } = await supabase.rpc("pos_cash_session_summary", { p_session: session.id }).single();
    if (data) summary = Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, Number(v)])) as unknown as Summary;
  }
  const history = (historyRes.data ?? []).map((h) => ({
    ...h,
    expected_cash: Number(h.expected_cash),
    counted_cash: Number(h.counted_cash),
    difference: Number(h.difference),
  }));
  const justClosed = sp.chiuso ? history.find((h) => h.id === sp.chiuso) : undefined;

  return (
    <div>
      <LiveRefresh tables={["pos_payments", "pos_cash_sessions"]} facilityId={ctx.facility.id} />
      <PageHeader title="Turno di cassa" subtitle="Fondo, incassi del turno e quadratura del contante." action={<LinkButton href="/servizio/cassa" variant="secondary">Cassa</LinkButton>} />

      {justClosed && (
        <div className="mb-4">
          <Notice tone={justClosed.difference === 0 ? "ok" : "warn"}>
            Turno chiuso. Attesi {formatEur(justClosed.expected_cash)}, contati {formatEur(justClosed.counted_cash)}:{" "}
            {justClosed.difference === 0 ? "cassa in quadra." : `differenza ${justClosed.difference > 0 ? "+" : ""}${formatEur(justClosed.difference)}.`}
          </Notice>
        </div>
      )}

      {!session ? (
        <Card className="mb-5">
          <CardHeader title="Apri il turno" hint="Il fondo cassa è il contante nel cassetto all'inizio." />
          <ActionForm action={openCashSession} className="p-4">
            <Field label="Fondo cassa (€)">
              <Input name="float" inputMode="decimal" required placeholder="150,00" className="text-lg font-bold" />
            </Field>
            <div className="mt-4"><SubmitButton pendingText="Apertura…">Apri turno</SubmitButton></div>
          </ActionForm>
        </Card>
      ) : (
        <Card className="mb-5">
          <CardHeader title={`Turno aperto dal ${formatDateTime(session.opened_at, tz)}`} />
          {summary && (
            <dl className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
              <Stat label="Fondo" value={formatEur(summary.opening_float)} />
              <Stat label="Contanti" value={formatEur(summary.cash)} />
              <Stat label="Carta" value={formatEur(summary.card)} />
              <Stat label="Altro" value={formatEur(summary.other)} />
              <div className="col-span-2 rounded-xl bg-night p-3 text-warm sm:col-span-4">
                <dt className="text-xs font-bold uppercase opacity-70">Contanti attesi nel cassetto</dt>
                <dd className="font-display text-3xl font-semibold">{formatEur(summary.expected_cash)}</dd>
              </div>
            </dl>
          )}
          {summary && summary.da_fiscalizzare > 0 && (
            <div className="px-4 pb-2">
              <Notice tone="warn">{summary.da_fiscalizzare} pagamenti risultano senza scontrino segnato: verifica sul registratore telematico prima di chiudere.</Notice>
            </div>
          )}
          <ActionForm action={closeCashSession} className="border-t border-sand p-4">
            <input type="hidden" name="session_id" value={session.id} />
            <Field label="Contante contato (€)" hint="Conta il cassetto senza guardare l'atteso: la differenza comparirà alla chiusura.">
              <Input name="counted" inputMode="decimal" required className="text-lg font-bold" />
            </Field>
            <div className="mt-3">
              <Field label="Note">
                <Textarea name="note" rows={2} maxLength={1000} placeholder="es. prelievo per fornitore, banconota sospetta" />
              </Field>
            </div>
            <div className="mt-4"><SubmitButton pendingText="Chiusura…" confirm="Chiudere il turno di cassa?">Chiudi turno</SubmitButton></div>
          </ActionForm>
        </Card>
      )}

      {history.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Turni chiusi" />
          {history.map((h) => (
            <Row key={h.id}>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-night">{formatDateTime(h.opened_at, tz)} → {formatDateTime(h.closed_at, tz)}</p>
                <p className="text-sm text-muted">Attesi {formatEur(h.expected_cash)} · contati {formatEur(h.counted_cash)}{h.note ? ` · ${h.note}` : ""}</p>
              </div>
              <span className={cx("font-bold", h.difference === 0 ? "text-ok" : "text-danger")}>
                {h.difference === 0 ? "in quadra" : `${h.difference > 0 ? "+" : ""}${formatEur(h.difference)}`}
              </span>
            </Row>
          ))}
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-warm p-3">
      <dt className="text-xs font-bold text-muted uppercase">{label}</dt>
      <dd className="text-lg font-bold text-night">{value}</dd>
    </div>
  );
}
