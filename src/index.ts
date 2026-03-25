import { loadConfig, validate, validateProductionSafety } from './config/index.js';
import { createDatabase } from './db/index.js';
import { runMigrations } from './db/migrator.js';
import { createApp, startServer } from './server.js';
import { logger } from './logging/index.js';
import type { Database } from './db/types.js';
import type { Kysely } from 'kysely';

async function main() {
  // Load and validate configuration
  const config = loadConfig();

  try {
    validate(config);
  } catch (err) {
    logger.fatal({ error: String(err) }, 'Configuration validation failed');
    process.exit(1);
  }

  try {
    const { warnings } = validateProductionSafety(config);
    for (const w of warnings) {
      logger.warn(w);
    }
  } catch (err) {
    logger.fatal({ error: String(err) }, 'Production safety check failed');
    process.exit(1);
  }

  // Initialize database if configured
  let db: Kysely<Database> | undefined;
  if (config.databaseURL) {
    db = createDatabase(config.databaseURL);
    logger.info('Database connection pool created');

    // Run migrations
    try {
      await runMigrations(db);
      logger.info('Database migrations complete');
    } catch (err) {
      logger.fatal({ error: err }, 'Database migration failed');
      process.exit(1);
    }
  } else {
    logger.warn('DATABASE_URL not set, running without persistence');
  }

  // Create full app with all dependencies
  const { app, workers, billingService } = createApp({ config, db });

  // Start servers and wire up graceful shutdown
  startServer(app, config, { workers, billingService, db });
}

main().catch((err) => {
  logger.fatal({ error: err }, 'Unhandled error during startup');
  process.exit(1);
});
