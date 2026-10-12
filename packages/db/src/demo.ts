import type { Sql } from './client';

/** data_source value written by synthetic seed/demo generators. Served only when DEMO_MODE=true. */
export const DEMO_SOURCE = 'demo-synthetic';

/** SQL fragment: hides demo rows unless demo mode is on. `column` is a trusted constant identifier. */
export function notDemo(sql: Sql, demoMode: boolean, column = 'data_source') {
  return demoMode ? sql`true` : sql`${sql(column)} <> ${DEMO_SOURCE}`;
}

export function isServable(dataSource: string, demoMode: boolean): boolean {
  return demoMode || dataSource !== DEMO_SOURCE;
}
