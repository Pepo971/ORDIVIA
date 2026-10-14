import { NextResponse } from "next/server";
import { humanError } from "@/lib/action-state";
import { can, getContext } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { UUID_RE } from "@/lib/reservations-queries";

export const dynamic = "force-dynamic";

/** GDPR: esportazione dei dati di un cliente in JSON (crm.manage, verificato anche nel database). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Cliente non valido" }, { status: 400 });
  const ctx = await getContext();
  if (!can(ctx, "crm.manage")) return NextResponse.json({ error: "Non hai i permessi per questa operazione." }, { status: 403 });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("crm_export_customer", { p_customer: id });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 400;
    return NextResponse.json({ error: humanError(error) }, { status });
  }
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="cliente-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
