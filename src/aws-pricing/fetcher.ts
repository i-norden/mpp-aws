/**
 * AWS Pricing API fetcher.
 * Mirrors the Go implementation at mmp-compute/lambda-proxy/internal/awspricing/fetcher.go
 *
 * Fetches prices from the AWS Pricing API and caches them in the database
 * (aws_pricing table). The Pricing API is only available in us-east-1 and
 * ap-south-1, so the client is always created in us-east-1 while filtering
 * results by the target region.
 */

import {
  PricingClient,
  GetProductsCommand,
  type GetProductsCommandInput,
  type Filter,
} from '@aws-sdk/client-pricing';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../db/types.js';
import * as log from '../logging/index.js';

// ---------------------------------------------------------------------------
// Region-to-Location mapping
// ---------------------------------------------------------------------------

const REGION_LOCATIONS: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'eu-west-1': 'EU (Ireland)',
  'eu-central-1': 'EU (Frankfurt)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
};

function regionToLocation(region: string): string {
  return REGION_LOCATIONS[region] ?? 'US East (N. Virginia)';
}

// ---------------------------------------------------------------------------
// Price parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the on-demand price from a Pricing API product document.
 */
function extractOnDemandPrice(doc: Record<string, unknown>): number | null {
  const terms = doc['terms'] as Record<string, unknown> | undefined;
  if (!terms) return null;

  const onDemand = terms['OnDemand'] as Record<string, unknown> | undefined;
  if (!onDemand) return null;

  for (const termData of Object.values(onDemand)) {
    const term = termData as Record<string, unknown> | undefined;
    if (!term) continue;

    const priceDims = term['priceDimensions'] as Record<string, unknown> | undefined;
    if (!priceDims) continue;

    for (const dimData of Object.values(priceDims)) {
      const dim = dimData as Record<string, unknown> | undefined;
      if (!dim) continue;

      const pricePerUnit = dim['pricePerUnit'] as Record<string, string> | undefined;
      if (!pricePerUnit) continue;

      const usdStr = pricePerUnit['USD'];
      if (!usdStr) continue;

      const price = parseFloat(usdStr);
      if (!isNaN(price) && price > 0) {
        return price;
      }
    }
  }
  return null;
}

/**
 * Extracts instance type and per-hour price from an EC2 Pricing API response.
 */
function parseEC2Price(priceJSON: string): { instanceType: string; price: number } | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(priceJSON);
  } catch {
    return null;
  }

  const product = doc['product'] as Record<string, unknown> | undefined;
  if (!product) return null;

  const attrs = product['attributes'] as Record<string, string> | undefined;
  if (!attrs) return null;

  const instanceType = attrs['instanceType'];
  if (!instanceType) return null;

  const price = extractOnDemandPrice(doc);
  if (price === null) return null;

  return { instanceType, price };
}

/**
 * Extracts volume type and per-GB-month price from an EBS Pricing API response.
 */
function parseEBSPrice(priceJSON: string): { volumeType: string; price: number } | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(priceJSON);
  } catch {
    return null;
  }

  const product = doc['product'] as Record<string, unknown> | undefined;
  if (!product) return null;

  const attrs = product['attributes'] as Record<string, string> | undefined;
  if (!attrs) return null;

  const volumeType = attrs['volumeApiName'] ?? '';
  const price = extractOnDemandPrice(doc);
  if (price === null || price === 0) return null;

  return { volumeType, price };
}

// ---------------------------------------------------------------------------
// PriceFetcher
// ---------------------------------------------------------------------------

/**
 * Fetches prices from the AWS Pricing API and caches them in the database.
 */
export class PriceFetcher {
  private readonly client: PricingClient;
  private readonly db: Kysely<Database>;
  private readonly region: string;

  constructor(db: Kysely<Database>, targetRegion: string) {
    // The Pricing API is only available in us-east-1 and ap-south-1
    this.client = new PricingClient({ region: 'us-east-1' });
    this.db = db;
    this.region = targetRegion;
  }

  /**
   * Upserts a price row in the aws_pricing table.
   */
  private async upsertPrice(
    service: string,
    resourceKey: string,
    unit: string,
    priceUSD: number,
  ): Promise<void> {
    await this.db
      .insertInto('aws_pricing')
      .values({
        service,
        resource_key: resourceKey,
        region: this.region,
        unit,
        price_usd: priceUSD,
        last_fetched_at: sql`NOW()`,
      })
      .onConflict((oc) =>
        oc.columns(['service', 'resource_key', 'region']).doUpdateSet({
          price_usd: priceUSD,
          unit,
          last_fetched_at: sql`NOW()`,
        }),
      )
      .execute();
  }

