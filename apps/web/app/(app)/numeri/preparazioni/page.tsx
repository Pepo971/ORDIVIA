import { addDays, prepPlan, WEATHER_OPTIONS, type WeatherKey } from "@ordivia/domain";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { BarList, DecisionNote } from "@/components/charts/charts";
import { Badge, Card, CardHeader, cx, EmptyState, Field, Input, LinkButton, Notice, PageHeader } from "@/components/ui";
import { getAnalyticsSettings, getPrepHistory, type AnalyticsSettings } from "@/lib/analytics-queries";
import { can, requirePerm } from "@/lib/context";
import { formatDate, formatQty } from "@/lib/format";
import { today } from "@/lib/queries";
import { saveAnalyticsSettings } from "./actions";

export const metadata = { title: "Preparazioni" };
export const dynamic = "force-dynamic";

const BASE = "/numeri/preparazioni";
const CONF = {
  alta: { tone: "ok", text: "Affidabilità alta" },
  media: { tone: "warn", text: "Affidabilità media" },
  bassa: { tone: "danger", text: "Affidabilità bassa" },
  nessuna: { tone: "neutral", text: "Nessuno storico" },
} as const;

const weekdayPlural = (d: string) =>
  ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabati", "domeniche"][(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7];
const fmt = (v: number, d = 2) => new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(v);

function weatherFactor(s: AnalyticsSettings, w: WeatherKey | null) {
  if (w === "soleggiato") return s.weather_sunny;
  if (w === "pioggia") return s.weather_rain;
  if (w === "variabile") return s.weather_variable;
  return 1;
}

