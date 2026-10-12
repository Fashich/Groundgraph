import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './globals.css';
import { Providers } from '@/components/providers';
import { loadLegal } from '@/lib/legal.server';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: { default: 'Groundgraph | Price markets and smart money radar', template: '%s | Groundgraph' },
  description: 'Non-custodial ABOVE and BELOW price markets on Solana, with an explainable smart money radar. Runs on Solana devnet.',
  icons: { icon: '/gg-icon.png', apple: '/gg-icon.png' },
  applicationName: 'Groundgraph',
  openGraph: { title: 'Groundgraph', description: 'Price markets with an explainable smart money radar on Solana.', images: ['/gg-logo-full.png'] },
};

export const viewport: Viewport = { themeColor: '#07060C', colorScheme: 'dark', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const legal = await loadLegal();
  return (
    <html lang="en">
      <body>
        <a href="#main" className="gg-skip">
          Skip to content
        </a>
        <Providers legal={legal}>{children}</Providers>
      </body>
    </html>
  );
}
