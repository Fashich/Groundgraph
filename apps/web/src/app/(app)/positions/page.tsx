import type { Metadata } from 'next';
import { PositionsPage } from '@/components/positions/PositionsPage';

export const metadata: Metadata = { title: 'Positions' };

export default function Page() {
  return <PositionsPage />;
}
