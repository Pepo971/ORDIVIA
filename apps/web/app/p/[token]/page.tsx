import type { Metadata } from "next";
import { parseLang, pointKindLabel } from "@ordivia/domain";
import { getPublicPoint } from "@/lib/portal-queries";
import { PortalNotFound, PortalView } from "../_components/portal-view";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const portal = await getPublicPoint(token);
  if (!portal) return { title: "Ordivia" };
  const lang = parseLang(sp.lang);
  const point = portal.point ? `${pointKindLabel(lang, portal.point.kind)} ${portal.point.label} · ` : "";
  return { title: { absolute: `${point}${portal.facility.name}` } };
}

/** Portale del punto di servizio (QR su tavolo, ombrellone, camera…). */
export default async function PointPortalPage({ params, searchParams }: Props) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const lang = parseLang(sp.lang);
  const portal = await getPublicPoint(token);
  if (!portal) return <PortalNotFound lang={lang} />;
  return <PortalView portal={portal} token={token} lang={lang} basePath={`/p/${token}`} kind="point" />;
}
