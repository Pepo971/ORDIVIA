"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action-state";
import { buttonClass, cx } from "./ui";

type Action = (prev: ActionState, data: FormData) => Promise<ActionState>;

/**
 * Form collegato a una Server Action: mostra errori e conferme senza ricaricare la pagina.
 * Funziona anche senza JavaScript (progressive enhancement).
 */
export function ActionForm({
  action,
  children,
  className = "",
  resetOnSuccess = false,
  id,
}: {
  action: Action;
  children: ReactNode | ((s: ActionState) => ReactNode);
  className?: string;
  resetOnSuccess?: boolean;
  id?: string;
}) {
  const [state, formAction] = useActionState(action, {} as ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form ref={ref} action={formAction} className={className} id={id} noValidate={false}>
      {typeof children === "function" ? children(state) : children}
      {state.error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-sm font-bold text-danger">
          {state.error}
        </p>
      )}
      {state.ok && state.message && (
        <p role="status" className="mt-3 rounded-xl bg-ok-soft px-3 py-2 text-sm font-bold text-ok">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function SubmitButton({
  children,
  pendingText = "Salvataggio…",
  variant = "primary",
  full = false,
  name,
  value,
  className = "",
  confirm,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  full?: boolean;
  name?: string;
  value?: string;
  className?: string;
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-busy={pending}
      className={cx(buttonClass(variant, full), className)}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? pendingText : children}
    </button>
  );
}
