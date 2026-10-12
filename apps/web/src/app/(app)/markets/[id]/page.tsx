import { Suspense } from 'react';
import type { Metadata } from 'next';
import { MarketDetailPage } from '@/components/market/MarketDetailPage';

const API_ORIGIN = (process.env.API_ORIGIN || 'http://localhost:8787').replace(/\/$/, '');

/** Share previews: the question and the current implied price from the API, plus the API's own OG image. Falls back quietly. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const fallback: Metadata = { title: 'Market' };
  try {
    const res = await fetch(`${API_ORIGIN}/markets/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(1500), next: { revalidate: 60 } });
    if (!res.ok) return fallback;
    const m = (await res.json()) as { question?: string; priceAbove?: number };
    if (!m.question) return fallback;
    const description =
      typeof m.priceAbove === 'number'
        ? `Implied: ABOVE ${Math.round(m.priceAbove * 100)}¢ · BELOW ${Math.round((1 - m.priceAbove) * 100)}¢. Each side settles at $1 or $0. Devnet.`
        : 'ABOVE and BELOW price market on Solana devnet.';
    const images = [`/og/m/${encodeURIComponent(id)}.png`];
    return { title: m.question, description, openGraph: { title: m.question, description, images }, twitter: { card: 'summary_large_image', title: m.question, description, images } };
  } catch {
    return fallback;
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={null}>
      <MarketDetailPage id={id} />
    </Suspense>
  );
}