export default async function PreparazioniPage({ searchParams }: { searchParams: Promise<{ data?: string; meteo?: string; settimane?: string }> }) {
  const ctx = await requirePerm("analytics.view", "menu.manage");
  const sp = await searchParams;
  const tz = ctx.facility.timezone;
  const todayStr = today(ctx);
  const date = sp.data && /^\d{4}-\d{2}-\d{2}$/.test(sp.data) && !Number.isNaN(Date.parse(sp.data)) ? sp.data : addDays(todayStr, 1);
  const settings = await getAnalyticsSettings(ctx.facility.id);
  const weeksParam = Number(sp.settimane);
  const weeks = Number.isInteger(weeksParam) && weeksParam >= 1 && weeksParam <= 26 ? weeksParam : settings.prep_weeks;
  const weather = (WEATHER_OPTIONS.find((w) => w.key === sp.meteo)?.key ?? null) as WeatherKey | null;
  const wf = weatherFactor(settings, weather);
  const editable = can(ctx, "menu.manage", "org.manage");
  const canOrder = can(ctx, "purchasing.request", "purchasing.approve");

  const res = await getPrepHistory(ctx.facility.id, date, weeks);
  const link = (over: Record<string, string | null>) => {
    const q = new URLSearchParams({ data: date, settimane: String(weeks), ...(weather ? { meteo: weather } : {}) });
    for (const [k, v] of Object.entries(over)) v == null ? q.delete(k) : q.set(k, v);
    return `${BASE}?${q.toString()}`;
  };

  return (
    <div>
      <PageHeader title="Preparazioni" subtitle="Quante porzioni preparare per un servizio, e quali ingredienti mancano, a partire dalle vendite reali." />

      <form action={BASE} className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-sand-deep bg-white p-3">
        <label className="text-sm">
          <span className="mb-1 block font-bold text-night">Servizio del</span>
          <input type="date" name="data" defaultValue={date} className="h-11 rounded-xl border border-sand-deep px-3" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-bold text-night">Settimane di storico</span>
          <select name="settimane" defaultValue={String(weeks)} className="h-11 rounded-xl border border-sand-deep px-3">
            {[2, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
            {![2, 4, 6, 8, 12].includes(weeks) && <option value={weeks}>{weeks}</option>}
          </select>
        </label>
        {weather && <input type="hidden" name="meteo" value={weather} />}
        <button className="h-11 rounded-xl bg-night px-4 text-sm font-bold text-warm">Calcola</button>
      </form>

      <nav className="mb-5 flex flex-wrap items-center gap-2" aria-label="Meteo previsto">
        <span className="text-sm font-bold text-night">Meteo previsto:</span>
        <a href={link({ meteo: null })} aria-current={!weather ? "page" : undefined} className={cx("rounded-full px-3 py-2 text-sm font-bold", !weather ? "bg-night text-warm" : "bg-sand text-night")}>
          Non considerare
        </a>
        {WEATHER_OPTIONS.map((w) => (
          <a key={w.key} href={link({ meteo: w.key })} aria-current={weather === w.key ? "page" : undefined} className={cx("rounded-full px-3 py-2 text-sm font-bold", weather === w.key ? "bg-night text-warm" : "bg-sand text-night")}>
            {w.label} ×{fmt(weatherFactor(settings, w.key))}
          </a>
        ))}
      </nav>

      {res.error !== null ? (
        <Notice tone="danger">{res.error}</Notice>
      ) : (
        (() => {
          const h = res.data;
          const plan = prepPlan({ history: h.history, menu: h.menu, products: h.products, bookedCovers: h.booked_covers, weatherFactor: wf });
          const conf = CONF[plan.confidence];
          const missing = plan.ingredients.filter((i) => i.missing > 0);
          return (
            <>
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className="font-display text-lg font-semibold text-night">{formatDate(date, tz)}</span>
                <Badge tone={conf.tone}>{conf.text}</Badge>
                <span className="text-sm text-muted">
                  {plan.weeksWithData} su {plan.weeksRequested} {plan.weeksRequested === 1 ? "settimana" : "settimane"} con vendite nello stesso giorno
                </span>
              </div>

              {plan.items.length === 0 ? (
                <Card>
                  <EmptyState
                    title="Nessuno storico per questo giorno della settimana"
                    text={`Non ci sono vendite registrate nei ${weeks} ${weekdayPlural(date)} precedenti. Le stime compaiono dopo il primo servizio registrato in cassa: non inventiamo numeri.`}
                    action={<LinkButton href={link({ settimane: "12" })} variant="secondary">Prova con 12 settimane</LinkButton>}
                  />
                </Card>
              ) : (
                <div className="grid gap-5 lg:grid-cols-2">
                  <Card>
                    <CardHeader title="Porzioni da preparare" hint={`Fattore applicato ×${fmt(plan.factor)}`} />
                    <BarList
                      data={plan.items.map((i) => ({
                        key: i.id,
                        label: i.name,
                        value: i.portions,
                        display: `${i.portions} porz.`,
                        hint: `media ${fmt(i.baseline, 1)} · min ${i.min} · max ${i.max}`,
                      }))}
                    />
                    <DecisionNote>
                      prepara le quantità in alto per prime; per le voci con min e max molto distanti tieni una parte da completare in servizio.
                    </DecisionNote>
                  </Card>

                  <Card>
                    <CardHeader title="Ingredienti: fabbisogno e giacenza" hint="Dalle ricette (scarto incluso), giacenza attuale di tutti i magazzini della struttura" />
                    {plan.ingredients.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-muted">Le voci previste non hanno ricette: aggiungile nel menu per calcolare gli ingredienti.</p>
                    ) : (
                      <>
                        <ul className="divide-y divide-sand">
                          {plan.ingredients.map((g) => (
                            <li key={g.product_id} className={cx("flex items-center gap-3 px-4 py-2.5 text-sm", g.missing > 0 && "bg-danger-soft/40")}>
                              <span className="min-w-0 flex-1">
                                <span className="font-bold text-night">{g.name}</span>
                                <span className="block text-xs text-muted">
                                  serve {formatQty(g.need, g.unit)} · in giacenza {formatQty(g.on_hand, g.unit)}
                                </span>
                              </span>
                              {g.missing > 0 ? (
                                <span className="text-right font-extrabold text-danger">
                                  {formatQty(g.missing, g.unit)}
                                  <span className="block text-xs font-bold">da ordinare / preparare</span>
                                </span>
                              ) : (
                                <Badge tone="ok">Coperto</Badge>
                              )}
                            </li>
                          ))}
                        </ul>
                        <DecisionNote tone={missing.length ? "danger" : "ok"}>
                          {missing.length
                            ? `${missing.length} ${missing.length === 1 ? "ingrediente non basta" : "ingredienti non bastano"}: ordina in tempo per la consegna o pianifica la preparazione.`
                            : "la giacenza copre tutto il fabbisogno stimato."}
                        </DecisionNote>
                        {missing.length > 0 && canOrder && (
                          <div className="px-4 pb-4">
                            <LinkButton href="/acquisti/riordino" variant="secondary">Apri il riordino</LinkButton>
                          </div>
                        )}
                      </>
                    )}
                  </Card>
                </div>
              )}

              <Card className="mt-5">
                <CardHeader title="Come è calcolato" />
                <div className="space-y-2 px-4 py-3 text-sm text-ink">
                  <p className="rounded-xl bg-warm px-3 py-2 font-bold text-night">
                    Porzioni = ⌈ media vendite dello stesso giorno della settimana × fattore coperti × fattore meteo ⌉
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>
                      <strong>Media vendite</strong>: pezzi venduti in cassa negli ultimi {weeks} {weekdayPlural(date)}; le settimane senza comande (giorni di chiusura) sono escluse. Settimane con dati: {plan.weeksWithData}.
                    </li>
                    <li>
                      <strong>Fattore coperti</strong>: ×{fmt(plan.coversFactor)}.{" "}
                      {h.reservations_available
                        ? `Coperti già prenotati ${h.booked_covers ?? 0} contro una media storica di ${fmt(plan.avgCovers, 1)}: le prenotazioni alzano la stima solo se superano la media (massimo ×3), non la riducono mai.`
                        : "Il modulo prenotazioni non è attivo: nessuna correzione per i coperti prenotati."}
                    </li>
                    <li>
                      <strong>Fattore meteo</strong>: ×{fmt(plan.weatherFactor)} {weather ? `(${WEATHER_OPTIONS.find((w) => w.key === weather)?.label.toLowerCase()})` : "(non considerato)"}.
                    </li>
                    <li>
                      <strong>Ingredienti</strong> = porzioni × quantità a porzione della ricetta (con lo scarto). Da ordinare/preparare = fabbisogno − giacenza attuale, senza sottrarre altre preparazioni.
                    </li>
                    <li>
                      <strong>Affidabilità</strong>: alta con almeno 4 settimane di dati, media con 2–3, bassa con 1.
                    </li>
                  </ul>
                </div>
              </Card>
            </>
          );
        })()
      )}

      {editable && (
        <Card className="mt-5">
          <CardHeader title="Impostazioni" hint="Valgono per tutta la struttura" />
          <ActionForm action={saveAnalyticsSettings} className="p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Soleggiato ×"><Input name="weather_sunny" inputMode="decimal" defaultValue={fmt(settings.weather_sunny)} required /></Field>
              <Field label="Variabile ×"><Input name="weather_variable" inputMode="decimal" defaultValue={fmt(settings.weather_variable)} required /></Field>
              <Field label="Pioggia ×"><Input name="weather_rain" inputMode="decimal" defaultValue={fmt(settings.weather_rain)} required /></Field>
              <Field label="Settimane di storico" hint="Predefinite, 1–26"><Input name="prep_weeks" type="number" min={1} max={26} defaultValue={settings.prep_weeks} required /></Field>
              <Field label="Obiettivo tempi cucina" hint="Minuti da inviata a pronta/servita"><Input name="ticket_target_minutes" type="number" min={1} max={180} defaultValue={settings.ticket_target_minutes} required /></Field>
            </div>
            <div className="mt-4">
              <SubmitButton>Salva impostazioni</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
