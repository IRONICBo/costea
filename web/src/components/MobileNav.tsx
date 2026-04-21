"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface NavLink { href: string; label: string }

export function MobileNav({ links }: { links: NavLink[] }) {
  const [open, setOpen] = useState(false);

  // Close the sheet on route changes / escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        className="md:hidden btn-ghost px-2"
        onClick={() => setOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden>
          <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="md:hidden fixed inset-0 z-[60]">
          <div
            className="absolute inset-0 bg-foreground/20 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute top-0 right-0 bottom-0 w-[82%] max-w-sm bg-surface border-l border-border-soft p-5 flex flex-col gap-1 shadow-[var(--shadow-lg)]">
            <div className="flex items-center justify-between mb-4">
              <span className="eyebrow">Navigate</span>
              <button
                type="button"
                aria-label="Close menu"
                className="btn-ghost px-2"
                onClick={() => setOpen(false)}
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden>
                  <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="px-3 py-3 rounded-[var(--radius-md)] hover:bg-surface-elevated text-base font-medium"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <div className="mt-auto pt-4 border-t border-border-soft flex flex-col gap-2">
              <Link
                href="/estimate"
                className="btn-primary justify-center"
                onClick={() => setOpen(false)}
              >
                Try estimate →
              </Link>
              <a
                href="https://github.com/memovai/costea"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary justify-center"
              >
                GitHub
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
