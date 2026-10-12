'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from './queries';
import { fetchUsdcBalance } from './solana';

/** Re-render every `ms` and return the current time. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** True for 900ms after `value` changes (not on first render). Used for price and score flashes. */
export function useFlash(value: unknown, ms = 900): boolean {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (Object.is(prev.current, value)) return;
    prev.current = value;
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on;
}

/** Subscribe to a CSS media query. SSR renders `false`. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const useIsMobile = () => useMedia('(max-width: 759px)');
export const useIsNarrow = () => useMedia('(max-width: 1023px)');
export const usePrefersReducedMotion = () => useMedia('(prefers-reduced-motion: reduce)');
export const useFinePointer = () => useMedia('(pointer: fine)');

/** USDC balance in base units (null when unknown, undefined while loading). */
export function useUsdcBalance(wallet: string | null | undefined, signing: boolean) {
  return useQuery({
    queryKey: qk.balance(wallet ?? ''),
    queryFn: () => fetchUsdcBalance(wallet as string),
    enabled: !!wallet && signing,
    staleTime: 20_000,
    refetchInterval: 45_000,
    retry: 1,
  });
}

export function useCopy(): [boolean, (text: string) => void] {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
    setDone(true);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setDone(false), 1600);
  };
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  return [done, copy];
}

/** Debounce a fast-changing value (search boxes, amount inputs). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
