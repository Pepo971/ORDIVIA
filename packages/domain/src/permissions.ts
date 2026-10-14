// Specchio lato client del catalogo permessi in database (public.permissions).
// Serve solo a decidere cosa MOSTRARE: l'autorizzazione vera è nelle policy RLS e nelle RPC.

export const PERMISSIONS = [
  "org.manage",
  "members.manage",
  "roles.manage",
  "finance.view",
  "audit.view",
  "tasks.manage",
  "tasks.perform",
  "suppliers.manage",
  "purchasing.request",
  "purchasing.approve",
  "purchasing.send",
  "receiving.perform",
  "inventory.view",
  "inventory.move",
  "inventory.count",
  "stations.manage",
  "menu.manage",
  "pos.operate",
  "pos.kitchen",
  "pos.supervise",
  "beach.operate",
  "beach.manage",
  "shifts.manage",
  "shifts.view",
  "haccp.record",
  "reservations.manage",
  "crm.view",
  "crm.manage",
  "portal.manage",
  "rooms.operate",
  "rooms.manage",
  "maintenance.report",
  "maintenance.manage",
  "analytics.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface NavItem {
  key: string;
  label: string;
  href: string;
  anyOf: Permission[];
}

/** Navigazione per ruolo, generata dai permessi: un operativo vede 3–4 voci, il titolare tutte. */
export const NAV: NavItem[] = [
  { key: "oggi", label: "Oggi", href: "/oggi", anyOf: ["tasks.perform", "tasks.manage", "purchasing.approve", "receiving.perform"] },
  { key: "servizio", label: "Servizio", href: "/servizio", anyOf: ["pos.operate", "pos.kitchen", "pos.supervise", "beach.operate", "beach.manage", "menu.manage", "haccp.record", "rooms.operate", "rooms.manage", "maintenance.report", "maintenance.manage"] },
  { key: "ospiti", label: "Ospiti", href: "/ospiti", anyOf: ["reservations.manage", "crm.view", "crm.manage", "portal.manage"] },
  { key: "lavoro", label: "Lavoro", href: "/lavoro", anyOf: ["tasks.perform", "tasks.manage", "shifts.view", "shifts.manage"] },
  { key: "acquisti", label: "Acquisti", href: "/acquisti", anyOf: ["purchasing.request", "purchasing.approve", "suppliers.manage", "receiving.perform"] },
  { key: "scorte", label: "Scorte", href: "/scorte", anyOf: ["inventory.view"] },
  { key: "numeri", label: "Numeri", href: "/numeri", anyOf: ["analytics.view", "finance.view"] },
  { key: "gestione", label: "Gestione", href: "/gestione", anyOf: ["org.manage", "members.manage", "audit.view"] },
];

export function hasAny(perms: ReadonlySet<string> | readonly string[], wanted: readonly string[]): boolean {
  const set = perms instanceof Set ? perms : new Set(perms);
  return wanted.some((p) => set.has(p));
}

export function navFor(perms: readonly string[]): NavItem[] {
  return NAV.filter((n) => hasAny(perms, n.anyOf));
}
