import type { Metadata } from 'next';
import { RadarPage } from '@/components/radar/RadarPage';

export const metadata: Metadata = { title: 'Smart Money Radar' };

export default function Page() {
  return <RadarPage />;
}
