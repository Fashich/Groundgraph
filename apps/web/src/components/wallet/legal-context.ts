'use client';

import { createContext, useContext } from 'react';
import type { LegalDoc, LegalDocKey } from '@/lib/legal';

export const LegalContext = createContext<Record<LegalDocKey, LegalDoc> | null>(null);

export function useLegalDocs(): Record<LegalDocKey, LegalDoc> {
  const v = useContext(LegalContext);
  if (!v) throw new Error('LegalContext missing');
  return v;
}
