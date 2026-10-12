'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFinePointer } from '@/lib/hooks';

/** Animated custom scrollbar for fine pointers (mouse, trackpad). Decorative: native scrolling stays untouched. */
export function ScrollRail() {
  const fine = useFinePointer();
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const drag = useRef(false);

  const sync = useCallback(() => {
    const r = rail.current;
    const t = thumb.current;
    if (!r || !t) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    setVisible(max > 40);
    if (max <= 0) return;
    const h = Math.max(48, Math.round(r.clientHeight * (window.innerHeight / doc.scrollHeight)));
    t.style.height = `${h}px`;
    t.style.transform = `translateY(${(window.scrollY / max) * (r.clientHeight - h)}px)`;
  }, []);

  useEffect(() => {
    if (!fine) return;
    sync();
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    const ro = new ResizeObserver(sync);
    ro.observe(document.body);
    return () => {
      window.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      ro.disconnect();
    };
  }, [fine, sync]);

  const jump = (clientY: number) => {
    const r = rail.current;
    const t = thumb.current;
    if (!r || !t) return;
    const box = r.getBoundingClientRect();
    const th = t.offsetHeight;
    const ratio = Math.min(1, Math.max(0, (clientY - box.top - th / 2) / (box.height - th)));
    window.scrollTo({ top: ratio * (document.documentElement.scrollHeight - window.innerHeight) });
  };

  if (!fine) return null;
  return (
    <div
      ref={rail}
      data-component="ScrollRail"
      aria-hidden="true"
      onPointerDown={(e) => {
        drag.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        jump(e.clientY);
      }}
      onPointerMove={(e) => drag.current && jump(e.clientY)}
      onPointerUp={() => (drag.current = false)}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className="fixed bottom-2.5 right-[3px] top-[72px] z-[56] w-3.5 cursor-pointer touch-none transition-opacity duration-[400ms]"
      style={{ opacity: !visible ? 0 : hover ? 1 : 0.45, pointerEvents: visible ? 'auto' : 'none' }}
    >
      <span className="pointer-events-none absolute inset-y-0 left-0 right-0 mx-auto w-0.5 rounded-sm bg-[linear-gradient(180deg,rgba(155,107,255,0.04),rgba(155,107,255,0.2),rgba(155,107,255,0.04))]" />
      <span
        ref={thumb}
        className="absolute inset-x-0 top-0 mx-auto h-14 animate-gg-flow rounded-pill bg-[linear-gradient(180deg,#2CE6D6,#9B6BFF,#E046F0,#9B6BFF,#2CE6D6)] bg-[length:100%_200%] shadow-[0_0_10px_rgba(155,107,255,0.45)] transition-[width,box-shadow] duration-[250ms] will-change-transform"
        style={{ width: hover ? 6 : 4 }}
      />
    </div>
  );
}
