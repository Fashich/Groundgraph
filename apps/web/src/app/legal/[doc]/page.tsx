import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cn } from '@groundgraph/ui';
import { Logo } from '@/components/common/Logo';
import { LEGAL_KEYS, LEGAL_TAB, type LegalDocKey } from '@/lib/legal';
import { loadLegal } from '@/lib/legal.server';

export const dynamicParams = false;

export function generateStaticParams() {
  return LEGAL_KEYS.map((doc) => ({ doc }));
}

const isKey = (v: string): v is LegalDocKey => (LEGAL_KEYS as string[]).includes(v);

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  if (!isKey(doc)) return {};
  const docs = await loadLegal();
  return { title: docs[doc].title };
}

export default async function LegalPage({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!isKey(doc)) notFound();
  const docs = await loadLegal();
  const d = docs[doc];
  return (
    <main id="main" data-component="LegalPage" className="mx-auto w-full max-w-[860px] px-[clamp(16px,4vw,40px)] py-[clamp(24px,4vw,56px)]">
      <div className="mb-8">
        <Logo />
      </div>
      <nav aria-label="Legal documents" className="mb-8 flex flex-wrap items-center gap-2">
        {LEGAL_KEYS.map((k) => (
          <Link key={k} href={`/legal/${k}`} aria-current={k === doc ? 'page' : undefined} className={cn('gg-chip', k === doc && 'data-[on=true]:border-violet')} data-on={k === doc}>
            {LEGAL_TAB[k]}
          </Link>
        ))}
        <Link href="/markets" className="ml-auto text-sm text-dim hover:text-above">
          Back to the app
        </Link>
      </nav>
      <header className="flex flex-col gap-3">
        <h1 className="m-0 font-display text-[clamp(30px,4vw,44px)] font-semibold leading-[1.05] tracking-[-0.03em]">{d.title}</h1>
        <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-faint">
          <span>Version {d.version}</span>
          <span>Updated {d.updated}</span>
          <span>{d.readTime}</span>
        </p>
        {d.intro ? <p className="m-0 mt-2 text-base leading-relaxed text-ink-2">{d.intro}</p> : null}
      </header>
      <div className="mt-10 flex flex-col gap-7">
        {d.sections.map((s) => (
          <section key={s.n} id={`s${s.n}`} className="grid gap-x-6 gap-y-2 border-t border-violet/[0.12] pt-6 min-[760px]:grid-cols-[56px_minmax(0,1fr)]">
            <span className="font-mono text-xs leading-[2] text-violet">{s.n}</span>
            <div className="flex flex-col gap-2">
              <h2 className="m-0 font-display text-lg font-semibold leading-[1.3]">{s.t}</h2>
              <p className="m-0 text-[15px] leading-[1.65] text-muted">{s.d}</p>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
