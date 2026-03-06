import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { GeistPixelSquare } from "geist/font/pixel";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Macroni - Desktop Automation",
  description: "Record your workflows once. Let Macroni's AI handle the rest.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${GeistPixelSquare.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
