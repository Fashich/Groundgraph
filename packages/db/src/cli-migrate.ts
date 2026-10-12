import { createDb } from './client';
import { runMigrations } from './migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const handle = createDb(url, { max: 2, applicationName: 'groundgraph-migrate' });
try {
  const res = await runMigrations(handle.sql, { log: (m) => console.log(m) });
  console.log(JSON.stringify(res));
} finally {
  await handle.close();
}
