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
import { URL } from 'node:url';
import {
  isSSRFBlocked,
  performPinnedHttpsRequest,
} from '../net/pinned-https.js';

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

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
      };
      const response = await performPinnedHttpsRequest(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        timeoutSeconds,
        maxResponseBytes: MAX_HTTP_RESPONSE_SIZE,
      });

      // Capture selected response headers for metered billing.
      const responseHeaders: Record<string, string> = {};
      const actualCost = response.headers['x-actual-cost'];
      if (actualCost) {
        responseHeaders['X-Actual-Cost'] = actualCost;
      }

      const success = response.statusCode >= 200 && response.statusCode < 300;
      return {
        statusCode: response.statusCode,
        body: response.body,
        success,
        billedDurationMs: 0,
        memoryMB: 0,
        error: success ? undefined : `HTTP ${response.statusCode}`,
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
    }
  }
}
