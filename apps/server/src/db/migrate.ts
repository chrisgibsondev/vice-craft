/** `npm run migrate` — apply pending migrations and exit. */
import { openDb, migrate } from './index.ts';

const db = await openDb();
await migrate(db);
await db.close();
console.log('migrations up to date');
