import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://metamcp.org"),
  title: "MetaMCP Docs",
  description:
    "Documentation for MetaMCP, the meta-MCP server that collapses N child servers into 4 tools.",
  keywords: [
    "MetaMCP",
    "MCP",
    "Model Context Protocol",
    "meta-MCP",
    "tool aggregation",
    "connection pool",
    "V8 sandbox",
  ],
  openGraph: {
    title: "MetaMCP Docs",
    description:
      "Documentation for MetaMCP, the meta-MCP server that collapses N child servers into 4 tools.",
    url: "https://metamcp.org",
    siteName: "MetaMCP Docs",
    type: "website",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const t = localStorage.getItem('docs-theme');
                if (t === 'dark') document.documentElement.classList.add('dark');
              } catch (e) {}
            `,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
