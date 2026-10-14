import { todayIn } from "@ordivia/domain";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { can, requirePerm } from "@/lib/context";
import { beachDate, getBeachPoints, getOutOfService, getRates } from "@/lib/beach-queries";
import { BookingForm } from "./booking-form";

export const metadata = { title: "Nuova prenotazione spiaggia" };
export const dynamic = "force-dynamic";

export default async function NuovaPrenotazionePage({ searchParams }: { searchParams: Promise<{ p?: string; data?: string }> }) {
  const ctx = await requirePerm("beach.operate", "beach.manage");
  const sp = await searchParams;
  const [points, rates, oos] = await Promise.all([getBeachPoints(ctx.facility.id), getRates(ctx.facility.id), getOutOfService(ctx.facility.id)]);
  const available = points.filter((p) => !oos.has(p.id));
  const today = todayIn(ctx.facility.timezone);
  const manage = can(ctx, "beach.manage");
  const date = beachDate(ctx, sp.data);

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Nuova prenotazione"
        subtitle={manage ? "Giornate, mezze giornate, settimane, mesi e abbonamenti stagionali." : "Giornate e mezze giornate. Abbonamenti e prezzi speciali li registra il responsabile."}
        action={<LinkButton href="/servizio/spiaggia/prenotazioni" variant="secondary">Prenotazioni</LinkButton>}
      />
      <Card className="p-4">
        {available.length === 0 ? (
          <EmptyState
            title="Nessuna postazione disponibile"
            text={manage ? "Crea prima la mappa della spiaggia." : "Chiedi al responsabile della spiaggia di creare la mappa."}
            action={manage ? <LinkButton href="/servizio/spiaggia/mappa">Crea la mappa</LinkButton> : undefined}
          />
        ) : (
          <BookingForm
            points={available.map(({ id, kind, label, zone, row_label, seats }) => ({ id, kind, label, zone, row_label, seats }))}
            rates={rates}
            initialPoint={sp.p && available.some((p) => p.id === sp.p) ? sp.p : null}
            initialDate={!manage && date < today ? today : date}
            today={today}
            manage={manage}
          />
        )}
      </Card>
    </div>
  );
}
