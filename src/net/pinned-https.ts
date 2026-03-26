import { promises as dns } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

const PRIVATE_CIDRS: Array<{ network: bigint; mask: bigint; bits: number }> = [
  ...parseCIDRs([
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '100.64.0.0/10',
    '0.0.0.0/8',
  ]),
  ...parseCIDRs([
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]),
];

export interface PinnedHttpsResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  pinnedAddress: string;
}

interface PinnedHttpsRequestOptions {
  method: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutSeconds: number;
  maxResponseBytes?: number;
}

function parseCIDRs(
  cidrs: string[],
): Array<{ network: bigint; mask: bigint; bits: number }> {
  return cidrs.map((cidr) => {
    const [addr, prefixStr] = cidr.split('/');
    const prefix = parseInt(prefixStr, 10);
    const isV6 = addr.includes(':');
    const bits = isV6 ? 128 : 32;
    const ipBig = ipToBigInt(addr, isV6);
    const mask = prefix === bits
      ? (1n << BigInt(bits)) - 1n
      : ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n);
    return { network: ipBig & mask, mask, bits };
  });
}

function ipToBigInt(ip: string, isV6: boolean): bigint {
  if (isV6) {
    return ipv6ToBigInt(ip);
  }

  const parts = ip.split('.').map(Number);
  return (BigInt(parts[0]) << 24n)
    | (BigInt(parts[1]) << 16n)
    | (BigInt(parts[2]) << 8n)
    | BigInt(parts[3]);
}

function ipv6ToBigInt(ip: string): bigint {
  const v4Mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) {
    const v4 = ipToBigInt(v4Mapped[1], false);
    return (0xffffn << 32n) | v4;
  }

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

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase();
}

export function isPrivateIP(ip: string): boolean {
  const isV6 = ip.includes(':');
  const bits = isV6 ? 128 : 32;
  let ipBig: bigint;

  try {
    ipBig = ipToBigInt(ip, isV6);
  } catch {
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

function isIgnorableDNSError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return code === 'ENODATA' || code === 'ENOTFOUND' || code === 'ESERVFAIL';
}

export async function resolvePublicHostname(hostname: string): Promise<string[]> {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    throw new Error('hostname is required');
  }

  if (isIP(normalizedHostname)) {
    if (isPrivateIP(normalizedHostname)) {
      throw new Error('hostname resolves to a private/reserved IP address');
    }
    return [normalizedHostname];
  }

  const addresses = new Set<string>();

  try {
    for (const address of await dns.resolve4(normalizedHostname)) {
      addresses.add(address);
    }
  } catch (error) {
    if (!isIgnorableDNSError(error)) {
      throw error;
    }
  }

  try {
    for (const address of await dns.resolve6(normalizedHostname)) {
      addresses.add(address);
    }
  } catch (error) {
    if (!isIgnorableDNSError(error)) {
      throw error;
    }
  }

  if (addresses.size === 0) {
    throw new Error('hostname did not resolve');
  }

  const resolved = Array.from(addresses);
  for (const address of resolved) {
    if (isPrivateIP(address)) {
      throw new Error('hostname resolves to a private/reserved IP address');
    }
  }

  return resolved;
}

export async function isSSRFBlocked(hostname: string): Promise<boolean> {
  try {
    await resolvePublicHostname(hostname);
    return false;
  } catch {
    return true;
  }
}

function createPinnedLookup(
  address: string,
): NonNullable<RequestOptions['lookup']> {
  const family = address.includes(':') ? 6 : 4;

  return ((_: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function'
      ? options as (...args: unknown[]) => void
      : callback as ((...args: unknown[]) => void) | undefined;

    if (!cb) {
      return;
    }

    if (typeof options === 'object' && options !== null && 'all' in options && (options as { all?: boolean }).all) {
      cb(null, [{ address, family }]);
      return;
    }

    cb(null, address, family);
  }) as NonNullable<RequestOptions['lookup']>;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return normalized;
}

function sendPinnedHttpsRequestToAddress(
  url: URL,
  address: string,
  options: PinnedHttpsRequestOptions,
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.min(Math.max(options.timeoutSeconds, 1), 300) * 1000;
    const maxResponseBytes = options.maxResponseBytes ?? (10 * 1024 * 1024);
    const hostname = normalizeHostname(url.hostname);

    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname,
      port: url.port ? parseInt(url.port, 10) : 443,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      servername: hostname,
      lookup: createPinnedLookup(address),
    };

    const request = httpsRequest(requestOptions, (response) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;

      response.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalSize += buffer.length;

        if (totalSize > maxResponseBytes) {
          response.destroy(new Error(`response body exceeded maximum size of ${maxResponseBytes} bytes`));
          return;
        }

        chunks.push(buffer);
      });

      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: normalizeHeaders(response.headers),
          body: Buffer.concat(chunks).toString('utf-8'),
          pinnedAddress: address,
        });
      });

      response.on('error', reject);
    });

    request.on('error', reject);

    const timer = setTimeout(() => {
      request.destroy(new Error('request timed out'));
    }, timeoutMs);

    request.on('close', () => {
      clearTimeout(timer);
    });

    if (options.body !== undefined) {
      request.write(options.body);
    }

    request.end();
  });
}

export async function performPinnedHttpsRequest(
  endpoint: string,
  options: PinnedHttpsRequestOptions,
): Promise<PinnedHttpsResponse> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw new Error('only HTTPS endpoints are supported');
  }

  const addresses = await resolvePublicHostname(url.hostname);
  let lastError: unknown = null;

  for (const address of addresses) {
    try {
      return await sendPinnedHttpsRequestToAddress(url, address, options);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('endpoint unreachable');
}
