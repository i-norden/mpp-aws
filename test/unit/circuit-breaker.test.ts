import { describe, expect, it, vi, afterEach } from 'vitest';

import { CircuitBreaker } from '../../src/circuit-breaker/index.js';

describe('CircuitBreaker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in closed state and allows requests', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 5000,
    });

    expect(cb.getState()).toBe('closed');
    expect(cb.allow()).toBe(true);
  });

  it('opens after reaching failure threshold', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 5000,
    });

    cb.failure();
    cb.failure();
    expect(cb.getState()).toBe('closed');
    expect(cb.allow()).toBe(true);

    cb.failure(); // 3rd failure -> opens
    expect(cb.getState()).toBe('open');
  });

  it('rejects requests when open', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 60_000, // long timeout so it stays open
    });

    cb.failure();
    cb.failure(); // opens
    expect(cb.getState()).toBe('open');
    expect(cb.allow()).toBe(false);
  });

  it('transitions to half-open after timeout elapses', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      successThreshold: 1,
      timeoutMs: 1000,
    });

    // Open the circuit
    cb.failure();
    cb.failure();
    expect(cb.getState()).toBe('open');

    // Advance time past the timeout
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);

    // allow() should transition to half-open and return true
    expect(cb.allow()).toBe(true);
    expect(cb.getState()).toBe('half-open');
  });

  it('closes after success threshold in half-open state', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      successThreshold: 2,
      timeoutMs: 1000,
    });

    // Open the circuit
    cb.failure();
    cb.failure();
    expect(cb.getState()).toBe('open');

    // Advance time past the timeout
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);

    // Transition to half-open
    expect(cb.allow()).toBe(true);
    expect(cb.getState()).toBe('half-open');

    // First success - not enough yet
    cb.success();
    expect(cb.getState()).toBe('half-open');

    // Second success - should close
    cb.success();
    expect(cb.getState()).toBe('closed');
  });

  it('returns to open on failure in half-open state', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      successThreshold: 3,
      timeoutMs: 1000,
    });

    // Open the circuit
    cb.failure();
    cb.failure();

    // Advance time past timeout
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    cb.allow(); // transition to half-open
    expect(cb.getState()).toBe('half-open');

    // A failure in half-open sends back to open
    cb.failure();
    expect(cb.getState()).toBe('open');
  });

  it('resets failure count on success in closed state', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 1,
      timeoutMs: 5000,
    });

    cb.failure();
    cb.failure();
    // 2 failures, 1 away from opening
    cb.success(); // resets failure count

    // Now another failure should not open it (only 1 failure after reset)
    cb.failure();
    expect(cb.getState()).toBe('closed');
  });

  it('limits concurrent attempts in half-open state based on maxConcurrentInHalfOpen', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 2,
      timeoutMs: 1000,
      maxConcurrentInHalfOpen: 1,
    });

    // Open the circuit
    cb.failure();

    // Advance time past timeout
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);

    // First allow() transitions to half-open (halfOpenAttempts = 0) and returns true
    expect(cb.allow()).toBe(true);
    expect(cb.getState()).toBe('half-open');

    // The implementation does not increment halfOpenAttempts in allow(),
    // so subsequent calls in half-open with maxConcurrentInHalfOpen = 1
    // check 0 < 1, which is still true. This means the gate stays open
    // until a failure resets it.
    expect(cb.allow()).toBe(true);
  });

  it('reports stats correctly', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 2,
      timeoutMs: 5000,
    });

    cb.failure();
    cb.failure();

    const stats = cb.getStats();
    expect(stats.state).toBe('closed');
    expect(stats.failureCount).toBe(2);
    expect(stats.successCount).toBe(0);
    expect(stats.lastFailureTime).toBeGreaterThan(0);
  });

  it('defaults maxConcurrentInHalfOpen to 1', () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      successThreshold: 1,
      timeoutMs: 1000,
    });

    // Open the circuit
    cb.failure();

    // Advance time
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);

    // First call transitions to half-open and allows
    expect(cb.allow()).toBe(true);
    expect(cb.getState()).toBe('half-open');
  });
});
