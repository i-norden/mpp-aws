import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { runMigrations, rollbackMigration } from './migrator.js';

const { Pool } = pg;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is not set.');
    process.exit(1);
  }

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: databaseUrl }),
    }),
  });

  const command = process.argv[2] ?? 'up';

  try {
    if (command === 'down' || command === 'rollback') {
      console.log('Rolling back the most recent migration...');
      const { results, error } = await rollbackMigration(db);

      for (const r of results) {
        console.log(`  [${r.status}] ${r.direction} ${r.migrationName}`);
      }

      if (error) {
        console.error('Rollback failed:', error);
        await db.destroy();
        process.exit(1);
      }

      if (results.length === 0) {
        console.log('No migrations to roll back.');
      } else {
        console.log('Rollback complete.');
      }
    } else {
      console.log('Running migrations...');
      const { results, error } = await runMigrations(db);

      for (const r of results) {
        console.log(`  [${r.status}] ${r.direction} ${r.migrationName}`);
      }

      if (error) {
        console.error('Migration failed:', error);
        await db.destroy();
        process.exit(1);
      }

      if (results.length === 0) {
        console.log('No new migrations to run.');
      } else {
        console.log(`Successfully applied ${results.length} migration(s).`);
      }
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
