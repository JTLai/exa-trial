"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Prices" },
  { href: "/eval", label: "Eval" },
  { href: "/browser-use", label: "Browser-Use" },
];

export function TabNav() {
  const pathname = usePathname();
  return (
    <nav className="mx-auto flex w-full max-w-[1400px] gap-1 border-b px-4 pt-4">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
