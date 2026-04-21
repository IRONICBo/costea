import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
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
  title: "Costea — Cost infrastructure for AI agents",
  description:
    "Predict, price, and explain every AI-agent task before you run it. Token estimates across Claude, Codex, Gemini — powered by an ensemble of GBDT + MLP + Linear models.",
  openGraph: {
    title: "Costea — Cost infrastructure for AI agents",
    description:
      "The Stripe for LLM-era compute. Estimate tokens before you spend them.",
    type: "website",
  },
};

const NAV_LINKS: Array<{ href: string; label: string }> = [
  { href: "/estimate", label: "Estimate" },
  { href: "/dashboard", label: "Sessions" },
  { href: "/analytics", label: "Analytics" },
  { href: "/accuracy", label: "Accuracy" },
  { href: "/settings/training", label: "Training" },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 group" aria-label="Costea home">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/mascot.png"
        alt=""
        width={28}
        height={28}
        className="rounded transition-transform duration-300 group-hover:rotate-[-6deg]"
      />
      <span className="font-semibold tracking-tight text-[15px]">
        Costea
      </span>
      <span className="hidden sm:inline-block pill pill-brand text-[9px]">
        <span className="w-1 h-1 rounded-full bg-brand-c" />
        live
      </span>
    </Link>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border-soft bg-background/80 backdrop-blur-md">
      <nav className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <Logo />
        <div className="hidden md:flex items-center gap-1 text-sm">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="btn-ghost">
              {l.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/memovai/costea"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost hidden sm:inline-flex text-sm"
          >
            GitHub
          </a>
          <Link href="/estimate" className="btn-primary text-[13px] hidden sm:inline-flex">
            Try estimate <span aria-hidden>→</span>
          </Link>
          <MobileNav links={NAV_LINKS} />
        </div>
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-24 border-t border-border-soft">
      <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
        <div className="col-span-2">
          <div className="flex items-center gap-2 mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/mascot.png" alt="" width={32} height={32} className="opacity-90" />
            <span className="font-semibold">Costea</span>
          </div>
          <p className="text-muted max-w-sm leading-relaxed">
            Cost infrastructure for AI agents. Estimate before you spend,
            review after you do. Across every major LLM provider.
          </p>
        </div>
        <div>
          <p className="eyebrow mb-3">Product</p>
          <ul className="space-y-2 text-foreground-soft">
            <li><Link href="/estimate" className="hover:text-foreground">Estimate</Link></li>
            <li><Link href="/analytics" className="hover:text-foreground">Analytics</Link></li>
            <li><Link href="/accuracy" className="hover:text-foreground">Accuracy</Link></li>
            <li><Link href="/settings/training" className="hover:text-foreground">Training</Link></li>
          </ul>
        </div>
        <div>
          <p className="eyebrow mb-3">Resources</p>
          <ul className="space-y-2 text-foreground-soft">
            <li><a href="https://github.com/memovai/costea" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">GitHub</a></li>
            <li><a href="https://github.com/memovai/costea#readme" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">Docs</a></li>
            <li><a href="https://github.com/memovai/costea/issues" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">Issues</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border-soft">
        <div className="max-w-7xl mx-auto px-6 py-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-2 text-xs text-muted">
          <span>© {new Date().getFullYear()} Costea — cost-conscious AI, by default.</span>
          <div className="flex items-center gap-3">
            <span className="pill">Claude Code</span>
            <span className="pill">Codex CLI</span>
            <span className="pill">OpenClaw</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Nav />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
