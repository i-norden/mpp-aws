/**
 * Refund service for on-chain USDC refunds.
 * TypeScript port of mmp-compute/lambda-proxy/internal/refund/service.go
 * Uses viem instead of go-ethereum.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  type Hex,
  type Address,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
  type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

import { warn } from '../logging/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conservative gas limit for ERC20 transfer calls.
 *  Typical ERC20 transfers use ~65k gas; this is padded for safety. */
const ERC20_TRANSFER_GAS_LIMIT = 100_000n;

/** Gas limit for a simple native ETH transfer (21000 is the exact cost). */
const ETH_TRANSFER_GAS_LIMIT = 21_000n;

/** Minimal ERC20 ABI for transfer and balanceOf calls. */
const erc20Abi = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Refund transaction status. */
export type RefundStatus = 'success' | 'pending' | 'failed';

/** Result of a refund attempt. */
export interface RefundResult {
  status: RefundStatus;
  txHash?: string;
  gasUsed?: bigint;
  error?: Error;
}

/** Configuration for constructing a RefundService. */
export interface RefundServiceConfig {
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /** Hex-encoded private key (with or without 0x prefix) */
  privateKey: string;
  /** USDC contract address */
  usdcAddress: string;
  /** Chain ID — 84532n for Base Sepolia, 8453n for Base mainnet */
  chainId: bigint;
}

// ---------------------------------------------------------------------------
// Nonce mutex
// ---------------------------------------------------------------------------

/**
 * Simple async mutex implemented as a promise queue.
 * Serializes nonce-fetch -> sign -> send to prevent nonce collisions
 * across concurrent async calls (single-threaded but with async gaps).
 */
class AsyncMutex {
  private _queue: Promise<void> = Promise.resolve();

  /** Acquire the lock. Returns a release function. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this._queue;
    this._queue = next;
    return prev.then(() => release);
  }
}

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

function chainFromId(chainId: bigint): Chain {
  switch (chainId) {
    case 8453n:
      return base;
    case 84532n:
      return baseSepolia;
    default:
      throw new Error(`unsupported chain ID: ${chainId}`);
  }
}

// ---------------------------------------------------------------------------
// Private key parsing & validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a hex-encoded private key, logging security warnings
 * when running in production with raw environment variable keys.
 * In production, consider using AWS KMS, HashiCorp Vault, or other secret managers.
 */
function parseAndValidatePrivateKey(keyInput: string): Hex {
  if (keyInput === '') {
    throw new Error('private key is required for refund service');
  }

  // Check if running in production environment
  const env = process.env.ENVIRONMENT ?? '';
  const isProduction = env === 'production' || env === 'prod';

  if (isProduction) {
    warn(
      'Using raw private key from environment variable in production. ' +
        'Consider using AWS KMS, HashiCorp Vault, or another secret manager for enhanced security. ' +
        'Set REFUND_PRIVATE_KEY via secret injection rather than plain environment variables.',
    );
  }

  // Normalize the key (remove 0x prefix if present for validation)
  const keyHex = keyInput.startsWith('0x') ? keyInput.slice(2) : keyInput;

  // Validate key format
  if (keyHex.length !== 64) {
    throw new Error(
      `invalid private key format: expected 64 hex characters (32 bytes), got ${keyHex.length}`,
    );
  }

  // Verify it's valid hex
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('invalid private key format: not valid hexadecimal');
  }

  // Return with 0x prefix for viem
  return `0x${keyHex}` as Hex;
}

// ---------------------------------------------------------------------------
// RefundService
// ---------------------------------------------------------------------------

export class RefundService {
  private readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  private readonly fromAddress: Address;
  private readonly usdcAddress: Address;
  private readonly nonceMu = new AsyncMutex();

  constructor(cfg: RefundServiceConfig) {
    const chain = chainFromId(cfg.chainId);
    const validatedKey = parseAndValidatePrivateKey(cfg.privateKey);
    const account = privateKeyToAccount(validatedKey);

    const transport = http(cfg.rpcUrl);

    this.publicClient = createPublicClient({
      chain,
      transport,
    }) as PublicClient<Transport, Chain>;

    this.walletClient = createWalletClient({
      account,
      chain,
      transport,
    }) as WalletClient<Transport, Chain, Account>;

    this.fromAddress = account.address;
    this.usdcAddress = cfg.usdcAddress as Address;
  }

  // -----------------------------------------------------------------------
  // Public accessors
  // -----------------------------------------------------------------------

