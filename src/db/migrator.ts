import { type Kysely, type Migration, type MigrationProvider, Migrator, sql } from 'kysely';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Resolves the migrations directory relative to this file.
 * In dev (tsx): __dirname points at src/db/ -> ../../db/migrations
 * In prod (compiled): __dirname points at dist/db/ -> ../../db/migrations
 * Either way the db/ folder lives at the project root.
 */
function migrationsDir(): string {
  // When running via tsx the file is src/db/migrator.ts
  // When running compiled it is dist/db/migrator.js
  // In both cases we go up two levels to reach the project root.
  const projectRoot = path.resolve(import.meta.dirname, '..', '..');
  return path.join(projectRoot, 'db', 'migrations');
}

/**
 * A MigrationProvider that reads raw .sql files from the db/migrations
 * directory and wraps each one in a Kysely Migration object.
 *
 * Up migrations live at   db/migrations/NNN_name.sql
 * Down migrations live at db/migrations/down/NNN_name.down.sql
 */
class SqlFileMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const dir = migrationsDir();
    const files = await fs.readdir(dir);

    const sqlFiles = files
      .filter((f) => f.endsWith('.sql') && !f.includes('.down.'))
      .sort();

    const migrations: Record<string, Migration> = {};

    for (const file of sqlFiles) {
      const key = file.replace(/\.sql$/, '');
      const upPath = path.join(dir, file);

      // Derive the matching down file name: 001_initial.sql -> 001_initial.down.sql
      const downFile = file.replace(/\.sql$/, '.down.sql');
      const downPath = path.join(dir, 'down', downFile);

      migrations[key] = {
        async up(db: Kysely<unknown>): Promise<void> {
          const content = await fs.readFile(upPath, 'utf-8');
          await sql.raw(content).execute(db);
        },
        async down(db: Kysely<unknown>): Promise<void> {
          try {
            const content = await fs.readFile(downPath, 'utf-8');
            await sql.raw(content).execute(db);
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              throw new Error(
                `Down migration file not found: ${downPath}`,
              );
            }
            throw err;
          }
        },
      };
    }

    return migrations;
  }
}

export interface MigrationResult {
  migrationName: string;
  direction: 'Up' | 'Down';
  status: 'Success' | 'Error' | 'NotExecuted';
}

export interface RunMigrationsOutput {
  results: MigrationResult[];
  error?: unknown;
}

/**
 * Run all pending up-migrations against the provided Kysely instance.
 */
export async function runMigrations<T>(db: Kysely<T>): Promise<RunMigrationsOutput> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(),
  });

  const { results, error } = await migrator.migrateToLatest();

  const mapped: MigrationResult[] = (results ?? []).map((r) => ({
    migrationName: r.migrationName,
    direction: r.direction === 'Up' ? 'Up' as const : 'Down' as const,
    status: r.status === 'Success'
      ? 'Success' as const
      : r.status === 'Error'
        ? 'Error' as const
        : 'NotExecuted' as const,
  }));

  return { results: mapped, error };
}

/**
 * Roll back the most recent migration.
 */
export async function rollbackMigration<T>(db: Kysely<T>): Promise<RunMigrationsOutput> {
  const migrator = new Migrator({
    db,
    provider: new SqlFileMigrationProvider(),
  });

  const { results, error } = await migrator.migrateDown();

  const mapped: MigrationResult[] = (results ?? []).map((r) => ({
    migrationName: r.migrationName,
    direction: r.direction === 'Up' ? 'Up' as const : 'Down' as const,
    status: r.status === 'Success'
      ? 'Success' as const
      : r.status === 'Error'
        ? 'Error' as const
        : 'NotExecuted' as const,
  }));

  return { results: mapped, error };
}
