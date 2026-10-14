import type { Metadata, Viewport } from "next";

// Pagine pubbliche del portale QR: fuori dall'area autenticata, nessun dato di sessione.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const viewport: Viewport = {
  themeColor: "#faf6ef",
};

export default function PublicPortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="bg-warm">{children}</div>;
}
