"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

/** Barra di sottosezioni basata sul percorso corrente. */
export function SectionTabs({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  if (items.length <= 1) return null;
  return (
    <nav className="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-sand p-1" aria-label="Sottosezioni">
      {items.map((t) => {
        const active = path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cx("flex min-h-11 items-center rounded-lg px-3.5 text-sm font-bold whitespace-nowrap", active ? "bg-white text-night shadow-sm" : "text-muted hover:text-night")}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
