import { Tabs } from "@/components/ui";

/** Sottosezioni del Portale QR. */
export function PortalNav({ active, pending = 0, canManage = true }: { active: "config" | "qr" | "ordini"; pending?: number; canManage?: boolean }) {
  const items = [
    canManage && { key: "config", href: "/ospiti/portale", label: "Configurazione" },
    canManage && { key: "qr", href: "/ospiti/portale/qr", label: "Codici QR" },
    { key: "ordini", href: "/ospiti/portale/ordini", label: "Ordini dal QR", count: pending },
  ].filter(Boolean) as { key: string; href: string; label: string; count?: number }[];
  return <Tabs items={items} active={active} />;
}
