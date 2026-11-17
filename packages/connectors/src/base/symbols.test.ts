import { describe, expect, it } from 'vitest';
import { num, putNumbers, splitBase } from './symbols.js';

describe('splitBase', () => {
  it.each([
    ['BTC', 'BTC', 1],
    ['1000PEPE', 'PEPE', 1000],
    ['10000SATS', 'SATS', 10_000],
    ['1000000BABYDOGE', 'BABYDOGE', 1_000_000],
    ['1000000MOG', 'MOG', 1_000_000],
    ['1MBABYDOGE', 'BABYDOGE', 1_000_000],
    ['kPEPE', 'PEPE', 1000],
    ['kSHIB', 'SHIB', 1000],
    // real assets that only start with a digit or "k"
    ['1INCH', '1INCH', 1],
    ['0G', '0G', 1],
    ['2Z', '2Z', 1],
    ['4', '4', 1],
    ['KAVA', 'KAVA', 1],
    ['KAITO', 'KAITO', 1],
    ['1000X', '1000X', 1],
  ])('%s -> %s x%d', (base, asset, multiplier) => {
    expect(splitBase(base)).toEqual({ asset, multiplier });
  });
});

describe('num / putNumbers', () => {
  it('parses exchange strings and rejects missing or invalid input', () => {
    expect(num('64804.30')).toBe(64804.3);
    expect(num('-0.00002486')).toBe(-0.00002486);
    expect(num(5)).toBe(5);
    expect(num('')).toBeUndefined();
    expect(num(null)).toBeUndefined();
    expect(num(undefined)).toBeUndefined();
    expect(num('abc')).toBeUndefined();
    expect(num(Number.NaN)).toBeUndefined();
    expect(num('Infinity')).toBeUndefined();
  });

  it('copies only present numbers', () => {
    expect(
      putNumbers({}, [
        ['a', '1'],
        ['b', ''],
        ['c', undefined],
        ['d', 0],
      ]),
    ).toEqual({ a: 1, d: 0 });
  });
});
