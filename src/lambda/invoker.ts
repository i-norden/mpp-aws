/**
 * Lambda invocation module.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/lambda/invoker.go
 * and the HTTP endpoint invocation at mmp-compute/lambda-proxy/internal/api/handlers_invoke.go.
 *
 * Supports two invocation modes:
 *   1. Lambda ARN  - invoked via AWS SDK (InvokeCommand)
 *   2. HTTPS URL   - invoked via HTTP POST with SSRF / DNS-rebinding protection
 */

import {
  InvokeCommand,
  LambdaClient,
  LogType,
  InvocationType,
} from '@aws-sdk/client-lambda';
import { promises as dns } from 'node:dns';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// InvocationResult
// ---------------------------------------------------------------------------

export interface InvocationResult {
  /** HTTP-style status code (Lambda statusCode or HTTP response status). */
  statusCode: number;
  /** Response body (raw bytes as a string). */
  body: string;
  /** Whether the invocation succeeded. */
  success: boolean;
  /** Billed duration in milliseconds (Lambda only, parsed from REPORT log). */
  billedDurationMs: number;
  /** Configured memory in MB (Lambda only, parsed from REPORT log). */
  memoryMB: number;
  /** Error message, if any. */
  error?: string;
  /** Selected response headers (HTTP endpoint only, e.g. X-Actual-Cost). */
  responseHeaders?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum HTTP response body size: 10 MB. */
const MAX_HTTP_RESPONSE_SIZE = 10 * 1024 * 1024;

/** Default Lambda invocation timeout: 5 minutes. */
const DEFAULT_INVOKE_TIMEOUT_SECONDS = 300;

/**
 * Regex to extract "Billed Duration: N ms" from a Lambda REPORT line.
 * The log tail is base64-encoded; we decode it first.
 */
const BILLED_DURATION_RE = /Billed Duration:\s+(\d+)\s+ms/;

/**
 * Regex to extract "Memory Size: N MB" from a Lambda REPORT line.
 */
const MEMORY_SIZE_RE = /Memory Size:\s+(\d+)\s+MB/;

// ---------------------------------------------------------------------------
// Private IP / SSRF helpers
// ---------------------------------------------------------------------------

/**
 * CIDR ranges considered private or reserved.
 * Connections to IPs within these ranges are blocked to prevent SSRF.
 */
const PRIVATE_CIDRS: Array<{ network: bigint; mask: bigint; bits: number }> = [
  // IPv4 private / reserved ranges
  ...parseCIDRs([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '100.64.0.0/10',
    '0.0.0.0/8',
  ]),
  // IPv6 private / reserved ranges
  ...parseCIDRs([
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]),
];

/** Pre-parse a list of CIDRs into { network, mask, bits } for fast containment checks. */
function parseCIDRs(cidrs: string[]): Array<{ network: bigint; mask: bigint; bits: number }> {
  return cidrs.map((cidr) => {
    const [addr, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const isV6 = addr.includes(':');
    const bits = isV6 ? 128 : 32;
    const ipBig = ipToBigInt(addr, isV6);
    const mask = bits === prefix ? (isV6 ? (1n << 128n) - 1n : (1n << 32n) - 1n) : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
    return { network: ipBig & mask, mask, bits };
  });
}

/** Convert an IP address string to a BigInt representation. */
function ipToBigInt(ip: string, isV6: boolean): bigint {
  if (isV6) {
    return ipv6ToBigInt(ip);
  }
  const parts = ip.split('.').map(Number);
  return (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]);
}

/** Expand and convert an IPv6 address to BigInt. */
function ipv6ToBigInt(ip: string): bigint {
  // Handle IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4Mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    const v4 = ipToBigInt(v4Mapped[1], false);
    return (0xFFFFn << 32n) | v4;
  }

  // Expand :: shorthand
  let parts: string[];
  if (ip.includes('::')) {
    const [left, right] = ip.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    parts = ip.split(':');
  }

  let result = 0n;
  for (const part of parts) {
    result = (result << 16n) | BigInt(parseInt(part || '0', 16));
  }
  return result;
}

