import { TICKET_PRIORITY, TICKET_STATUS, type TicketPriority, type TicketStatus } from "@ordivia/domain";
import { Badge, Tabs } from "@/components/ui";
import { can, type AppContext } from "@/lib/context";

export function MaintenanceTabs({ ctx, active }: { ctx: AppContext; active: string }) {
  const manage = can(ctx, "maintenance.manage");
  const items = [
    { key: "interventi", label: manage ? "Interventi" : "Le mie segnalazioni", href: "/servizio/manutenzione" },
    { key: "nuova", label: "Segnala", href: "/servizio/manutenzione/nuova" },
    ...(manage ? [{ key: "cespiti", label: "Impianti e programmata", href: "/servizio/manutenzione/cespiti" }] : []),
  ];
  return <Tabs items={items} active={active} />;
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <Badge tone={TICKET_STATUS[status].tone}>{TICKET_STATUS[status].label}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  if (priority === "media" || priority === "bassa") return <Badge tone="neutral">{TICKET_PRIORITY[priority].label}</Badge>;
  return <Badge tone={TICKET_PRIORITY[priority].tone}>{TICKET_PRIORITY[priority].label}</Badge>;
}

export const SOURCE_LABEL: Record<string, string> = {
  segnalazione: "Segnalazione",
  housekeeping: "Dalle pulizie",
  richiesta_ospite: "Richiesta ospite",
  pianificata: "Programmata",
};

export interface TicketRow {
  id: string;
  number: number;
  service_point_id: string | null;
  location_text: string | null;
  asset_id: string | null;
  category: string;
  priority: TicketPriority;
  description: string;
  photo_path: string | null;
  status: TicketStatus;
  source: string;
  guest_request_id: string | null;
  planned_for: string | null;
  reported_by: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  started_at: string | null;
  waiting_parts_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  verified_at: string | null;
  verified_by: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export const TICKET_COLUMNS =
  "id, number, service_point_id, location_text, asset_id, category, priority, description, photo_path, status, source, guest_request_id, planned_for, reported_by, assigned_to, assigned_at, started_at, waiting_parts_at, resolved_at, resolved_by, resolution_note, verified_at, verified_by, cancelled_at, created_at";

export function pointLabel(p: { kind: string; label: string }) {
  const k = p.kind.charAt(0).toUpperCase() + p.kind.slice(1);
  return `${k} ${p.label}`;
}
