import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MatrixMint",
  description: "Compliance-Proven Proposal Pack",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}