import { SectionTabs } from "@/components/section-tabs";
import { can, getContext } from "@/lib/context";

export default async function NumeriLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const tabs = [
    can(ctx, "analytics.view", "finance.view") && { href: "/numeri/andamento", label: "Andamento" },
    can(ctx, "analytics.view", "finance.view") && { href: "/numeri/assistente", label: "Assistente" },
    can(ctx, "analytics.view", "menu.manage") && { href: "/numeri/preparazioni", label: "Preparazioni" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <div>
      <SectionTabs items={tabs} />
      {children}
    </div>
  );
}