  /** Returns the address that refunds are sent from. */
  getFromAddress(): Address {
    return this.fromAddress;
  }

  // -----------------------------------------------------------------------
  // buildAndSendTx (nonce-locked critical section)
  // -----------------------------------------------------------------------

  /**
   * Holds the nonce lock only for the nonce-fetch -> sign -> send critical
   * section, then releases it so receipt waiting can proceed without blocking
   * other refunds.
   */
  private async buildAndSendTx(
    toAddress: string,
    amount: bigint,
  ): Promise<Hex> {
    const release = await this.nonceMu.acquire();
    try {
      const to = toAddress as Address;

      // Get pending nonce
      const nonce = await this.publicClient.getTransactionCount({
        address: this.fromAddress,
        blockTag: 'pending',
      });

      // Get gas tip cap (maxPriorityFeePerGas)
      const gasTipCap = await this.publicClient.estimateMaxPriorityFeePerGas();

      // Get latest block for base fee
      const block = await this.publicClient.getBlock({ blockTag: 'latest' });
      if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
        throw new Error('failed to get block base fee');
      }
      const baseFee = block.baseFeePerGas;

      // Dynamic fee: baseFee * 2 + gasTipCap
      const gasFeeCap = baseFee * 2n + gasTipCap;

      // Encode ERC20 transfer(to, amount)
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [to, amount],
      });

      // Send the transaction via wallet client
      const txHash = await this.walletClient.sendTransaction({
        to: this.usdcAddress,
        data,
        value: 0n,
        gas: ERC20_TRANSFER_GAS_LIMIT,
        maxFeePerGas: gasFeeCap,
        maxPriorityFeePerGas: gasTipCap,
        nonce,
        chain: null,
      });

      return txHash;
    } finally {
      release();
    }
  }

  // -----------------------------------------------------------------------
  // sendRefund
  // -----------------------------------------------------------------------

  /**
   * Sends a USDC refund to the specified address.
   * The nonce mutex serializes the nonce-fetch -> sign -> send sequence to
   * prevent concurrent refunds from getting the same nonce. The lock is
   * released after sendTransaction so receipt waiting does not block other
   * refunds.
   *
   * @param toAddress - Recipient Ethereum address
   * @param amount - Amount in atomic USDC (6 decimals)
   * @returns RefundResult with status, txHash, gasUsed, and optional error
   */
  async sendRefund(toAddress: string, amount: bigint): Promise<RefundResult> {
    let txHash: Hex;
    try {
      txHash = await this.buildAndSendTx(toAddress, amount);
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    // Wait for receipt (outside the nonce lock so other refunds can proceed)
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 5 * 60 * 1_000, // 5 minutes in milliseconds
      });

      if (receipt.status === 'reverted') {
        return {
          status: 'failed',
          txHash,
          gasUsed: receipt.gasUsed,
          error: new Error('transaction reverted'),
        };
      }

      return {
        status: 'success',
        txHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (err) {
      // Transaction was sent but we couldn't confirm - mark as pending, not success
      return {
        status: 'pending',
        txHash,
        error:
          err instanceof Error
            ? new Error(`transaction sent but receipt not confirmed: ${err.message}`)
            : new Error('transaction sent but receipt not confirmed'),
      };
    }
  }

  // -----------------------------------------------------------------------
  // sendETH
  // -----------------------------------------------------------------------

  /**
   * Sends native ETH to the specified address.
   * @param toAddress - Recipient Ethereum address
   * @param amountWei - Amount in wei
   */
  async sendETH(toAddress: string, amountWei: bigint): Promise<RefundResult> {
    let txHash: Hex;
    try {
      txHash = await this.buildAndSendETHTx(toAddress, amountWei);
    } catch (err) {
      return {
        status: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }

    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 5 * 60 * 1_000,
      });

      if (receipt.status === 'reverted') {
        return {
          status: 'failed',
          txHash,
          gasUsed: receipt.gasUsed,
          error: new Error('transaction reverted'),
        };
      }

      return {
        status: 'success',
        txHash,
        gasUsed: receipt.gasUsed,
      };
    } catch (err) {
      return {
        status: 'pending',
        txHash,
        error:
          err instanceof Error
            ? new Error(`transaction sent but receipt not confirmed: ${err.message}`)
            : new Error('transaction sent but receipt not confirmed'),
      };
    }
  }

  /**
   * Builds and sends a native ETH transfer transaction.
   * Nonce-locked critical section.
   */
  private async buildAndSendETHTx(
    toAddress: string,
    amountWei: bigint,
  ): Promise<Hex> {
    const release = await this.nonceMu.acquire();
    try {
      const to = toAddress as Address;

      const nonce = await this.publicClient.getTransactionCount({
        address: this.fromAddress,
        blockTag: 'pending',
      });

      const gasTipCap = await this.publicClient.estimateMaxPriorityFeePerGas();

      const block = await this.publicClient.getBlock({ blockTag: 'latest' });
      if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
        throw new Error('failed to get block base fee');
      }
      const baseFee = block.baseFeePerGas;
      const gasFeeCap = baseFee * 2n + gasTipCap;

      const txHash = await this.walletClient.sendTransaction({
        to,
        value: amountWei,
        gas: ETH_TRANSFER_GAS_LIMIT,
        maxFeePerGas: gasFeeCap,
        maxPriorityFeePerGas: gasTipCap,
        nonce,
        chain: null,
      });

      return txHash;
    } finally {
      release();
    }
  }

  // -----------------------------------------------------------------------
  // checkTransactionStatus
  // -----------------------------------------------------------------------

  /**
   * Checks if a transaction has been mined and returns its status.
   * @returns { success, mined } — if mined is false, the transaction is still pending
   */
  async checkTransactionStatus(
    txHashHex: string,
  ): Promise<{ success: boolean; mined: boolean }> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHashHex as Hex,
      });
      return { success: receipt.status === 'success', mined: true };
    } catch {
      // Transaction not yet mined
      return { success: false, mined: false };
    }
  }

  // -----------------------------------------------------------------------
  // Balance queries
  // -----------------------------------------------------------------------

  /** Returns the USDC balance of the refund wallet (atomic units, 6 decimals). */
  async getBalance(): Promise<bigint> {
    const balance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.fromAddress],
    });
    return balance;
  }

  /** Returns the ETH balance of the refund wallet (in wei). */
  async getETHBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.fromAddress });
  }

  /** Returns the USDC balance of an arbitrary address (atomic units, 6 decimals). */
  async getBalanceOf(addr: Address): Promise<bigint> {
    const balance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [addr],
    });
    return balance;
  }

  /** Returns the ETH balance of an arbitrary address (in wei). */
  async getETHBalanceOf(addr: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address: addr });
  }

  // -----------------------------------------------------------------------
  // Gas estimation
  // -----------------------------------------------------------------------

  /**
   * Estimates the gas cost for a refund in USD (atomic USDC, 6 decimals).
   * This is a rough estimate based on current gas prices.
   * @param ethPriceUSD - Current ETH price in USD (e.g. 3500.0)
   */
  async estimateGasCost(ethPriceUSD: number): Promise<bigint> {
    const gasPrice = await this.publicClient.getGasPrice();

    // ERC20 transfer typically uses ~65000 gas
    const gasLimit = 65_000n;
    const gasCostWei = gasPrice * gasLimit;

    // Convert wei to ETH (floating point)
    const gasCostETH = Number(gasCostWei) / 1e18;

    // Convert ETH to USD, then to atomic USDC (6 decimals)
    const gasCostUSD = gasCostETH * ethPriceUSD;
    return BigInt(Math.floor(gasCostUSD * 1e6));
  }

  // -----------------------------------------------------------------------
  // Receipt checking (for recovery of unconfirmed refunds)
  // -----------------------------------------------------------------------

  /**
   * Check the on-chain receipt for a transaction hash.
   * Returns { confirmed, failed, gasUsed } based on the receipt status.
   * Throws if the receipt cannot be fetched (e.g., network error).
   */
  async checkReceipt(txHash: string): Promise<{
    confirmed: boolean;
    failed: boolean;
    gasUsed?: bigint;
  }> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHash as Hex,
      });
      return {
        confirmed: receipt.status === 'success',
        failed: receipt.status === 'reverted',
        gasUsed: receipt.gasUsed,
      };
    } catch (err) {
      // Transaction receipt not found -- tx may still be pending
      if (err instanceof Error && err.message.includes('could not be found')) {
        return { confirmed: false, failed: false };
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Closes the service. No-op for viem HTTP transport (stateless). */
  close(): void {
    // viem's HTTP transport is stateless — no connection to tear down.
    // This method exists for interface parity with the Go implementation.
  }
}