/** Check if an IP (string) falls within any private/reserved CIDR range. */
function isPrivateIP(ip: string): boolean {
  const isV6 = ip.includes(':');
  const bits = isV6 ? 128 : 32;
  let ipBig: bigint;
  try {
    ipBig = ipToBigInt(ip, isV6);
  } catch {
    // If we can't parse it, treat it as private (fail-closed).
    return true;
  }

  for (const cidr of PRIVATE_CIDRS) {
    if (cidr.bits !== bits) continue;
    if ((ipBig & cidr.mask) === cidr.network) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a hostname and check whether any of its addresses fall within
 * private/reserved IP ranges. Returns true if the hostname should be blocked.
 */
export async function isSSRFBlocked(hostname: string): Promise<boolean> {
  let addresses: string[];
  try {
    // Resolve both IPv4 and IPv6 addresses
    const results = await dns.resolve(hostname);
    let v6Results: string[] = [];
    try {
      v6Results = await dns.resolve6(hostname);
    } catch {
      // No AAAA records is fine
    }
    addresses = [...results, ...v6Results];
  } catch {
    // DNS resolution failure -- block the request (fail-closed).
    return true;
  }

  if (addresses.length === 0) {
    return true;
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Log parsing helpers (mirrors Go's ParseBilledDurationMs)
// ---------------------------------------------------------------------------

/**
 * Decode a base64-encoded Lambda log tail and extract the "Billed Duration"
 * from the REPORT line. Returns 0 if the log is empty, malformed, or does
 * not contain a REPORT line.
 */
function parseBilledDurationMs(logResult: string | undefined): number {
  if (!logResult) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(logResult, 'base64').toString('utf-8');
  } catch {
    return 0;
  }
  const match = BILLED_DURATION_RE.exec(decoded);
  if (!match || !match[1]) return 0;
  return parseInt(match[1], 10);
}

/**
 * Decode a base64-encoded Lambda log tail and extract the "Memory Size"
 * from the REPORT line. Returns 0 if not found.
 */
function parseMemoryMB(logResult: string | undefined): number {
  if (!logResult) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(logResult, 'base64').toString('utf-8');
  } catch {
    return 0;
  }
  const match = MEMORY_SIZE_RE.exec(decoded);
  if (!match || !match[1]) return 0;
  return parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// LambdaInvoker
// ---------------------------------------------------------------------------

export class LambdaInvoker {
  private readonly client: LambdaClient;
  private readonly invokeTimeoutSeconds: number;

  constructor(region: string, invokeTimeoutSeconds?: number) {
    const clientConfig: Record<string, unknown> = { region };

    // Support custom endpoint (LocalStack, etc.)
    const endpointURL = process.env['AWS_ENDPOINT_URL'];
    if (endpointURL) {
      clientConfig['endpoint'] = endpointURL;
    }

    this.client = new LambdaClient(clientConfig);
    this.invokeTimeoutSeconds = invokeTimeoutSeconds ?? DEFAULT_INVOKE_TIMEOUT_SECONDS;
  }

  // -----------------------------------------------------------------------
  // invoke — AWS Lambda ARN
  // -----------------------------------------------------------------------

  /**
   * Invoke an AWS Lambda function by name or ARN.
   *
   * @param functionArn  Lambda function name, ARN, or partial ARN.
   * @param payload      JSON-serialisable payload to send.
   * @returns            Structured invocation result.
   */
  async invoke(functionArn: string, payload: unknown): Promise<InvocationResult> {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));

    const command = new InvokeCommand({
      FunctionName: functionArn,
      Payload: payloadBytes,
      InvocationType: InvocationType.RequestResponse,
      LogType: LogType.Tail,
    });

    // Apply a timeout via AbortController if nothing else constrains it.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.invokeTimeoutSeconds * 1000);

    try {
      const resp = await this.client.send(command, {
        abortSignal: controller.signal,
      });

      const statusCode = resp.StatusCode ?? 0;
      const logResult = resp.LogResult ?? undefined;
      const functionError = resp.FunctionError ?? undefined;

      // Decode response payload
      let body = '';
      if (resp.Payload) {
        body = new TextDecoder().decode(resp.Payload);
      }

      const billedDurationMs = parseBilledDurationMs(logResult);
      const memoryMB = parseMemoryMB(logResult);

      if (functionError) {
        return {
          statusCode,
          body,
          success: false,
          billedDurationMs,
          memoryMB,
          error: functionError,
        };
      }

      return {
        statusCode,
        body,
        success: true,
        billedDurationMs,
        memoryMB,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        statusCode: 0,
        body: '',
        success: false,
        billedDurationMs: 0,
        memoryMB: 0,
        error: `Lambda invocation failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // -----------------------------------------------------------------------
  // invokeHTTPEndpoint — HTTPS POST with SSRF protection
  // -----------------------------------------------------------------------

  /**
   * Invoke an HTTPS endpoint via POST with SSRF and DNS-rebinding protection.
   *
   * The hostname is resolved before the request is made and all resolved IPs
   * are validated against private/reserved ranges. Only HTTPS URLs are
   * accepted; plain HTTP is rejected.
   *
   * @param url             The HTTPS endpoint URL.
   * @param payload         JSON-serialisable payload to POST.
   * @param timeoutSeconds  Per-request timeout in seconds.
   * @returns               Structured invocation result.
   */
  async invokeHTTPEndpoint(
    url: string,
    payload: unknown,
    timeoutSeconds: number,
    authHeaders?: Record<string, string>,
  ): Promise<InvocationResult> {
    // Only HTTPS is allowed to prevent MITM attacks.
    if (!url.startsWith('https://')) {
      return {
        statusCode: 0,
        body: '',
        success: false,
        billedDurationMs: 0,
        memoryMB: 0,
        error: 'only HTTPS endpoints are supported',
      };
    }

    // Extract hostname for SSRF validation.
    let hostname: string;
    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
    } catch {
      return {
        statusCode: 0,
        body: '',
        success: false,
        billedDurationMs: 0,
        memoryMB: 0,
        error: `invalid URL: ${url}`,
      };
    }

    // DNS-rebinding protection: resolve and validate before connecting.
    const blocked = await isSSRFBlocked(hostname);
    if (blocked) {
      return {
        statusCode: 0,
        body: '',
        success: false,
        billedDurationMs: 0,
        memoryMB: 0,
        error: `SSRF blocked: ${hostname} resolves to a private/reserved IP`,
      };
    }

    // POST the payload with a timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders };
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });

      // Read body with size limit (10 MB).
      const reader = response.body?.getReader();
      if (!reader) {
        return {
          statusCode: response.status,
          body: '',
          success: response.ok,
          billedDurationMs: 0,
          memoryMB: 0,
          error: response.ok ? undefined : `HTTP ${response.status}`,
        };
      }

      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > MAX_HTTP_RESPONSE_SIZE) {
          reader.cancel();
          return {
            statusCode: response.status,
            body: '',
            success: false,
            billedDurationMs: 0,
            memoryMB: 0,
            error: `response body exceeded maximum size of ${MAX_HTTP_RESPONSE_SIZE} bytes`,
          };
        }
        chunks.push(value);
      }

      const bodyBuffer = Buffer.concat(chunks);
      const body = bodyBuffer.toString('utf-8');

      // Capture selected response headers for metered billing.
      const responseHeaders: Record<string, string> = {};
      const actualCost = response.headers.get('x-actual-cost');
      if (actualCost) {
        responseHeaders['X-Actual-Cost'] = actualCost;
      }

      const success = response.status >= 200 && response.status < 300;
      return {
        statusCode: response.status,
        body,
        success,
        billedDurationMs: 0,
        memoryMB: 0,
        error: success ? undefined : `HTTP ${response.status}`,
        responseHeaders: Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        statusCode: 0,
        body: '',
        success: false,
        billedDurationMs: 0,
        memoryMB: 0,
        error: `HTTP endpoint invocation failed: ${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
