"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ICONS: Record<string, React.ReactNode> = {
  oggi: <path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />,
  lavoro: <path d="M9 11.5 11 13.5 15.5 9M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />,
  acquisti: <path d="M3 4h2l2.4 11h10.2L20 8H6.2M10 20a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm8 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />,
  scorte: <path d="M4 8 12 4l8 4v8l-8 4-8-4V8Zm0 0 8 4m0 0 8-4m-8 4v8" />,
  gestione: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />,
};

export function NavLinks({ items, variant }: { items: { key: string; label: string; href: string }[]; variant: "side" | "bottom" }) {
  const path = usePathname();
  const active = (href: string) => path === href || path.startsWith(`${href}/`);

  if (variant === "bottom") {
    return (
      <ul className="mx-auto flex max-w-lg justify-around px-2 pt-1.5">
        {items.map((i) => (
          <li key={i.key}>
            <Link
              href={i.href}
              aria-current={active(i.href) ? "page" : undefined}
              className={cx("flex min-h-12 min-w-16 flex-col items-center justify-center gap-0.5 rounded-xl text-[0.72rem] font-bold", active(i.href) ? "text-teal-deep" : "text-muted")}
            >
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {ICONS[i.key]}
              </svg>
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="space-y-1 px-3">
      {items.map((i) => (
        <li key={i.key}>
          <Link
            href={i.href}
            aria-current={active(i.href) ? "page" : undefined}
            className={cx(
              "flex min-h-11 items-center gap-3 rounded-xl px-3 text-[0.95rem] font-bold",
              active(i.href) ? "bg-white/10 text-warm" : "text-warm/65 hover:bg-white/5 hover:text-warm",
            )}
          >
            <svg viewBox="0 0 24 24" className={cx("h-5 w-5", active(i.href) && "text-teal")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {ICONS[i.key]}
            </svg>
            {i.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
