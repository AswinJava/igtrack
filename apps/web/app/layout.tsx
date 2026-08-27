import type { Metadata } from "next";
import "./globals.css";
import { Sidebar, MobileNav } from "@/components/layout/sidebar";

export const metadata: Metadata = {
  title: "IGTrack — Public Instagram Intelligence",
  description: "Evidence-driven public Instagram monitoring and relationship intelligence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <MobileNav />
            <main className="flex-1 bg-zinc-950">{children}</main>
            <footer className="border-t border-zinc-800 px-6 py-3 text-xs text-zinc-500">
              Synthetic demo data · Every claim links to evidence · Inferred intelligence is never presented as fact
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
