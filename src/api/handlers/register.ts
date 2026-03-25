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
import { validateEthAddress } from '../../validation/index.js';
import { isSSRFBlocked } from '../../lambda/invoker.js';
import * as log from '../../logging/index.js';
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

  // DNS-rebinding protection: resolve hostname and check for private IPs
  const blocked = await isSSRFBlocked(hostname);
  if (blocked) {
    return { valid: false, error: 'hostname resolves to a private/reserved IP address' };
  }

  // Port validation
  if (parsed.port) {
    const portNum = parseInt(parsed.port, 10);
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return { valid: false, error: 'invalid port number' };
    }
  }

  return { valid: true };
}

/**
 * Verify that an endpoint is reachable (best-effort HEAD request).
 * Mirrors Go's verifyEndpoint.
 */
async function verifyEndpoint(
  endpoint: string,
  timeoutSeconds: number,
): Promise<{ reachable: boolean; authRequired: boolean; error?: string }> {
  const timeout = Math.min(Math.max(timeoutSeconds, 1), 30);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const resp = await fetch(endpoint, {
      method: 'HEAD',
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) {
      return { reachable: true, authRequired: true };
    }

    if (resp.status >= 500) {
      return { reachable: false, authRequired: false, error: 'endpoint returned server error' };
    }

    return { reachable: true, authRequired: false };
  } catch {
    return { reachable: false, authRequired: false, error: 'endpoint unreachable' };
  } finally {
    clearTimeout(timer);
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
      const examples = typeof fn.examples === 'string'
        ? JSON.parse(fn.examples as string) as FunctionExample[]
        : fn.examples as unknown as FunctionExample[];
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
      return c.json({ error: 'database not configured' }, 503);
    }

    // Parse request body
    let req: PublicRegisterRequest;
    try {
      req = await c.req.json() as PublicRegisterRequest;
    } catch {
      log.warn('invalid public register request body');
      return c.json({ error: 'invalid request body' }, 400);
    }

    // Validate required fields
    if (!req.endpoint) {
      return c.json({ error: 'invalid request body' }, 400);
    }

    if (!req.description || !req.description.trim()) {
      return c.json({
        error: 'missing required field',
        message: 'A non-empty description is required',
      }, 400);
    }

    const hasInputSchema = req.inputSchema !== undefined && req.inputSchema !== null;
    const hasDocURL = !!req.documentationUrl;
    const hasOpenAPIURL = !!req.openApiSpecUrl;

    if (!hasInputSchema && !hasDocURL && !hasOpenAPIURL) {
      return c.json({
        error: 'insufficient documentation',
        message: 'At least one of inputSchema, documentationUrl, or openApiSpecUrl must be provided',
      }, 400);
    }

    // Validate endpoint URL with SSRF protection
    const endpointValidation = await validateEndpointURL(req.endpoint, config.maxURLLength);
    if (!endpointValidation.valid) {
      return c.json({
        error: 'invalid endpoint URL',
        message: endpointValidation.error,
      }, 400);
    }

    // Validate pricing model
    let pricingModel = 'fixed';
    if (req.pricingModel) {
      if (req.pricingModel !== 'fixed' && req.pricingModel !== 'metered') {
        return c.json({
          error: 'invalid pricing model',
          message: "pricingModel must be 'fixed' or 'metered'",
        }, 400);
      }
      pricingModel = req.pricingModel;
    }

    if (pricingModel === 'metered' && req.customCostPerRequest === undefined) {
      return c.json({
        error: 'metered pricing requires customCostPerRequest',
        message: 'customCostPerRequest is required for metered pricing (serves as the price ceiling)',
      }, 400);
    }

    // Validate payToAddress if provided
    if (req.payToAddress) {
      try {
        validateEthAddress(req.payToAddress, 'payToAddress');
      } catch (err) {
        return c.json({
          error: 'invalid payToAddress',
          message: err instanceof Error ? err.message : String(err),
        }, 400);
      }
      if (ofacChecker && ofacChecker.isBlocked(req.payToAddress)) {
        return c.json({
          error: 'address_blocked',
          message: 'This address is not permitted to use this service',
        }, 403);
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
        return c.json({
          error: 'endpoint owned by another address',
          message: 'only the current owner can update a registered endpoint',
          functionId: functionID,
        }, 403);
      }
    }

    // Verify endpoint is reachable (optional health check)
    const verification = await verifyEndpoint(req.endpoint, config.endpointVerifyTimeout);
    if (!verification.reachable) {
      // If the endpoint returned 401/403 that's acceptable (requires auth)
      if (!verification.authRequired) {
        return c.json({
          error: 'endpoint unreachable',
          message: 'Failed to reach endpoint within timeout',
        }, 400);
      }
      log.info('endpoint returned auth-required during verification (expected with auth config)');
    }

    // Get payment info
    const paymentInfo = getPaymentInfo(c);
    if (!paymentInfo) {
      return c.json({ error: 'payment info missing' }, 500);
    }

    // Validate visibility
    let visibility = 'public';
    if (req.visibility) {
      if (req.visibility !== 'public' && req.visibility !== 'private') {
        return c.json({
          error: 'invalid visibility',
          message: "visibility must be 'public' or 'private'",
        }, 400);
      }
      visibility = req.visibility;
    }

    // Validate access list size
    if (req.allowedInvokers && req.allowedInvokers.length > config.maxAccessListSize) {
      return c.json({
        error: 'access list too large',
        message: `maximum ${config.maxAccessListSize} addresses allowed in access list`,
      }, 400);
    }

    // Validate custom cost per request
    if (req.customCostPerRequest !== undefined) {
      const baseFee = pricingEngine.calculateInvocationCost(0, 0);
      if (BigInt(req.customCostPerRequest) < baseFee) {
        return c.json({
          error: 'custom cost too low',
          message: `customCostPerRequest must be >= ${baseFee} (base fee)`,
        }, 400);
      }
      const maxBaseFee = baseFee * 1000n;
      if (BigInt(req.customCostPerRequest) > maxBaseFee) {
        return c.json({
          error: 'custom cost too high',
          message: `customCostPerRequest must be <= ${maxBaseFee} (1000x base fee)`,
        }, 400);
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
      return c.json({ error: 'failed to register endpoint' }, 500);
    }

    // If private and allowedInvokers provided, insert into access list
    if (visibility === 'private' && req.allowedInvokers && req.allowedInvokers.length > 0) {
      for (const addr of req.allowedInvokers) {
        const trimmed = addr.trim().toLowerCase();
        if (!trimmed) continue;
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
