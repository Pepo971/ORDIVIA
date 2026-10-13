/** Marchio Ordivia: un cerchio (ordine, completezza) attraversato dall'orizzonte mediterraneo, con un punto di riferimento. */
export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <circle cx="24" cy="24" r="21" fill="none" stroke="currentColor" strokeWidth="3.2" />
      <path d="M8.5 27.5c4.2-3.2 8.4-3.2 12.6 0s8.4 3.2 12.6 0 6.3-2.4 6.3-2.4" fill="none" stroke="#15a596" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="24" cy="15.5" r="3.4" fill="#15a596" />
    </svg>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${dark ? "text-warm" : "text-night"}`}>
      <LogoMark size={30} />
      <span className="font-display text-[1.35rem] font-semibold tracking-tight">Ordivia</span>
    </span>
  );
}
