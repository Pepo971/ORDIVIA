import { addDays, todayIn } from "@ordivia/domain";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getRooms } from "@/lib/rooms-queries";
import { createClient } from "@/lib/supabase/server";
import { RoomsTabs } from "../../rooms-ui";
import { StayForm } from "../stay-form";

export const metadata = { title: "Nuovo soggiorno" };
export const dynamic = "force-dynamic";

export default async function NuovoSoggiornoPage({ searchParams }: { searchParams: Promise<{ camera?: string; data?: string }> }) {
  const ctx = await requirePerm("rooms.manage");
  const sp = await searchParams;
  const today = todayIn(ctx.facility.timezone);
  const arrival = sp.data && /^\d{4}-\d{2}-\d{2}$/.test(sp.data) ? sp.data : today;
  const supabase = await createClient();
  const [rooms, { data: customers }] = await Promise.all([
    getRooms(ctx.facility.id),
    supabase.from("customers").select("id, full_name").eq("org_id", ctx.org.id).is("anonymized_at", null).order("full_name").limit(500),
  ]);

  return (
    <div>
      <PageHeader title="Nuovo soggiorno" subtitle="Ordivia non sostituisce il PMS: qui registri arrivi e partenze per pulizie, minibar e richieste." />
      <RoomsTabs ctx={ctx} active="soggiorni" />
      <Card className="max-w-xl p-4">
        {rooms.length === 0 ? (
          <EmptyState title="Nessuna camera" text="Crea prima le camere." action={<LinkButton href="/servizio/camere/configura">Crea le camere</LinkButton>} />
        ) : (
          <StayForm
            rooms={rooms}
            customers={(customers ?? []) as { id: string; full_name: string }[]}
            defaultRoom={sp.camera}
            defaultArrival={arrival}
            defaultDeparture={addDays(arrival, 1)}
          />
        )}
      </Card>
    </div>
  );
}
