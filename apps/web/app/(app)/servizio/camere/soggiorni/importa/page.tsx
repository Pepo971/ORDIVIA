import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requirePerm } from "@/lib/context";
import { getRooms } from "@/lib/rooms-queries";
import { RoomsTabs } from "../../rooms-ui";
import { CsvImport } from "./csv-import";

export const metadata = { title: "Importa soggiorni" };
export const dynamic = "force-dynamic";

export default async function ImportaPage() {
  const ctx = await requirePerm("rooms.manage");
  const rooms = await getRooms(ctx.facility.id);
  return (
    <div>
      <PageHeader
        title="Importa arrivi e partenze"
        subtitle="Incolla l'elenco esportato dal PMS o da Excel. Le righe già importate (stessa camera, ospite e arrivo) vengono saltate."
      />
      <RoomsTabs ctx={ctx} active="soggiorni" />
      {rooms.length === 0 ? (
        <Card>
          <EmptyState title="Nessuna camera" text="Crea prima le camere: l'importazione le riconosce dall'etichetta." action={<LinkButton href="/servizio/camere/configura">Crea le camere</LinkButton>} />
        </Card>
      ) : (
        <CsvImport rooms={rooms.map((r) => r.label)} />
      )}
    </div>
  );
}
