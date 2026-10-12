import type { Metadata } from 'next';
import { MarketsPage } from '@/components/markets/MarketsPage';

export const metadata: Metadata = { title: 'Markets' };

export default function Page() {
  return <MarketsPage />;
}
