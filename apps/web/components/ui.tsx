import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[1.75rem] leading-tight font-semibold text-night">{title}</h1>
        {subtitle && <p className="mt-1 text-[0.95rem] text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function Card({ children, className = "", ...rest }: ComponentProps<"section">) {
  return (
    <section className={cx("rounded-[var(--radius-card)] border border-sand-deep/70 bg-white shadow-[0_1px_0_rgba(14,34,53,0.04)]", className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({ title, action, hint }: { title: string; action?: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-sand px-4 py-3">
      <div>
        <h2 className="text-[0.95rem] font-bold text-night">{title}</h2>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

type Tone = "neutral" | "teal" | "warn" | "danger" | "ok" | "night";
const toneClass: Record<Tone, string> = {
  neutral: "bg-sand text-ink",
  teal: "bg-teal-soft text-teal-deep",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  ok: "bg-ok-soft text-ok",
  night: "bg-night text-warm",
};

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={cx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap", toneClass[tone])}>{children}</span>;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variantClass: Record<Variant, string> = {
  primary: "bg-night text-warm hover:bg-night-2 disabled:bg-night-3",
  secondary: "bg-white text-night border border-sand-deep hover:border-night-3",
  ghost: "bg-transparent text-night hover:bg-sand",
  danger: "bg-white text-danger border border-danger/40 hover:bg-danger-soft",
};

export function buttonClass(variant: Variant = "primary", full = false) {
  return cx(
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[0.95rem] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-70",
    variantClass[variant],
    full && "w-full",
  );
}

export function Button({ variant = "primary", full, className = "", ...rest }: ComponentProps<"button"> & { variant?: Variant; full?: boolean }) {
  return <button className={cx(buttonClass(variant, full), className)} {...rest} />;
}

export function LinkButton({ variant = "primary", full, className = "", ...rest }: ComponentProps<typeof Link> & { variant?: Variant; full?: boolean }) {
  return <Link className={cx(buttonClass(variant, full), className)} {...rest} />;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-bold text-night">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs font-bold text-danger">{error}</span>}
    </label>
  );
}

const inputBase =
  "w-full rounded-xl border border-sand-deep bg-white px-3 py-2.5 text-ink placeholder:text-muted/70 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/25";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cx(inputBase, props.className)} />;
}
export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={cx(inputBase, "pr-8", props.className)} />;
}
export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea rows={3} {...props} className={cx(inputBase, props.className)} />;
}

export function EmptyState({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <div className="mb-3 h-10 w-10 rounded-full border-[3px] border-sand-deep" aria-hidden />
      <p className="font-bold text-night">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "teal", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx("rounded-xl px-4 py-3 text-sm font-semibold", toneClass[tone])}>{children}</div>;
}

export function Row({ children, href, className = "" }: { children: ReactNode; href?: string; className?: string }) {
  const cls = cx("flex items-center gap-3 px-4 py-3 border-b border-sand last:border-b-0", href && "hover:bg-warm", className);
  return href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <div className={cls}>{children}</div>
  );
}

export function Tabs({ items, active }: { items: { href: string; label: string; key: string; count?: number }[]; active: string }) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto rounded-xl bg-sand p-1" aria-label="Sezioni">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={cx(
            "flex min-h-11 items-center gap-1.5 rounded-lg px-3.5 text-sm font-bold whitespace-nowrap",
            t.key === active ? "bg-white text-night shadow-sm" : "text-muted hover:text-night",
          )}
        >
          {t.label}
          {t.count != null && t.count > 0 && <span className="rounded-full bg-night px-1.5 text-[0.7rem] text-warm">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}
