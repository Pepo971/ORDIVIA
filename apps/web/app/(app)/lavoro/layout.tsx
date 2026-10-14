import { SectionTabs } from "@/components/section-tabs";
import { can, getContext } from "@/lib/context";

export default async function LavoroLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const tabs = [
    can(ctx, "tasks.perform", "tasks.manage") && { href: "/lavoro/attivita", label: "Attività" },
    can(ctx, "shifts.view", "shifts.manage") && { href: "/lavoro/turni", label: "Turni" },
    can(ctx, "shifts.view", "shifts.manage") && { href: "/lavoro/richieste", label: "Ferie e cambi" },
    can(ctx, "tasks.manage") && { href: "/lavoro/checklist", label: "Checklist" },
  ].filter(Boolean) as { href: string; label: string }[];
  return (
    <div>
      <SectionTabs items={tabs} />
      {children}
    </div>
  );
}
