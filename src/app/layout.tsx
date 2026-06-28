import type { Metadata, Viewport } from "next";
import { Nunito } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";

const nunito = Nunito({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-nunito",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bahandi esep",
  description: "Loss-intelligence platform",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Esep",
    statusBarStyle: "default",
  },
  icons: {
    // Favicon is provided by the file-based src/app/icon.png (Next emits the
    // <link rel="icon"> automatically). apple-touch-icon is wired here so the
    // iOS home-screen mark is the on-brand green+E, matching the manifest.
    apple: [
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#16A34A",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" data-theme="light" className={nunito.variable}>
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
