import { redirect } from 'next/navigation';

/** Short share link used by Blinks. Opens the market page. */
export default async function ShortMarket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/markets/${encodeURIComponent(id)}`);
}
