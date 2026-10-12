'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@groundgraph/ui';

export const APP_TABS = [
  { href: '/', label: 'Home' },
  { href: '/markets', label: 'Markets' },
  { href: '/radar', label: 'Radar' },
  { href: '/create', label: 'Create' },
  { href: '/positions', label: 'Positions' },
] as const;

export function isActivePath(path: string, href: string): boolean {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(`${href}/`);
}

/** Bottom navigation under 760px, inside the app only. */
export function MobileTabBar() {
  const path = usePathname();
  return (
    <nav data-component="MobileTabBar" aria-label="Primary" className="fixed inset-x-0 bottom-0 z-[60] grid grid-cols-5 border-t border-violet/[0.14] bg-[rgba(10,8,18,0.92)] px-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl min-[760px]:hidden">
      {APP_TABS.map((t) => {
        const on = isActivePath(path, t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={on ? 'page' : undefined} className={cn('flex h-[52px] flex-col items-center justify-center gap-[5px]', on ? 'text-above-text hover:text-above-text' : 'text-dim hover:text-ink')}>
            <span aria-hidden className={cn('h-1 rounded-sm transition-all duration-[250ms]', on ? 'w-[18px] bg-above' : 'w-1 bg-transparent')} />
            <span className="text-[11px] font-semibold leading-none">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
