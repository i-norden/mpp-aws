/**
 * Register handler — handles POST /register.
 * TypeScript port of mmp-compute/lambda-proxy/internal/api/handlers_register.go
 *
 * Allows agents to pay-to-register their own HTTPS endpoints in the
 * open-compute registry. Registration creates (or updates) a function record
 * and optionally configures access control for private functions.
 */

import type { Context } from 'hono';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database, LambdaFunctionTable } from '../../db/types.js';
import type { Config } from '../../config/index.js';
import type { PricingEngine } from '../../pricing/engine.js';
import { getPaymentInfo } from '../middleware/mpp.js';
import { validateEthAddress, isValidEthAddress } from '../../validation/index.js';
import {
  performPinnedHttpsRequest,
  resolvePublicHostname,
} from '../../net/pinned-https.js';
import * as log from '../../logging/index.js';
import { errorResponse, ErrorCodes } from '../errors.js';
import type { OFACChecker } from '../../ofac/checker.js';
import type { Selectable, Insertable } from 'kysely';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LambdaFunction = Selectable<LambdaFunctionTable>;

export interface RegisterDeps {
  db: Kysely<Database> | null;
  config: Config;
  pricingEngine: PricingEngine;
  ofacChecker?: OFACChecker | null;
}

interface FunctionExample {
  name: string;
  description?: string;
  input: unknown;
  output?: unknown;
}

interface PublicRegisterRequest {
  endpoint: string;
  description: string;
  tags?: string[];
  inputSchema?: unknown;
  outputSchema?: unknown;
  examples?: FunctionExample[];
  version?: string;
  author?: string;
  documentationUrl?: string;
  openApiSpecUrl?: string;
  customCostPerRequest?: number;
  payToAddress?: string;
  pricingModel?: string;
  visibility?: string;
  allowedInvokers?: string[];
}

