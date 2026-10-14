import { headers } from "next/headers";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { ALLERGEN_LABEL, expiryState, isAllergen } from "@ordivia/domain";
import { SubmitButton } from "@/components/action-form";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { formatDateTime } from "@/lib/format";
import { getLabel, getMenuItem } from "@/lib/menu-queries";
import { closeLabel } from "../../actions";
import { PrintButton } from "../../print-button";

export const metadata = { title: "Etichetta" };
export const dynamic = "force-dynamic";

const dt = (d: string | null, tz: string) =>
  d ? new Intl.DateTimeFormat("it-IT", { timeZone: tz, day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "—";

export default async function LabelPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stampa?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePerm("haccp.record", "menu.manage", "pos.kitchen");
  const label = await getLabel(id);
  if (!label) notFound();
  const tz = ctx.facility.timezone;

  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  // Il QR contiene solo un token casuale: chi lo legge deve essere autenticato e autorizzato nella struttura.
  const qrSvg = await QRCode.toString(`${origin}/servizio/menu/haccp/q/${label.token}`, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
  const item = label.menu_item_id ? await getMenuItem(label.menu_item_id) : null;
  const allergens = label.allergens.map((a) => (isAllergen(a) ? ALLERGEN_LABEL[a] : a));
  const st = label.status === "attiva" ? expiryState(new Date(label.expires_at)) : null;

  return (
    <div>
      {/* Stampa termica 62 mm (es. Brother QL, rotolo continuo): si stampa solo l'etichetta */}
      <style>{`
        @media print {
          @page { size: 62mm 100mm; margin: 0; }
          html, body { background: #fff !important; }
          body * { visibility: hidden !important; }
          .thermal-label, .thermal-label * { visibility: visible !important; }
          .thermal-label { position: fixed; left: 0; top: 0; margin: 0 !important; border: 0 !important; box-shadow: none !important; }
        }
      `}</style>

      <PageHeader
        title={label.name}
        subtitle={`Lotto ${label.lot_code} · ${label.kind === "apertura" ? "apertura" : "preparazione"}`}
        action={
          <div className="flex flex-wrap gap-2">
            <PrintButton auto={!!sp.stampa} />
            <LinkButton href="/servizio/menu/haccp/etichette" variant="secondary">Etichette</LinkButton>
          </div>
        }
      />
      {sp.stampa && <div className="mb-4"><Notice tone="ok">Etichetta creata. Se la stampa non parte, usa «Stampa etichetta».</Notice></div>}

      <div className="grid gap-5 md:grid-cols-[auto_1fr]">
        <div
          className="thermal-label mx-auto box-border border border-dashed border-sand-deep bg-white text-black"
          style={{ width: "62mm", minHeight: "100mm", padding: "3mm", fontFamily: "Arial, Helvetica, sans-serif", fontSize: "8.5pt", lineHeight: 1.25 }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "0.4mm solid #000", paddingBottom: "1mm" }}>
            <strong style={{ fontSize: "7pt", textTransform: "uppercase" }}>{label.kind === "apertura" ? "Aperto" : "Preparato"}</strong>
            <span style={{ fontSize: "7pt" }}>{ctx.facility.name}</span>
          </div>
          <p style={{ fontSize: "12pt", fontWeight: 800, margin: "1.5mm 0", wordBreak: "break-word" }}>{label.name}</p>
          {label.quantity && <p style={{ margin: 0 }}>Quantità: {label.quantity}</p>}
          <table style={{ width: "100%", borderCollapse: "collapse", margin: "1mm 0" }}>
            <tbody>
              <tr><td>Preparato</td><td style={{ textAlign: "right", fontWeight: 700 }}>{dt(label.prepared_at, tz)}</td></tr>
              {label.opened_at && <tr><td>Aperto</td><td style={{ textAlign: "right", fontWeight: 700 }}>{dt(label.opened_at, tz)}</td></tr>}
              <tr>
                <td style={{ fontWeight: 800, fontSize: "10pt" }}>SCADENZA</td>
                <td style={{ textAlign: "right", fontWeight: 800, fontSize: "10pt" }}>{dt(label.expires_at, tz)}</td>
              </tr>
            </tbody>
          </table>
          {label.storage && <p style={{ margin: "0.5mm 0" }}>Conservare: <strong>{label.storage}</strong></p>}
          <p style={{ margin: "0.5mm 0" }}>
            Allergeni: <strong style={{ textTransform: "uppercase" }}>{allergens.length ? allergens.join(", ") : "nessuno dichiarato"}</strong>
          </p>
          {label.source_lots.length > 0 && (
            <p style={{ margin: "0.5mm 0", fontSize: "7pt", wordBreak: "break-word" }}>Lotti m.p.: {label.source_lots.map((s) => s.lot).join(", ")}</p>
          )}
          <div style={{ display: "flex", gap: "2mm", alignItems: "flex-end", marginTop: "1.5mm", borderTop: "0.4mm solid #000", paddingTop: "1.5mm" }}>
            <div style={{ width: "20mm", height: "20mm", flex: "none" }} dangerouslySetInnerHTML={{ __html: qrSvg }} />
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: "11pt", fontWeight: 800, letterSpacing: "0.02em" }}>{label.lot_code}</p>
              <p style={{ margin: 0, fontSize: "7pt" }}>Op.: {label.operator_name ?? "—"}</p>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <Card className="overflow-hidden">
            <CardHeader title="Dettagli" />
            <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 p-4 text-sm">
              <dt className="text-muted">Stato</dt>
              <dd>
                {label.status === "attiva" ? (
                  <Badge tone={st === "scaduta" ? "danger" : st === "oggi" ? "warn" : "ok"}>{st === "scaduta" ? "Scaduta" : "Attiva"}</Badge>
                ) : (
                  <Badge tone={label.status === "scartata" ? "danger" : "neutral"}>{label.status === "scartata" ? "Scartata" : "Consumata"} {formatDateTime(label.closed_at, tz)}</Badge>
                )}
              </dd>
              <dt className="text-muted">Scadenza</dt>
              <dd className="font-bold text-night">
                {formatDateTime(label.expires_at, tz)}
                {label.expiry_capped && <span className="block text-xs font-normal text-warn">Limitata dalla scadenza di un lotto di origine</span>}
              </dd>
              <dt className="text-muted">Conservabilità</dt>
              <dd>{Number(label.shelf_life_days)} giorni {label.kind === "apertura" ? "dall'apertura" : "dalla preparazione"}</dd>
              {item && (
                <>
                  <dt className="text-muted">Voce di menu</dt>
                  <dd>{item.name}</dd>
                </>
              )}
              <dt className="text-muted">Operatore</dt>
              <dd>{label.operator_name ?? "—"}</dd>
              {label.note && (
                <>
                  <dt className="text-muted">Note</dt>
                  <dd>{label.note}</dd>
                </>
              )}
            </dl>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Tracciabilità" hint="Lotti delle materie prime usate" />
            {label.source_lots.length === 0 ? (
              <p className="p-4 text-sm text-muted">Nessun lotto di origine indicato.</p>
            ) : (
              <ul className="divide-y divide-sand text-sm">
                {label.source_lots.map((s, i) => (
                  <li key={`${s.lot}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span>
                      <strong className="text-night">{s.lot}</strong>
                      {s.product_name && <span className="text-muted"> · {s.product_name}</span>}
                    </span>
                    <span className="flex items-center gap-3 text-xs text-muted">
                      {s.expires_on && `scad. ${s.expires_on.split("-").reverse().join("/")}`}
                      <a className="font-bold text-teal-deep" href={`/servizio/menu/haccp/etichette?lotto=${encodeURIComponent(s.lot)}`}>Altre preparazioni</a>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {label.status === "attiva" && can(ctx, "haccp.record") && (
            <div className="flex flex-wrap gap-2">
              <form action={closeLabel}>
                <input type="hidden" name="id" value={label.id} />
                <input type="hidden" name="status" value="consumata" />
                <SubmitButton variant="secondary" pendingText="…">Segna come consumata</SubmitButton>
              </form>
              <form action={closeLabel}>
                <input type="hidden" name="id" value={label.id} />
                <input type="hidden" name="status" value="scartata" />
                <SubmitButton variant="danger" pendingText="…" confirm="Segnare la preparazione come scartata?">Scarta</SubmitButton>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
