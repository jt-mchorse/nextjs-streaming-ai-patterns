import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Next.js streaming AI patterns",
  description:
    "Reference patterns for streaming AI features in Next.js 15 + React 19: streaming text, tool-use UI, partial JSON, optimistic updates, error recovery.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--border)] bg-[var(--panel)]">
          <div className="mx-auto max-w-6xl px-4 py-4">
            <Link href="/" className="text-sm font-medium tracking-tight text-[var(--foreground)]">
              nextjs-streaming-ai-patterns
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="mt-16 border-t border-[var(--border)] py-6 text-center text-xs text-[var(--muted)]">
          MIT · <a className="underline" href="https://github.com/jt-mchorse/nextjs-streaming-ai-patterns">jt-mchorse/nextjs-streaming-ai-patterns</a>
        </footer>
      </body>
    </html>
  );
}
