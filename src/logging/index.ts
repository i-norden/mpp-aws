import { createRequire } from 'node:module';
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const isJSON = process.env.LOG_JSON !== 'false';
const require = createRequire(import.meta.url);

function resolvePrettyTransport() {
  if (isJSON) {
    return {};
  }

  try {
    require.resolve('pino-pretty');
    return {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    };
  } catch {
    return {};
  }
}

export const logger = pino({
  level,
  ...resolvePrettyTransport(),
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

// Convenience helpers matching Go's logging package
export function info(msg: string, fields?: Record<string, unknown>) {
  if (fields) logger.info(fields, msg);
  else logger.info(msg);
}

export function warn(msg: string, fields?: Record<string, unknown>) {
  if (fields) logger.warn(fields, msg);
  else logger.warn(msg);
}

export function error(msg: string, fields?: Record<string, unknown>) {
  if (fields) logger.error(fields, msg);
  else logger.error(msg);
}

export function debug(msg: string, fields?: Record<string, unknown>) {
  if (fields) logger.debug(fields, msg);
  else logger.debug(msg);
}
