/**
 * Function listing, search, and analytics handlers.
 * TypeScript port of:
 *   - mmp-compute/lambda-proxy/internal/api/handlers_invoke.go (HandleListFunctions)
 *   - mmp-compute/lambda-proxy/internal/api/handlers_search.go (HandleSearchFunctions)
 *   - mmp-compute/lambda-proxy/internal/api/handlers_analytics.go (HandleGetFunctionAnalytics)
 */

import type { Context } from 'hono';
import type { Kysely, SqlBool } from 'kysely';
import { sql } from 'kysely';
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import * as log from '../../logging/index.js';
import { errorResponse, ErrorCodes } from '../errors.js';
import type { Selectable } from 'kysely';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

export interface FunctionsDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
}

interface CostEstimate {
  estimated: string;
  atomicUsdc: bigint;
  paymentAsset: string;
  paymentMethod: string;
  pricingModel?: string;
}

interface FunctionExample {
  name: string;
  description?: string;
  input: unknown;
  output?: unknown;
}

interface FunctionSpec {
  name: string;
  arn?: string;
  version?: string;
  author?: string;
  documentationUrl?: string;
  openApiSpecUrl?: string;
  description: string;
  tags?: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  examples?: FunctionExample[];
  cost: CostEstimate;
  memoryMB?: number;
  timeoutSeconds?: number;
  ownerAddress?: string;
  visibility?: string;
  payToAddress?: string;
  pricingModel?: string;
  hasAuth?: boolean;
  authType?: string;
}

interface DiscoveryResponse {
  functions: FunctionSpec[];
  network: string;
  payTo: string;
  total: number;
  availableTags?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format atomic USDC (6 decimals) as a USD string.
 */
function formatUSD(atomicAmount: bigint): string {
  const dollars = Number(atomicAmount) / 1_000_000;
  if (Math.abs(dollars) < 0.01) {
    return `$${dollars.toFixed(4)}`;
  }
  return `$${dollars.toFixed(2)}`;
}

/** Matches Go's safeFunctionNamePattern: alphanumeric, hyphens, underscores, max 170 chars. */
const SAFE_FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]{1,170}$/;

function normalizeFunctionName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!SAFE_FUNCTION_NAME_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

/**
 * Split a comma-separated tag string into an array of trimmed, non-empty tags.
 */
function splitTags(s: string): string[] {
  if (!s) return [];
  return s.split(',').map((t) => t.trim()).filter((t) => t !== '');
}

/**
 * Convert a database function record to an API FunctionSpec.
 * Mirrors Go's Handler.dbFunctionToSpec.
 */
function dbFunctionToSpec(fn: LambdaFunction, pricingEngine: PricingEngine): FunctionSpec {
  let cost = pricingEngine.calculateInvocationCost(fn.memory_mb, fn.estimated_duration_ms);
  if (fn.custom_base_fee !== null && fn.custom_base_fee !== undefined) {
    cost = BigInt(fn.custom_base_fee);
  }

  const pricingModel = fn.pricing_model || 'fixed';

  const spec: FunctionSpec = {
    name: fn.function_name,
    arn: fn.function_arn,
    memoryMB: fn.memory_mb,
    timeoutSeconds: fn.timeout_seconds,
    tags: fn.tags?.length ? fn.tags : undefined,
    pricingModel,
    description: fn.description ?? '',
    cost: {
      estimated: formatUSD(cost),
      atomicUsdc: cost,
      paymentAsset: 'USDC',
      paymentMethod: 'mpp',
      pricingModel,
    },
  };

  if (fn.version) spec.version = fn.version;
  if (fn.author) spec.author = fn.author;
  if (fn.documentation_url) spec.documentationUrl = fn.documentation_url;
  if (fn.open_api_spec_url) spec.openApiSpecUrl = fn.open_api_spec_url;
  if (fn.owner_address) spec.ownerAddress = fn.owner_address;
  if (fn.visibility) spec.visibility = fn.visibility;
  if (fn.pay_to_address) spec.payToAddress = fn.pay_to_address;
  if (fn.endpoint_auth_encrypted) spec.hasAuth = true;
  if (fn.auth_type) spec.authType = fn.auth_type;
  if (fn.input_schema) spec.inputSchema = fn.input_schema;
  if (fn.output_schema) spec.outputSchema = fn.output_schema;
  if (fn.examples) {
    try {
      const raw = typeof fn.examples === 'string'
        ? JSON.parse(fn.examples)
        : fn.examples;
      const examples = Array.isArray(raw) ? raw as FunctionExample[] : [];
      if (Array.isArray(examples) && examples.length > 0) {
        spec.examples = examples;
      }
    } catch {
      // Ignore malformed examples
    }
  }

  return spec;
}

