import { applyInsightFeedback, buildInsights, INSIGHT_RULE_LABEL, type Insight } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader } from "@/components/ui";
import { getInsightSignals } from "@/lib/analytics-queries";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { setInsightFeedback } from "./actions";

export const metadata = { title: "Assistente operativo" };
export const dynamic = "force-dynamic";

const SEV_TONE = { alta: "danger", media: "warn", bassa: "neutral" } as const;
const SEV_LABEL = { alta: "Priorità alta", media: "Da valutare", bassa: "Opportunità" } as const;

export default async function AssistentePage() {
  const ctx = await requirePerm("analytics.view", "finance.view");
  const res = await getInsightSignals(ctx.facility.id);
  const tz = ctx.facility.timezone;

  if (res.error !== null) {
    return (
      <div>
        <PageHeader title="Assistente operativo" />
        <Notice tone="danger">{res.error}</Notice>
      </div>
    );
  }
  const signals = res.data;
  const now = new Date();
  const { active, hidden } = applyInsightFeedback(buildInsights(signals, now), signals.feedback, now);

  return (
    <div>
      <PageHeader
        title="Assistente operativo"
        subtitle="Suggerimenti calcolati con regole trasparenti sui dati della struttura: per ognuno vedi cosa è stato rilevato, i numeri usati e cosa fare."
      />
      {!can(ctx, "finance.view") && (
        <div className="mb-4">
          <Notice tone="neutral">Vedi solo i suggerimenti operativi. Quelli su prezzi, food cost e margini richiedono l'accesso ai dati economici.</Notice>
        </div>
      )}

      {active.length === 0 ? (
        <Card>
          <EmptyState
            title="Nessun suggerimento in questo momento"
            text="Le regole controllano scorte e consegne, prezzi dei fornitori, food cost, sprechi, margini, personale, tempi di cucina, HACCP, manutenzioni, etichette e clienti da ricontattare. Quando un dato supera una soglia, il suggerimento compare qui."
          />
        </Card>
      ) : (
        <ul className="space-y-4">
          {active.map((i) => (
            <li key={i.key}>
              <InsightCard insight={i} tz={tz} />
            </li>
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <details className="mt-6 rounded-xl border border-sand-deep bg-white px-4 py-3">
          <summary className="cursor-pointer text-sm font-bold text-night">{hidden.length} suggerimenti ignorati o rimandati</summary>
          <ul className="mt-3 divide-y divide-sand">
            {hidden.map(({ insight, feedback }) => (
              <li key={insight.key} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-bold text-night">{insight.title}</span>
                  <span className="block text-xs text-muted">
                    {feedback.action === "ignorato" ? "Ignorato" : "Rimandato"} fino a {formatDateTime(feedback.until, tz)}
                  </span>
                </span>
                <ActionForm action={setInsightFeedback}>
                  <input type="hidden" name="key" value={insight.key} />
                  <input type="hidden" name="action" value="ripristina" />
                  <SubmitButton variant="ghost" pendingText="…">Ripristina</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-6 text-xs text-muted">
        Aggiornato {formatDateTime(signals.generated_at ?? new Date(), tz)}. I suggerimenti si basano solo sui dati registrati: se un dato manca, la regola non scatta.
      </p>
    </div>
  );
}

function InsightCard({ insight: i }: { insight: Insight; tz: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-sand px-4 py-3">
        <Badge tone={SEV_TONE[i.severity]}>{SEV_LABEL[i.severity]}</Badge>
        <Badge>{INSIGHT_RULE_LABEL[i.rule]}</Badge>
        {i.economic && <Badge tone="night">Dati economici</Badge>}
      </div>
      <div className="space-y-3 px-4 py-3">
        <h2 className="text-[1.05rem] leading-snug font-bold text-night">{i.title}</h2>
        <Section label="Cosa è stato rilevato">{i.detected}</Section>
        <div>
          <p className="text-xs font-bold text-muted uppercase">Dati usati</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            {i.data.map((d) => (
              <div key={d.label} className="flex justify-between gap-3 border-b border-sand/70 py-1">
                <dt className="text-muted">{d.label}</dt>
                <dd className="font-bold text-night tabular-nums">{d.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-1 text-xs text-muted">Periodo: {i.period}</p>
        </div>
        <Section label="Perché è importante">{i.why}</Section>
        <Section label="Impatto stimato">{i.impact}</Section>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-sand bg-warm px-4 py-3">
        <LinkButton href={i.action.href}>{i.action.label}</LinkButton>
        <ActionForm action={setInsightFeedback} className="flex flex-wrap gap-2">
          <input type="hidden" name="key" value={i.key} />
          <input type="hidden" name="days" value="1" />
          <SubmitButton variant="secondary" name="action" value="rimandato" pendingText="…">Ricordamelo domani</SubmitButton>
          <SubmitButton variant="ghost" name="action" value="ignorato" pendingText="…">Ignora</SubmitButton>
        </ActionForm>
      </div>
    </Card>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold text-muted uppercase">{label}</p>
      <p className="mt-0.5 text-sm text-ink">{children}</p>
    </div>
  );
}
