import { headers } from "next/headers";
import QRCode from "qrcode";
import { accentOf, compareLabels, pointKindLabel } from "@ordivia/domain";
import { Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getFacilityPublicToken, getPortalSettings, getQrPoints } from "@/lib/portal-queries";
import { PrintSheetButton } from "./print-sheet-button";
import { PortalNav } from "../portal-nav";

export const metadata = { title: "Codici QR" };
export const dynamic = "force-dynamic";

const qrSvg = (url: string) => QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" });

export default async function QrPage({ searchParams }: { searchParams: Promise<{ tipo?: string; zona?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePerm("portal.manage");
  const [points, ftoken, { settings }] = await Promise.all([getQrPoints(ctx.facility.id), getFacilityPublicToken(ctx.facility.id), getPortalSettings(ctx.facility.id)]);
  const h = await headers();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const facilityName = settings.display_name ?? ctx.facility.name;
  const accent = accentOf(settings.accent).hex;

  const kinds = [...new Set(points.map((p) => p.kind))].sort();
  const zones = [...new Set(points.filter((p) => !sp.tipo || p.kind === sp.tipo).map((p) => p.zone ?? ""))].sort();
  const shown = points
    .filter((p) => (!sp.tipo || p.kind === sp.tipo) && (sp.zona == null || sp.zona === "*" || (p.zone ?? "") === sp.zona))
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.zone ?? "").localeCompare(b.zone ?? "") || compareLabels(a.label, b.label));

  const cards = await Promise.all(
    shown.map(async (p) => {
      const url = `${origin}/p/${p.public_token}`;
      return { id: p.id, title: `${pointKindLabel("it", p.kind)} ${p.label}`, sub: p.zone, url, svg: await qrSvg(url) };
    }),
  );
  const facilityCard = ftoken ? { url: `${origin}/p/f/${ftoken}`, svg: await qrSvg(`${origin}/p/f/${ftoken}`) } : null;

  return (
    <div>
      {/* Stampa A4: solo il foglio dei QR, 3 colonne × 4 righe per pagina */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
          html, body { background: #fff !important; }
          body * { visibility: hidden !important; }
          .qr-sheet, .qr-sheet * { visibility: visible !important; }
          .qr-sheet { position: absolute; left: 0; top: 0; width: 190mm; display: grid !important; grid-template-columns: repeat(3, 1fr); gap: 4mm; }
          .qr-card { break-inside: avoid; height: 64mm; border: 0.3mm dashed #999 !important; box-shadow: none !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <PageHeader
        title="Codici QR"
        subtitle="Stampa i QR da mettere su tavoli, ombrelloni e camere. Ogni QR contiene solo un codice casuale, nessun dato interno."
        action={cards.length > 0 ? <PrintSheetButton /> : undefined}
      />
      <PortalNav active="qr" />

      {!settings.enabled && (
        <div className="mb-4 no-print">
          <Notice tone="warn">Il portale è disattivato: chi scansiona vede un avviso. Attivalo in Configurazione prima di distribuire i QR.</Notice>
        </div>
      )}

      {facilityCard && (
        <Card className="mb-5 no-print">
          <CardHeader title="QR della struttura" hint="Per ingresso, reception, volantini: menu, offerte, info e richieste (senza ordini)" />
          <div className="flex flex-wrap items-center gap-4 p-4">
            <div className="h-28 w-28 shrink-0 bg-white p-1" dangerouslySetInnerHTML={{ __html: facilityCard.svg }} />
            <div className="min-w-0 text-sm">
              <p className="font-bold text-night">{facilityName}</p>
              <p className="break-all text-muted">{facilityCard.url}</p>
              <a href={facilityCard.url} target="_blank" rel="noopener" className="mt-2 inline-block font-bold text-teal-deep">Apri l'anteprima ↗</a>
            </div>
          </div>
        </Card>
      )}

      <form className="no-print mb-4 flex flex-wrap items-end gap-3" method="get">
        <label className="block">
          <span className="mb-1 block text-sm font-bold text-night">Tipo</span>
          <Select name="tipo" defaultValue={sp.tipo ?? ""}>
            <option value="">Tutti</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{pointKindLabel("it", k)}</option>
            ))}
          </Select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-bold text-night">Zona</span>
          <Select name="zona" defaultValue={sp.zona ?? "*"}>
            <option value="*">Tutte</option>
            {zones.map((z) => (
              <option key={z} value={z}>{z || "Senza zona"}</option>
            ))}
          </Select>
        </label>
        <button className="min-h-11 rounded-xl bg-night px-4 font-bold text-warm">Filtra</button>
        <span className="text-sm text-muted">{cards.length} QR</span>
      </form>

      {cards.length === 0 ? (
        <Card>
          <EmptyState
            title="Nessun punto di servizio"
            text="Crea tavoli, ombrelloni o camere: ognuno avrà il suo QR."
            action={<LinkButton href="/servizio/sala/tavoli" variant="secondary">Tavoli e zone</LinkButton>}
          />
        </Card>
      ) : (
        <div className="qr-sheet grid grid-cols-2 gap-3 sm:grid-cols-3">
          {cards.map((c) => (
            <div
              key={c.id}
              className="qr-card flex flex-col items-center justify-between rounded-xl border border-sand-deep bg-white p-3 text-center text-black"
              style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
            >
              <p style={{ margin: 0, fontSize: "9pt", fontWeight: 700, color: accent }}>{facilityName}</p>
              <div style={{ width: "34mm", height: "34mm", margin: "2mm 0" }} dangerouslySetInnerHTML={{ __html: c.svg }} />
              <p style={{ margin: 0, fontSize: "14pt", fontWeight: 800 }}>{c.title}</p>
              {c.sub && <p style={{ margin: 0, fontSize: "8pt", color: "#555" }}>{c.sub}</p>}
              <p style={{ margin: "1mm 0 0", fontSize: "7pt", color: "#555" }}>Inquadra per menu, ordini e assistenza · Scan for menu &amp; service</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
