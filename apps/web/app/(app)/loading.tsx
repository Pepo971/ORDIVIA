export default function Loading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Caricamento">
      <div className="h-8 w-48 rounded-lg bg-sand" />
      <div className="h-4 w-72 rounded bg-sand" />
      <div className="h-40 rounded-[var(--radius-card)] bg-sand/70" />
    </div>
  );
}
