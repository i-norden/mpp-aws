import { readFileSync } from 'node:fs';
import { warn } from '../logging/index.js';

export class OFACChecker {
  private blocked: Set<string>;
  private commaSeparated: string;
  private filePath: string;

  constructor(commaSeparated: string, filePath: string) {
    this.commaSeparated = commaSeparated;
    this.filePath = filePath;
    this.blocked = loadAddresses(commaSeparated, filePath);
  }

  isBlocked(address: string): boolean {
    return this.blocked.has(address.toLowerCase());
  }

  count(): number {
    return this.blocked.size;
  }

  reload(): number {
    this.blocked = loadAddresses(this.commaSeparated, this.filePath);
    return this.blocked.size;
  }

  startPeriodicReload(intervalMs: number, onReload?: (count: number) => void): NodeJS.Timeout {
    return setInterval(() => {
      const count = this.reload();
      onReload?.(count);
    }, intervalMs);
  }
}

function loadAddresses(commaSeparated: string, filePath: string): Set<string> {
  const blocked = new Set<string>();

  if (commaSeparated) {
    for (const addr of commaSeparated.split(',')) {
      const trimmed = addr.trim();
      if (trimmed) blocked.add(trimmed.toLowerCase());
    }
  }

  if (filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          blocked.add(trimmed.toLowerCase());
        }
      }
    } catch (err) {
      warn('OFAC checker file load error', { filePath, error: String(err) });
    }
  }

  return blocked;
}

export function createOFACChecker(commaSeparated: string, filePath: string): OFACChecker | null {
  const checker = new OFACChecker(commaSeparated, filePath);
  return checker.count() > 0 ? checker : null;
}
