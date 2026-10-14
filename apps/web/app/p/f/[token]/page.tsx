import type { Metadata } from "next";
import { parseLang } from "@ordivia/domain";
import { getPublicFacility } from "@/lib/portal-queries";
import { PortalNotFound, PortalView } from "../../_components/portal-view";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const portal = await getPublicFacility(token);
  return { title: { absolute: portal?.facility.name ?? "Ordivia" } };
}

/** Portale generico della struttura (QR all'ingresso, in reception, sui volantini): niente ordini. */
export default async function FacilityPortalPage({ params, searchParams }: Props) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const lang = parseLang(sp.lang);
  const portal = await getPublicFacility(token);
  if (!portal) return <PortalNotFound lang={lang} />;
  return <PortalView portal={portal} token={token} lang={lang} basePath={`/p/f/${token}`} kind="facility" />;
}
