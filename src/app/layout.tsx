import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // The tab is on screen for the whole demo recording, so it says what this is.
  title: { default: "Warden", template: "%s · Warden" },
  description:
    "An operations agent for inbound-lead response. It proposes; a policy engine it cannot influence decides.",
  applicationName: "Warden",
  robots: { index: false, follow: false },
};

/**
 * There is no light variant of this product, so the browser is told before
 * first paint. Without it, mobile Safari and Chrome paint their own chrome
 * white around a permanently dark page and the page arrives inside a flash.
 */
export const viewport: Viewport = {
  // The literal value of --color-canvas. A meta tag cannot read a CSS variable,
  // so this is the one place in the product a hex is written by hand; it is
  // here rather than in a component because there is exactly one of it.
  themeColor: "#0d0f13",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
