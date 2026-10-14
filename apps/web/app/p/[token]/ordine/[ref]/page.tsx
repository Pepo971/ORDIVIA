import Link from "next/link";
import { accentOf, formatPortalPrice, parseLang, pointKindLabel, portalText } from "@ordivia/domain";
import { getPublicOrderStatus, getPublicPoint } from "@/lib/portal-queries";
import { ClearCart } from "../../../_components/clear-cart";
import { LangSwitch, PortalNotFound } from "../../../_components/portal-view";
import { AutoRefresh } from "../../../_components/auto-refresh";

export const dynamic = "force-dynamic";
export const metadata = { title: { absolute: "Ordine · Order" } };

/** Conferma dell'ordine per l'ospite, con lo stato (da confermare / confermato / rifiutato). */
export default async function OrderConfirmationPage({ params, searchParams }: { params: Promise<{ token: string; ref: string }>; searchParams: Promise<{ lang?: string }> }) {
  const [{ token, ref }, sp] = await Promise.all([params, searchParams]);
  const lang = parseLang(sp.lang);
  const t = portalText(lang);
  const [portal, order] = await Promise.all([getPublicPoint(token), getPublicOrderStatus(token, ref)]);
  if (!portal || !order) return <PortalNotFound lang={lang} />;
  const accent = accentOf(portal.settings.accent);
  const point = portal.point ? `${pointKindLabel(lang, portal.point.kind)} ${portal.point.label}` : "";
  const headline = order.status === "accettato" ? t.orderAccepted : order.status === "rifiutato" ? t.orderRejected : t.orderWaiting;

  return (
    <div style={{ ["--accent" as string]: accent.hex }} className="min-h-dvh">
      <ClearCart token={token} />
      {order.status === "da_confermare" && <AutoRefresh seconds={15} />}
      <header className="text-white" style={{ background: accent.hex }}>
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-4">
          <span className="text-sm font-bold">{portal.facility.name}{point ? ` · ${point}` : ""}</span>
          <LangSwitch lang={lang} basePath={`/p/${token}/ordine/${ref}`} />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-6 pb-16">
        <div className="rounded-3xl bg-white p-5 text-center">
          <div
            className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full text-2xl font-bold text-white"
            style={{ background: order.status === "rifiutato" ? "var(--color-danger)" : accent.hex }}
            aria-hidden
          >
            {order.status === "rifiutato" ? "!" : "✓"}
          </div>
          <h1 className="font-display text-2xl font-semibold text-night">{t.orderSent}</h1>
          <p className="mt-1 text-ink" role="status">{headline}</p>
        </div>

        <ul className="mt-4 divide-y divide-sand rounded-2xl bg-white">
          {order.lines.map((l, k) => (
            <li key={k} className={`flex items-center justify-between px-4 py-3 ${l.status === "annullata" ? "text-muted line-through" : "text-night"}`}>
              <span><strong>{l.qty}×</strong> {l.name}</span>
            </li>
          ))}
          <li className="flex items-center justify-between px-4 py-3 font-bold text-night">
            <span>{t.total}</span>
            <span>{formatPortalPrice(lang, order.total)}</span>
          </li>
        </ul>
        <p className="mt-3 text-center text-sm text-muted">{t.payAtTable}</p>

        <Link
          href={`/p/${token}?lang=${lang}`}
          className="mt-6 flex min-h-14 w-full items-center justify-center rounded-2xl text-lg font-bold text-white"
          style={{ background: "var(--accent)" }}
        >
          {t.orderMore}
        </Link>
      </main>
    </div>
  );
}
