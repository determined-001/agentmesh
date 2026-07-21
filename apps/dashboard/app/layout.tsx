import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentMesh — Agent Settlement on Arc",
  description:
    "Compliant agent-to-agent settlement layer on Arc: named agent wallets, x402 micropayments, screened escrow, automated watchers.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
