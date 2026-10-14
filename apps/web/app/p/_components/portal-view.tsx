import Link from "next/link";
import {
  accentOf,
  allergenLabel,
  formatPortalPrice,
  pickLang,
  pointKindLabel,
  portalText,
  telLink,
  whatsappLink,
  type PortalLang,
} from "@ordivia/domain";
import { LogoMark } from "@/components/logo";
import type { PublicPortal } from "@/lib/portal-queries";
import { OrderMenu } from "./order-menu";
import { RequestForm } from "./request-form";

/** Pagina pubblica del portale (punto di servizio o struttura). Server Component: solo il carrello è client. */
export function PortalView({ portal, token, lang, basePath, kind }: { portal: PublicPortal; token: string; lang: PortalLang; basePath: string; kind: "point" | "facility" }) {
  const t = portalText(lang);
  const s = portal.settings;
  const accent = accentOf(s.accent);
  const tel = telLink(s.phone);
  const pointLabel = portal.point ? `${pointKindLabel(lang, portal.point.kind)} ${portal.point.label}` : null;
  const wa = whatsappLink(s.whatsapp, pointLabel ? `${pointLabel} — ` : undefined);
  const waBook = whatsappLink(s.whatsapp, lang === "en" ? "Hello, I would like to book" : "Buongiorno, vorrei prenotare");
  const welcome = pickLang(lang, s.welcome_it, s.welcome_en);
  const hours = pickLang(lang, s.hours_it, s.hours_en);
  const canOrder = kind === "point" && portal.ordering.allowed;
  const showMenu = s.show_menu && portal.menu.length > 0;
  const showOrderInfo = kind === "point" && s.show_order && s.show_menu;
  const hasContacts = Boolean(tel || wa || s.email || s.address || s.map_url);

  const nav = [
    showMenu && { id: "menu", label: canOrder ? t.order : t.menu },
    s.show_offers && portal.offers.length > 0 && { id: "offerte", label: t.offers },
    s.show_assistance && { id: "assistenza", label: t.assistance },
    s.show_booking && (waBook || tel || s.email) && { id: "prenota", label: t.book },
    s.show_info && portal.info.length > 0 && { id: "info", label: t.info },
    hasContacts && { id: "contatti", label: t.contacts },
  ].filter(Boolean) as { id: string; label: string }[];

  return (
    <div style={{ ["--accent" as string]: accent.hex, ["--accent-soft" as string]: accent.soft }} className="min-h-dvh pb-28">
      {/* Testata */}
      <header className="relative overflow-hidden text-white" style={{ background: accent.hex }}>
        {s.cover_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.cover_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" referrerPolicy="no-referrer" loading="eager" />
        )}
        <div className="relative mx-auto max-w-xl px-4 pt-4 pb-6">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold tracking-wide uppercase opacity-90">{pointLabel ? `${t.youAreAt} ${pointLabel}` : " "}</span>
            <LangSwitch lang={lang} basePath={basePath} />
          </div>
          <h1 className="mt-6 font-display text-3xl leading-tight font-semibold drop-shadow-sm">{portal.facility.name}</h1>
          {welcome && <p className="mt-2 max-w-prose text-[0.98rem] leading-snug opacity-95">{welcome}</p>}
        </div>
      </header>

      {nav.length > 1 && (
        <nav className="sticky top-0 z-20 border-b border-sand-deep/70 bg-warm/95 backdrop-blur" aria-label={t.menu}>
          <div className="mx-auto flex max-w-xl gap-1 overflow-x-auto px-3 py-2">
            {nav.map((n) => (
              <a key={n.id} href={`#${n.id}`} className="flex min-h-10 items-center rounded-full px-3.5 text-sm font-bold whitespace-nowrap text-night hover:bg-sand">
                {n.label}
              </a>
            ))}
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-xl px-4 pt-5">
        {!portal.enabled && (
          <p className="mb-5 rounded-2xl bg-sand px-4 py-3 text-sm font-bold text-ink">{t.closedPortal}</p>
        )}

        {/* Menu / ordine */}
        {showMenu && (
          <section id="menu" className="scroll-mt-16">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="font-display text-2xl font-semibold text-night">{canOrder ? t.order : t.menu}</h2>
            </div>
            {showOrderInfo && !canOrder && portal.enabled && (
              <p className="mb-4 rounded-2xl px-4 py-3 text-sm font-bold" style={{ background: accent.soft, color: accent.hex }}>
                {portal.ordering.reason === "fuori_orario" && portal.ordering.from && portal.ordering.to
                  ? `${t.orderClosed} ${t.orderHours(portal.ordering.from, portal.ordering.to)}`
                  : t.orderNotHere}
              </p>
            )}
            {canOrder && portal.ordering.from && portal.ordering.to && (
              <p className="mb-3 text-xs text-muted">{t.orderHours(portal.ordering.from, portal.ordering.to)} {t.payAtTable}</p>
            )}
            {canOrder ? (
              <OrderMenu token={token} lang={lang} menu={portal.menu} />
            ) : (
              portal.menu.map((cat) => (
                <section key={cat.name} className="mb-6">
                  <h3 className="mb-2 font-display text-xl font-semibold text-night">{cat.name}</h3>
                  <ul className="divide-y divide-sand overflow-hidden rounded-2xl border border-sand-deep/70 bg-white">
                    {cat.items.map((i) => (
                      <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <p className={i.sold_out ? "font-bold text-muted line-through" : "font-bold text-night"}>{i.name}</p>
                          {i.description && <p className="text-sm text-muted">{i.description}</p>}
                          {i.allergens.length > 0 && (
                            <p className="mt-1 text-xs text-muted">{t.allergens}: {i.allergens.map((a) => allergenLabel(lang, a)).join(", ")}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <span className="font-bold text-night">{formatPortalPrice(lang, i.price)}</span>
                          {i.sold_out && <span className="rounded-full bg-sand px-2.5 py-1 text-xs font-bold text-muted">{t.soldOut}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </section>
        )}

        {/* Offerte */}
        {s.show_offers && portal.offers.length > 0 && (
          <section id="offerte" className="mt-4 scroll-mt-16">
            <h2 className="mb-3 font-display text-2xl font-semibold text-night">{t.offers}</h2>
            <div className="space-y-3">
              {portal.offers.map((o, k) => {
                const desc = pickLang(lang, o.description_it, o.description_en);
                return (
                  <article key={k} className="rounded-2xl border-l-4 bg-white p-4 shadow-[0_1px_0_rgba(14,34,53,0.06)]" style={{ borderColor: accent.hex }}>
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-bold text-night">{pickLang(lang, o.title_it, o.title_en)}</h3>
                      {o.price != null && <span className="shrink-0 font-bold" style={{ color: accent.hex }}>{formatPortalPrice(lang, o.price)}</span>}
                    </div>
                    {desc && <p className="mt-1 text-sm whitespace-pre-line text-ink">{desc}</p>}
                    {o.valid_to && <p className="mt-2 text-xs text-muted">{t.validUntil(formatDay(lang, o.valid_to))}</p>}
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {/* Assistenza */}
        {s.show_assistance && portal.enabled && (
          <section id="assistenza" className="mt-8 scroll-mt-16">
            <h2 className="mb-3 font-display text-2xl font-semibold text-night">{t.requestTitle}</h2>
            <div className="rounded-2xl bg-white p-4">
              <RequestForm token={token} lang={lang} isRoom={portal.point?.kind === "camera"} isFacility={kind === "facility"} />
            </div>
          </section>
        )}

        {/* Prenota */}
        {s.show_booking && (waBook || tel || s.email) && (
          <section id="prenota" className="mt-8 scroll-mt-16">
            <h2 className="mb-2 font-display text-2xl font-semibold text-night">{t.book}</h2>
            <p className="mb-3 text-sm text-muted">{t.bookText}</p>
            <div className="flex flex-wrap gap-2">
              {waBook && <CtaLink href={waBook} primary>{t.whatsapp}</CtaLink>}
              {tel && <CtaLink href={tel}>{t.call}</CtaLink>}
              {s.email && <CtaLink href={`mailto:${s.email}`}>{t.email}</CtaLink>}
            </div>
          </section>
        )}

        {/* Informazioni */}
        {s.show_info && portal.info.length > 0 && (
          <section id="info" className="mt-8 scroll-mt-16">
            <h2 className="mb-3 font-display text-2xl font-semibold text-night">{t.info}</h2>
            <div className="divide-y divide-sand overflow-hidden rounded-2xl bg-white">
              {portal.info.map((b, k) => (
                <details key={k} className="group px-4 py-3" open={portal.info.length <= 2}>
                  <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between font-bold text-night">
                    {pickLang(lang, b.title_it, b.title_en)}
                    <span className="text-muted transition-transform group-open:rotate-45" aria-hidden>+</span>
                  </summary>
                  <p className="mt-2 text-sm whitespace-pre-line text-ink">{pickLang(lang, b.body_it, b.body_en)}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        {/* Orari e contatti */}
        {(hours || hasContacts) && (
          <section id="contatti" className="mt-8 scroll-mt-16">
            <h2 className="mb-3 font-display text-2xl font-semibold text-night">{t.contacts}</h2>
            <div className="space-y-3 rounded-2xl bg-white p-4 text-sm">
              {hours && (
                <div>
                  <p className="font-bold text-night">{t.hours}</p>
                  <p className="whitespace-pre-line text-ink">{hours}</p>
                </div>
              )}
              {s.address && <p className="text-ink">{s.address}</p>}
              <div className="flex flex-wrap gap-2">
                {tel && <CtaLink href={tel}>{t.call}</CtaLink>}
                {wa && <CtaLink href={wa}>{t.whatsapp}</CtaLink>}
                {s.email && <CtaLink href={`mailto:${s.email}`}>{t.email}</CtaLink>}
                {s.map_url && <CtaLink href={s.map_url}>{t.map}</CtaLink>}
              </div>
            </div>
          </section>
        )}

        <footer className="mt-10 flex items-center justify-center gap-1.5 text-xs text-muted">
          <LogoMark size={14} /> {t.poweredBy}
        </footer>
      </main>
    </div>
  );
}

function CtaLink({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="inline-flex min-h-11 items-center rounded-full border-2 px-4 font-bold"
      style={primary ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" } : { borderColor: "var(--accent)", color: "var(--accent)" }}
    >
      {children}
    </a>
  );
}

export function LangSwitch({ lang, basePath }: { lang: PortalLang; basePath: string }) {
  return (
    <div className="flex rounded-full bg-white/20 p-0.5 text-xs font-bold" role="group" aria-label="Lingua / Language">
      {(["it", "en"] as const).map((l) => (
        <Link
          key={l}
          href={`${basePath}?lang=${l}`}
          aria-current={l === lang ? "true" : undefined}
          className={`flex min-h-8 items-center rounded-full px-3 uppercase ${l === lang ? "bg-white text-night" : "text-white"}`}
          hrefLang={l}
          replace
        >
          {l}
        </Link>
      ))}
    </div>
  );
}

function formatDay(lang: PortalLang, iso: string) {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "it-IT", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));
}

/** Pagina d'errore pubblica (QR non valido). */
export function PortalNotFound({ lang }: { lang: PortalLang }) {
  const t = portalText(lang);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <LogoMark size={44} className="text-night" />
      <p className="mt-4 font-display text-2xl font-semibold text-night">{t.invalidQr}</p>
      <p className="mt-2 text-sm text-muted">{lang === "en" ? "Please ask the staff for help." : "Chiedi aiuto al personale."}</p>
    </main>
  );
}
