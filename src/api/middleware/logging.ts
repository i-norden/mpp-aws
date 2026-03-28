import type { MiddlewareHandler } from 'hono';

import { logger } from '../../logging/index.js';
import {
  activeConnections,
  requestsTotal,
  requestDuration,
} from '../../metrics/index.js';
import { getClientIp } from '../../http/client-ip.js';
import { getRequestId } from './request-id.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ETH_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const LONG_TOKEN_RE = /^[A-Za-z0-9_-]{24,}$/;

export function requestLoggingMiddleware(trustProxyHeaders: boolean): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = process.hrtime.bigint();
    activeConnections.inc();

    let thrown: unknown;

    try {
      await next();
    } catch (error) {
      thrown = error;
    }

    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const method = c.req.method;
    const path = normalizePathForMetrics(c.req.path);
    const status = thrown ? 500 : c.res.status;
    const requestId = getRequestId(c);
    const clientIp = getClientIp(c, trustProxyHeaders);

    requestsTotal.inc({ method, path, status: String(status) });
    requestDuration.observe({ method, path }, durationSeconds);
    activeConnections.dec();

    const logPayload = {
      clientIp,
      durationMs: Math.round(durationSeconds * 1000),
      method,
      path,
      requestId,
      status,
    };

    if (thrown) {
      logger.error(
        {
          ...logPayload,
          error: thrown instanceof Error ? thrown.message : String(thrown),
        },
        'request failed',
      );
      throw thrown;
    }

    if (status >= 500) {
      logger.error(logPayload, 'request completed');
      return;
    }

    if (status >= 400) {
      logger.warn(logPayload, 'request completed');
      return;
    }

    logger.info(logPayload, 'request completed');
  };
}

function normalizePathForMetrics(path: string): string {
  const routePatterns: Array<[RegExp, string]> = [
    [/^\/invoke\/[^/]+\/batch$/, '/invoke/:function/batch'],
    [/^\/invoke\/[^/]+$/, '/invoke/:function'],
    [/^\/functions\/[^/]+\/analytics$/, '/functions/:name/analytics'],
    [/^\/functions\/[^/]+\/details$/, '/functions/:name/details'],
    [/^\/functions\/[^/]+\/access$/, '/functions/:name/access'],
    [/^\/functions\/[^/]+\/disable$/, '/functions/:name/disable'],
    [/^\/functions\/[^/]+\/enable$/, '/functions/:name/enable'],
    [/^\/functions\/[^/]+\/transfer$/, '/functions/:name/transfer'],
    [/^\/functions\/[^/]+\/transfer\/accept$/, '/functions/:name/transfer/accept'],
    [/^\/credits\/0x[0-9a-f]{40}$/, '/credits/:address'],
    [/^\/credits\/0x[0-9a-f]{40}\/history$/, '/credits/:address/history'],
    [/^\/credits\/0x[0-9a-f]{40}\/redeem$/, '/credits/:address/redeem'],
    [/^\/earnings\/0x[0-9a-f]{40}$/, '/earnings/:address'],
    [/^\/earnings\/0x[0-9a-f]{40}\/history$/, '/earnings/:address/history'],
    [/^\/earnings\/0x[0-9a-f]{40}\/functions$/, '/earnings/:address/functions'],
    [/^\/earnings\/0x[0-9a-f]{40}\/withdraw$/, '/earnings/:address/withdraw'],
    [/^\/jobs\/[^/]+$/, '/jobs/:jobId'],
    [/^\/lease\/[^/]+$/, '/lease/:resourceId'],
    [/^\/lease\/[^/]+\/[^/]+\/status$/, '/lease/:resourceId/:leaseId/status'],
    [/^\/lease\/[^/]+\/[^/]+\/renew$/, '/lease/:resourceId/:leaseId/renew'],
    [/^\/budgets\/[^/]+$/, '/budgets/:budgetId'],
    [/^\/admin\/functions\/[^/]+$/, '/admin/functions/:name'],
    [/^\/admin\/stats\/[^/]+$/, '/admin/stats/:function'],
    [/^\/admin\/leases\/[^/]+$/, '/admin/leases/:id'],
    [/^\/admin\/leases\/[^/]+\/terminate$/, '/admin/leases/:id/terminate'],
    [/^\/admin\/leases\/[^/]+\/extend$/, '/admin/leases/:id/extend'],
    [/^\/admin\/leases\/[^/]+\/data$/, '/admin/leases/:id/data'],
    [/^\/admin\/resources\/[^/]+$/, '/admin/resources/:id'],
    [/^\/admin\/resources\/[^/]+\/utilization$/, '/admin/resources/:id/utilization'],
  ];

  for (const [pattern, normalized] of routePatterns) {
    if (pattern.test(path)) {
      return normalized;
    }
  }

  const normalizedSegments = path.split('/').map((segment) => {
    if (!segment) {
      return segment;
    }

    if (ETH_ADDRESS_RE.test(segment)) {
      return ':address';
    }

    if (UUID_RE.test(segment)) {
      return ':id';
    }

    if (/^\d+$/.test(segment)) {
      return ':number';
    }

    if (LONG_TOKEN_RE.test(segment)) {
      return ':token';
    }

    return segment;
  });

  return normalizedSegments.join('/') || '/';
}