// ---------------------------------------------------------------------------
// createFunctionsHandlers
// ---------------------------------------------------------------------------

export function createFunctionsHandlers(deps: FunctionsDeps) {
  const { db, config, pricingEngine } = deps;

  // -------------------------------------------------------------------
  // handleListFunctions — GET /functions
  // -------------------------------------------------------------------

  async function handleListFunctions(c: Context): Promise<Response> {
    const tagsParam = c.req.query('tags') ?? '';
    const format = c.req.query('format') ?? 'full';

    const specs: FunctionSpec[] = [];
    const tagSet = new Set<string>();

    if (db) {
      try {
        let query = db
          .selectFrom('lambda_functions')
          .selectAll()
          .where('enabled', '=', true)
          .where('visibility', '=', 'public')
          .orderBy('function_name', 'asc');

        // Tag filtering
        if (tagsParam) {
          const tags = splitTags(tagsParam);
          if (tags.length > 0) {
            // Filter by tags using array overlap (&&)
            query = query.where(
              sql<SqlBool>`tags && ARRAY[${sql.join(tags)}]::text[]`,
            );
          }
        }

        const rows = await query.execute();

        for (const fn of rows) {
          const spec = dbFunctionToSpec(fn, pricingEngine);
          specs.push(spec);
          if (fn.tags) {
            for (const tag of fn.tags) {
              tagSet.add(tag);
            }
          }
        }
      } catch (err) {
        log.error('failed to list functions from database', {
          error: err instanceof Error ? err.message : String(err),
        });
        return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to list functions');
      }
    }

    // Simple format for backward compatibility
    if (format === 'simple') {
      const simple = specs.map((s) => ({
        name: s.name,
        arn: s.arn,
        estimatedCost: s.cost.estimated,
        estimatedCostAtomic: s.cost.atomicUsdc,
      }));
      return c.json({ functions: simple });
    }

    // Anthropic Messages API format
    if (format === 'anthropic') {
      const tools = specs.map((s) => {
        const inputSchema = s.inputSchema ?? { type: 'object', properties: {} };
        let desc = s.description;
        if (s.cost.estimated) {
          desc += `\n\nCost: ${s.cost.estimated} per invocation (MPP payment handled automatically).`;
        }
        if (s.outputSchema) {
          desc += '\n\nOutput schema is provided in metadata.output_schema.';
        }

        return {
          name: s.name,
          description: desc,
          input_schema: inputSchema,
          metadata: {
            output_schema: s.outputSchema,
            examples: s.examples,
            cost: s.cost,
            tags: s.tags,
            timeout_seconds: s.timeoutSeconds,
          },
        };
      });

      return c.json({
        tools,
        payment_context: buildPaymentContext(config),
        network: config.network,
        payTo: config.payToAddress,
        total: tools.length,
        availableTags: Array.from(tagSet),
      });
    }

    // OpenAI function-calling format
    if (format === 'openai') {
      const tools = specs.map((s) => {
        const params = s.inputSchema ?? { type: 'object', properties: {} };
        let desc = s.description;
        if (s.cost.estimated) {
          desc += ` (cost: ${s.cost.estimated})`;
        }
        if (s.outputSchema) {
          desc += ' Output schema provided in output_schema field.';
        }

        const funcDef: Record<string, unknown> = {
          name: s.name,
          description: desc,
          parameters: params,
        };
        if (s.outputSchema) funcDef['output_schema'] = s.outputSchema;
        if (s.examples && s.examples.length > 0) funcDef['examples'] = s.examples;

        return {
          type: 'function',
          function: funcDef,
        };
      });

      return c.json({
        tools,
        network: config.network,
        payTo: config.payToAddress,
        total: tools.length,
        payment_context: buildPaymentContext(config),
      });
    }

    // Full discovery response (default)
    const response: DiscoveryResponse = {
      functions: specs,
      network: config.network,
      payTo: config.payToAddress,
      total: specs.length,
      availableTags: tagSet.size > 0 ? Array.from(tagSet) : undefined,
    };

    return c.json(response);
  }

  // -------------------------------------------------------------------
  // handleSearchFunctions — GET /functions/search?q=<query>&limit=20
  // -------------------------------------------------------------------

  async function handleSearchFunctions(c: Context): Promise<Response> {
    const query = c.req.query('q') ?? '';
    if (!query) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "query parameter 'q' is required");
    }

    let limit = 20;
    const limitStr = c.req.query('limit');
    if (limitStr) {
      const parsed = parseInt(limitStr, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        limit = parsed;
      }
    }

    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    try {
      const rows = await db
        .selectFrom('lambda_functions')
        .selectAll()
        .where('enabled', '=', true)
        .where('visibility', '=', 'public')
        .where(
          sql<SqlBool>`search_vector @@ websearch_to_tsquery('english', ${query})`,
        )
        .orderBy(
          sql`ts_rank(search_vector, websearch_to_tsquery('english', ${query}))`,
          'desc',
        )
        .limit(limit)
        .execute();

      const specs = rows.map((fn) => dbFunctionToSpec(fn, pricingEngine));

      return c.json({
        query,
        results: specs,
        total: specs.length,
      });
    } catch (err) {
      log.error('failed to search functions', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'search failed');
    }
  }

  // -------------------------------------------------------------------
  // handleGetFunctionAnalytics — GET /functions/:name/analytics
  // -------------------------------------------------------------------

  async function handleGetFunctionAnalytics(c: Context): Promise<Response> {
    const rawName = c.req.param('name') ?? '';
    if (!rawName) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'function name is required');
    }

    const functionName = normalizeFunctionName(rawName);
    if (!functionName) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid function name');
    }

    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    try {
      // Query invocation stats from lambda_invocations
      const stats = await db
        .selectFrom('lambda_invocations')
        .select([
          sql<bigint>`COUNT(*)`.as('total_invocations'),
          sql<bigint>`COUNT(*) FILTER (WHERE success = true)`.as('successful'),
          sql<bigint>`COUNT(*) FILTER (WHERE success = false)`.as('failed'),
          sql<bigint>`COALESCE(SUM(amount_paid), 0)`.as('total_revenue'),
          sql<number>`COALESCE(AVG(NULLIF(duration_ms, 0)), 0)`.as('avg_duration_ms'),
          sql<number>`COALESCE(MAX(duration_ms), 0)`.as('max_duration_ms'),
          sql<number>`COALESCE(MIN(NULLIF(duration_ms, 0)), 0)`.as('min_duration_ms'),
          sql<bigint>`COUNT(DISTINCT payer_address)`.as('unique_payers'),
          sql<Date | null>`MIN(created_at)`.as('first_invocation'),
          sql<Date | null>`MAX(created_at)`.as('last_invocation'),
          sql<bigint>`COALESCE(SUM(refund_amount) FILTER (WHERE refund_amount IS NOT NULL), 0)`.as('total_refunds'),
        ])
        .where('function_name', '=', functionName)
        .executeTakeFirst();

      if (!stats || stats.total_invocations === 0n) {
        return errorResponse(c, 404, ErrorCodes.NOT_FOUND, 'This function has no recorded invocations yet');
      }

      return c.json({
        functionName,
        totalInvocations: Number(stats.total_invocations),
        successful: Number(stats.successful),
        failed: Number(stats.failed),
        successRate: Number(stats.total_invocations) > 0
          ? Number(stats.successful) / Number(stats.total_invocations)
          : 0,
        totalRevenue: Number(stats.total_revenue),
        totalRevenueUSD: formatUSD(BigInt(stats.total_revenue)),
        avgDurationMs: Math.round(Number(stats.avg_duration_ms)),
        maxDurationMs: Number(stats.max_duration_ms),
        minDurationMs: Number(stats.min_duration_ms),
        uniquePayers: Number(stats.unique_payers),
        firstInvocation: stats.first_invocation
          ? new Date(stats.first_invocation).toISOString()
          : null,
        lastInvocation: stats.last_invocation
          ? new Date(stats.last_invocation).toISOString()
          : null,
        totalRefunds: Number(stats.total_refunds),
        totalRefundsUSD: formatUSD(BigInt(stats.total_refunds)),
      });
    } catch (err) {
      log.error('failed to get function analytics', {
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to retrieve analytics');
    }
  }

  return {
    handleListFunctions,
    handleSearchFunctions,
    handleGetFunctionAnalytics,
  };
}

// ---------------------------------------------------------------------------
// buildPaymentContext (mirrors Go's buildPaymentContext)
// ---------------------------------------------------------------------------

function buildPaymentContext(cfg: Config) {
  return {
    protocol: 'mpp',
    description:
      'Payment is handled via the Machine Payments Protocol (MPP). Send a request, receive a 402 challenge, authorize the payment, and retry with an MPP credential in the Authorization header.',
    pay_to: cfg.payToAddress,
    asset: 'USDC',
    network: cfg.network,
    flow: [
      '1. POST /invoke/{function} with payload',
      '2. Receive 402 with payment requirements and challenge metadata',
      '3. Authorize the requested USDC payment',
      '4. Retry the request with an MPP credential in the Authorization header',
      '5. Receive 200 with the function result and payment receipt headers',
    ],
  };
}
