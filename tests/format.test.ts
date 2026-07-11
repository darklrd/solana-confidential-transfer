// Pure unit tests — no network.
import { describe, expect, it } from 'vitest';
import { formatAmount } from '../src/inspector/decodeAccount';

describe('formatAmount', () => {
  it('renders whole token amounts', () => {
    expect(formatAmount(0n, 9)).toBe('0');
    expect(formatAmount(1_000_000_000n, 9)).toBe('1');
    expect(formatAmount(1_000_000_000_000n, 9)).toBe('1000');
  });

  it('renders fractional amounts with trailing zeros trimmed', () => {
    expect(formatAmount(1_500_000_000n, 9)).toBe('1.5');
    expect(formatAmount(1_234_567_890n, 9)).toBe('1.23456789');
  });

  it('renders sub-unit amounts', () => {
    expect(formatAmount(1n, 9)).toBe('0.000000001');
  });

  it('handles zero decimals', () => {
    expect(formatAmount(123n, 0)).toBe('123');
  });
});
