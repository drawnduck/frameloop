import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ChromeShell } from "@/components/ChromeShell";
import { Providers } from "./providers";

// Display: warm Garamond-cut serif. Carries every wordmark, page title, and
// date stamp. Supports Latin + Cyrillic, so "12 мая 2024" renders properly
// in Fraunces-grade refinement.
const cormorant = Cormorant_Garamond({
  subsets: ["latin", "cyrillic"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

// Body / UI: a clean humanist grotesque with Cyrillic. Sits comfortably next
// to the serif without competing — and is unmistakably not Inter.
const manrope = Manrope({
  subsets: ["latin", "cyrillic"],
  variable: "--font-sans",
  display: "swap",
});

// Mono: tick-mark numerals, addresses, hashes. A quiet hint at the on-chain
// substrate without ever shouting "crypto".
const jetbrains = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Frameloop",
  description: "A private photo album for your on-chain memories.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cormorant.variable} ${manrope.variable} ${jetbrains.variable}`}
    >
      <body className="antialiased">
        <Providers>
          {/* ChromeShell renders the paper-design chrome bar once, in    */}
          {/* the root tree, so it never unmounts between routes. Pages   */}
          {/* drop their per-page action via <ChromeRightSlot> portal.    */}
          {/* Old dark-design routes (/me, /u/[address], /pool/[tag])     */}
          {/* are detected by ChromeShell and render their own header.    */}
          <ChromeShell>{children}</ChromeShell>
        </Providers>
      </body>
    </html>
  );
}
