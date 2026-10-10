import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Aangan Studio — Voice Enquiries", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