interface CostEstimate {
  estimated: string;
  atomicUsdc: bigint;
  paymentAsset: string;
  paymentMethod: string;
  pricingModel?: string;
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

/**
 * Generate a deterministic function ID from the endpoint URL.
 * Mirrors Go's generateFunctionID using SHA-256.
 */
async function generateFunctionID(endpoint: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(endpoint);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ext-${hex}`;
}

/**
 * Validate an endpoint URL with SSRF protection.
 * Mirrors Go's validateEndpointURL.
 */
interface EndpointValidationResult {
  valid: boolean;
  error?: string;
  resolvedIP?: string;
}

async function validateEndpointURL(
  endpoint: string,
  maxURLLength: number,
): Promise<EndpointValidationResult> {
  if (!endpoint) {
    return { valid: false, error: 'endpoint URL is required' };
  }

  if (endpoint.length > maxURLLength) {
    return { valid: false, error: `endpoint URL too long (max ${maxURLLength} characters)` };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return { valid: false, error: 'invalid URL format' };
  }

  // Must be HTTPS
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'endpoint must use HTTPS' };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { valid: false, error: 'endpoint must have a hostname' };
  }

  // Block localhost and common local hostnames
  const lowerHost = hostname.toLowerCase();
  const blockedHosts = [
    'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  ];
  if (blockedHosts.includes(lowerHost)) {
    return { valid: false, error: 'localhost addresses are not allowed' };
  }

  // Block dangerous TLDs
  const blockedSuffixes = [
    '.local', '.internal', '.localhost', '.localdomain',
    '.home', '.lan', '.intranet', '.corp', '.private',
  ];
  for (const suffix of blockedSuffixes) {
    if (lowerHost.endsWith(suffix)) {
      return { valid: false, error: `domains ending in '${suffix}' are not allowed` };
    }
  }

  if (parsed.port) {
    const portNum = parseInt(parsed.port, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return { valid: false, error: 'invalid port number' };
    }
  }

  try {
    const addresses = await resolvePublicHostname(hostname);
    return { valid: true, resolvedIP: addresses[0] };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'hostname resolves to a private/reserved IP address',
    };
  }
}

/**
 * Verify that an endpoint is reachable (best-effort HEAD request).
 * Mirrors Go's verifyEndpoint.
 */
async function verifyEndpoint(
  endpoint: string,
  timeoutSeconds: number,
): Promise<{ reachable: boolean; authRequired: boolean; error?: string }> {
  try {
    let resp = await performPinnedHttpsRequest(endpoint, {
      method: 'HEAD',
      timeoutSeconds,
      maxResponseBytes: 1024,
    });

    if (resp.statusCode === 405 || resp.statusCode === 501) {
      resp = await performPinnedHttpsRequest(endpoint, {
        method: 'GET',
        timeoutSeconds,
        maxResponseBytes: 16 * 1024,
      });
    }

    if (resp.statusCode === 401 || resp.statusCode === 403) {
      return { reachable: true, authRequired: true };
    }

    if (resp.statusCode >= 500) {
      return { reachable: false, authRequired: false, error: 'endpoint returned server error' };
    }

    return { reachable: true, authRequired: false };
  } catch (err) {
    return {
      reachable: false,
      authRequired: false,
      error: err instanceof Error ? err.message : 'endpoint unreachable',
    };
  }
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
// createRegisterHandlers
// ---------------------------------------------------------------------------

export function createRegisterHandlers(deps: RegisterDeps) {
  const { db, config, pricingEngine, ofacChecker } = deps;

  // -------------------------------------------------------------------
  // getRegistrationFee
  // -------------------------------------------------------------------

  function getRegistrationFee(_c: Context): bigint {
    return config.registrationFee;
  }

  // -------------------------------------------------------------------
  // getRegistrationDescription
  // -------------------------------------------------------------------

  function getRegistrationDescription(_c: Context): string {
    return 'Register compute endpoint in open-compute registry';
  }

  // -------------------------------------------------------------------
  // handlePublicRegister — POST /register
  // -------------------------------------------------------------------

  async function handlePublicRegister(c: Context): Promise<Response> {
    if (!db) {
      return errorResponse(c, 503, ErrorCodes.SERVICE_UNAVAILABLE, 'database not configured');
    }

    // Parse request body
    let req: PublicRegisterRequest;
    try {
      req = await c.req.json() as PublicRegisterRequest;
    } catch {
      log.warn('invalid public register request body');
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    // Validate required fields
    if (!req.endpoint) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'invalid request body');
    }

    if (!req.description || !req.description.trim()) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'A non-empty description is required');
    }

    const hasInputSchema = req.inputSchema !== undefined && req.inputSchema !== null;
    const hasDocURL = !!req.documentationUrl;
    const hasOpenAPIURL = !!req.openApiSpecUrl;

    if (!hasInputSchema && !hasDocURL && !hasOpenAPIURL) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'At least one of inputSchema, documentationUrl, or openApiSpecUrl must be provided');
    }

    // Validate endpoint URL with SSRF protection
    const endpointValidation = await validateEndpointURL(req.endpoint, config.maxURLLength);
    if (!endpointValidation.valid) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, endpointValidation.error ?? 'invalid endpoint URL');
    }

    // Validate pricing model
    let pricingModel = 'fixed';
    if (req.pricingModel) {
      if (req.pricingModel !== 'fixed' && req.pricingModel !== 'metered') {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "pricingModel must be 'fixed' or 'metered'");
      }
      pricingModel = req.pricingModel;
    }

    if (pricingModel === 'metered' && req.customCostPerRequest === undefined) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'customCostPerRequest is required for metered pricing (serves as the price ceiling)');
    }

    // Validate payToAddress if provided
    if (req.payToAddress) {
      try {
        validateEthAddress(req.payToAddress, 'payToAddress');
      } catch (err) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err));
      }
      if (ofacChecker && ofacChecker.isBlocked(req.payToAddress)) {
        return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'This address is not permitted to use this service');
      }
    }

    // Generate function ID
    const functionID = await generateFunctionID(req.endpoint);

    // Check if already registered (prevent ownership hijacking)
    const existing = await db
      .selectFrom('lambda_functions')
      .selectAll()
      .where('function_name', '=', functionID)
      .executeTakeFirst();

    if (existing) {
      const paymentInfo = getPaymentInfo(c);
      const existingOwner = existing.owner_address ?? '';
      if (
        existingOwner &&
        paymentInfo &&
        existingOwner.toLowerCase() !== paymentInfo.payer.toLowerCase()
      ) {
        return errorResponse(c, 403, ErrorCodes.FORBIDDEN, 'only the current owner can update a registered endpoint', { functionId: functionID });
      }
    }

    // Verify endpoint is reachable (optional health check)
    const verification = await verifyEndpoint(req.endpoint, config.endpointVerifyTimeout);
    if (!verification.reachable) {
      // If the endpoint returned 401/403 that's acceptable (requires auth)
      if (!verification.authRequired) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, 'Failed to reach endpoint within timeout');
      }
      log.info('endpoint returned auth-required during verification (expected with auth config)');
    }

    // Get payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'payment info missing');
    }

    // Validate visibility
    let visibility = 'public';
    if (req.visibility) {
      if (req.visibility !== 'public' && req.visibility !== 'private') {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, "visibility must be 'public' or 'private'");
      }
      visibility = req.visibility;
    }

    // Validate access list size
    if (req.allowedInvokers && req.allowedInvokers.length > config.maxAccessListSize) {
      return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, `maximum ${config.maxAccessListSize} addresses allowed in access list`);
    }

    // Validate custom cost per request
    if (req.customCostPerRequest !== undefined) {
      const baseFee = pricingEngine.calculateInvocationCost(0, 0);
      if (BigInt(req.customCostPerRequest) < baseFee) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, `customCostPerRequest must be >= ${baseFee} (base fee)`);
      }
      const maxBaseFee = baseFee * 1000n;
      if (BigInt(req.customCostPerRequest) > maxBaseFee) {
        return errorResponse(c, 400, ErrorCodes.INVALID_REQUEST, `customCostPerRequest must be <= ${maxBaseFee} (1000x base fee)`);
      }
    }

    // Build the function record for upsert
    const fnValues: Insertable<LambdaFunctionTable> = {
      function_arn: req.endpoint,
      function_name: functionID,
      description: req.description,
      memory_mb: 0,
      timeout_seconds: 30,
      estimated_duration_ms: 1000,
      enabled: true,
      tags: req.tags ?? [],
      visibility,
      pricing_model: pricingModel,
      owner_address: paymentInfo.payer || null,
      pay_to_address: req.payToAddress ? req.payToAddress.toLowerCase() : null,
      custom_base_fee: req.customCostPerRequest !== undefined
        ? BigInt(req.customCostPerRequest)
        : null,
      input_schema: hasInputSchema ? (req.inputSchema as unknown) : null,
      output_schema: req.outputSchema !== undefined ? (req.outputSchema as unknown) : null,
      examples: req.examples ? (JSON.parse(JSON.stringify(req.examples)) as never) : undefined,
      version: req.version ?? '',
      author: req.author || paymentInfo.payer || null,
      documentation_url: req.documentationUrl || null,
      open_api_spec_url: req.openApiSpecUrl || null,
    };

    // Upsert (insert or update on conflict)
    let created = false;
    try {
      if (existing) {
        // Update existing
        await db
          .updateTable('lambda_functions')
          .set({
            ...fnValues,
            updated_at: sql`NOW()`,
          })
          .where('function_name', '=', functionID)
          .execute();
        created = false;
      } else {
        // Insert new
        await db.insertInto('lambda_functions').values(fnValues).execute();
        created = true;
      }
    } catch (err) {
      log.error('failed to register public endpoint', {
        payer: paymentInfo.payer,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(c, 500, ErrorCodes.INTERNAL_ERROR, 'failed to register endpoint');
    }

    // If private and allowedInvokers provided, insert into access list
    if (visibility === 'private' && req.allowedInvokers && req.allowedInvokers.length > 0) {
      for (const addr of req.allowedInvokers) {
        const trimmed = addr.trim().toLowerCase();
        if (!trimmed) continue;
        if (!isValidEthAddress(trimmed)) {
          log.warn('skipping invalid invoker address during registration', {
            function: functionID,
            address: trimmed,
          });
          continue;
        }
        try {
          await db.insertInto('function_access_list').values({
            function_name: functionID,
            invoker_address: trimmed,
            granted_by: paymentInfo.payer,
          }).execute();
        } catch (err) {
          log.warn('failed to add access list entry during registration', {
            function: functionID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Log for audit trail
    if (created) {
      log.info('public endpoint registered (created)', {
        function: functionID,
        payer: paymentInfo.payer,
        txHash: paymentInfo.txHash,
      });
    } else {
      log.warn('public endpoint registered (updated existing)', {
        function: functionID,
        payer: paymentInfo.payer,
        txHash: paymentInfo.txHash,
      });
    }

    // Build the FunctionSpec for the response by re-reading from DB
    let spec: FunctionSpec | null = null;
    try {
      const row = await db
        .selectFrom('lambda_functions')
        .selectAll()
        .where('function_name', '=', functionID)
        .executeTakeFirst();
      if (row) {
        spec = dbFunctionToSpec(row, pricingEngine);
      }
    } catch {
      // Non-critical; spec will be null in response
    }

    const status = created ? 201 : 200;
    const message = created ? 'function registered (created)' : 'function registered (updated)';

    return c.json({
      message,
      created,
      functionId: functionID,
      registrationFee: formatUSD(paymentInfo.amount),
      txHash: paymentInfo.txHash,
      function: spec,
    }, status);
  }

  return {
    getRegistrationFee,
    getRegistrationDescription,
    handlePublicRegister,
  };
}
