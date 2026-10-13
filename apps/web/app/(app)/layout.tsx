import { navFor, PERMISSIONS } from "@ordivia/domain";
import { Logo } from "@/components/logo";
import { NavLinks } from "@/components/nav-links";
import { getContext } from "@/lib/context";
import { signOut } from "../login/actions";
import { switchFacility } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  const perms = ctx.perms.has("*") ? [...PERMISSIONS] : [...ctx.perms];
  const nav = navFor(perms).map(({ key, label, href }) => ({ key, label, href }));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <aside className="hidden border-r border-sand-deep/70 bg-night text-warm lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="px-5 pt-6 pb-5">
          <Logo dark />
        </div>
        <FacilitySwitcher ctx={ctx} dark />
        <NavLinks items={nav} variant="side" />
        <div className="mt-auto border-t border-white/10 px-5 py-4 text-sm">
          <p className="font-bold">{ctx.fullName}</p>
          <p className="text-warm/60">{ctx.role.name}</p>
          <form action={signOut}>
            <button className="mt-2 min-h-0 text-warm/70 underline-offset-4 hover:text-warm hover:underline">Esci</button>
          </form>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-sand-deep/70 bg-warm/95 px-4 py-2.5 backdrop-blur lg:hidden">
          <Logo />
          <FacilitySwitcher ctx={ctx} />
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 sm:px-6 lg:px-10 lg:pt-9 lg:pb-12">{children}</main>
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-sand-deep bg-white/95 backdrop-blur lg:hidden" aria-label="Navigazione principale">
          <NavLinks items={nav} variant="bottom" />
        </nav>
      </div>
    </div>
  );
}

function FacilitySwitcher({ ctx, dark = false }: { ctx: Awaited<ReturnType<typeof getContext>>; dark?: boolean }) {
  if (ctx.facilities.length <= 1) {
    return (
      <div className={dark ? "px-5 pb-4" : "text-right"}>
        <p className={`text-xs font-bold tracking-wide uppercase ${dark ? "text-warm/50" : "text-muted"}`}>{ctx.org.name}</p>
        <p className={`text-sm font-bold ${dark ? "text-warm" : "text-night"}`}>{ctx.facility.name}</p>
      </div>
    );
  }
  return (
    <form action={switchFacility} className={dark ? "px-5 pb-4" : ""}>
      <label className="sr-only" htmlFor={`fac-${dark}`}>
        Struttura
      </label>
      <select
        id={`fac-${dark}`}
        name="facility_id"
        defaultValue={ctx.facility.id}
        className={`w-full rounded-xl border px-3 py-2 text-sm font-bold ${dark ? "border-white/15 bg-night-2 text-warm" : "border-sand-deep bg-white text-night"}`}
      >
        {ctx.facilities.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <button className="mt-1 min-h-0 text-xs font-bold underline">Cambia struttura</button>
    </form>
  );
}
