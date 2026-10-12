import type { Metadata } from 'next';
import { CreateMarketPage } from '@/components/create/CreateMarketPage';

export const metadata: Metadata = { title: 'Create a market' };

export default function Page() {
  return <CreateMarketPage />;
}