  /**
   * Fetches all relevant prices from the AWS Pricing API.
   */
  async fetchAll(): Promise<void> {
    const errors: string[] = [];

    try {
      await this.fetchEC2Prices();
    } catch (err) {
      errors.push(`ec2: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.fetchEBSPrices();
    } catch (err) {
      errors.push(`ebs: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.fetchIPv4Prices();
    } catch (err) {
      errors.push(`ipv4: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.fetchDataTransferPrices();
    } catch (err) {
      errors.push(`data_transfer: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await this.fetchALBPrices();
    } catch (err) {
      errors.push(`alb: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (errors.length > 0) {
      throw new Error(`pricing fetch errors: ${errors.join(', ')}`);
    }
  }

  /**
   * Runs periodic price synchronization.
   *
   * @param intervalMs - Interval between syncs in milliseconds
   * @param signal     - AbortSignal to stop the sync loop
   */
  async runSync(intervalMs: number, signal?: AbortSignal): Promise<void> {
    const tick = async () => {
      try {
        await this.fetchAll();
        log.info('AWS pricing sync completed');
      } catch (err) {
        log.error('failed to sync AWS prices', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // Run until aborted
    while (!signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal?.aborted) break;
      await tick();
    }
  }

  /**
   * Fetches on-demand EC2 instance prices with pagination.
   */
  private async fetchEC2Prices(): Promise<void> {
    const filters: Filter[] = [
      { Type: 'TERM_MATCH', Field: 'location', Value: regionToLocation(this.region) },
      { Type: 'TERM_MATCH', Field: 'operatingSystem', Value: 'Linux' },
      { Type: 'TERM_MATCH', Field: 'tenancy', Value: 'Shared' },
      { Type: 'TERM_MATCH', Field: 'capacitystatus', Value: 'Used' },
      { Type: 'TERM_MATCH', Field: 'preInstalledSw', Value: 'NA' },
    ];

    let nextToken: string | undefined;
    let count = 0;

    do {
      const input: GetProductsCommandInput = {
        ServiceCode: 'AmazonEC2',
        Filters: filters,
        MaxResults: 100,
        NextToken: nextToken,
      };

      const result = await this.client.send(new GetProductsCommand(input));
      const priceList = result.PriceList ?? [];

      for (const priceJSON of priceList) {
        const parsed = parseEC2Price(priceJSON);
        if (!parsed) continue;

        try {
          await this.upsertPrice('ec2', parsed.instanceType, 'per_hour', parsed.price);
          count++;
        } catch (err) {
          log.error('failed to upsert EC2 price', {
            instanceType: parsed.instanceType,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      nextToken = result.NextToken ?? undefined;
    } while (nextToken);

    log.info('fetched EC2 prices', { count });
  }

  /**
   * Fetches EBS gp3 volume prices.
   */
  private async fetchEBSPrices(): Promise<void> {
    const filters: Filter[] = [
      { Type: 'TERM_MATCH', Field: 'location', Value: regionToLocation(this.region) },
      { Type: 'TERM_MATCH', Field: 'productFamily', Value: 'Storage' },
      { Type: 'TERM_MATCH', Field: 'volumeApiName', Value: 'gp3' },
    ];

    const input: GetProductsCommandInput = {
      ServiceCode: 'AmazonEC2',
      Filters: filters,
      MaxResults: 10,
    };

    const result = await this.client.send(new GetProductsCommand(input));
    const priceList = result.PriceList ?? [];

    for (const priceJSON of priceList) {
      const parsed = parseEBSPrice(priceJSON);
      if (!parsed || parsed.price === 0) continue;
      if (parsed.volumeType !== 'gp3') continue;
      await this.upsertPrice('ebs', 'gp3', 'per_gb_month', parsed.price);
      return;
    }
  }

  /**
   * Fetches (caches) public IPv4 address prices.
   * AWS charges $0.005/hour for public IPv4 addresses (as of Feb 2024).
   */
  private async fetchIPv4Prices(): Promise<void> {
    await this.upsertPrice('ipv4', 'public', 'per_hour', 0.005);
  }

  /**
   * Fetches (caches) data transfer out prices.
   * AWS data transfer out: $0.09/GB for the first 10TB.
   */
  private async fetchDataTransferPrices(): Promise<void> {
    await this.upsertPrice('data_transfer', 'out-standard', 'per_gb', 0.09);
  }

  /**
   * Fetches (caches) Application Load Balancer prices.
   * AWS charges $0.0225/hour for ALB in us-east-1 (as of 2024).
   */
  private async fetchALBPrices(): Promise<void> {
    await this.upsertPrice('alb', 'standard', 'per_hour', 0.0225);
  }
}
