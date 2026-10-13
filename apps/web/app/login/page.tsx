import { Logo } from "@/components/logo";
import { LoginForms } from "./login-forms";

export const metadata = { title: "Accedi" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; mode?: string; errore?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-night p-12 text-warm lg:flex lg:flex-col lg:justify-between">
        <Logo dark />
        <div className="max-w-md">
          <p className="font-display text-[2.6rem] leading-[1.1] font-semibold">
            Ogni reparto sa cosa fare.
            <br />
            <span className="text-teal">Ogni euro sa dov’è andato.</span>
          </p>
          <p className="mt-5 text-warm/70">Ordini prima del cut-off, consegne controllate, scorte e attività tracciate: tutta la struttura nello stesso sistema.</p>
        </div>
        <p className="text-sm tracking-[0.2em] text-warm/50 uppercase">Hospitality, in order.</p>
        <svg className="pointer-events-none absolute -right-32 -bottom-40 h-[34rem] w-[34rem] opacity-[0.08]" viewBox="0 0 48 48" aria-hidden>
          <circle cx="24" cy="24" r="21" fill="none" stroke="#faf6ef" strokeWidth="1.2" />
          <path d="M8.5 27.5c4.2-3.2 8.4-3.2 12.6 0s8.4 3.2 12.6 0 6.3-2.4 6.3-2.4" fill="none" stroke="#15a596" strokeWidth="1.2" />
        </svg>
      </section>
      <section className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          {sp.errore && <p className="mb-4 rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">Il link non è valido o è scaduto. Accedi di nuovo.</p>}
          <LoginForms next={sp.next ?? "/oggi"} initialMode={sp.mode === "registrati" ? "signup" : "signin"} />
        </div>
      </section>
    </main>
  );
}
