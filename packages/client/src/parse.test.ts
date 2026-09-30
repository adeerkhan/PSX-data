/**
 * Unit tests for numeric parsing.
 *
 * This module encodes the library's central data rule: **absence is `null`,
 * never `0` and never `NaN`**. A sign bug here once caused 17 of 48 symbols on
 * the market-summary page to report `change: null`, silently presenting decliners
 * as unchanged. These tests are the guard against that class of error.
 */

import { describe, expect, it } from 'vitest';

import {
  epochSecondsToIso,
  parseInteger,
  parseList,
  parseNumber,
  parsePktTimestamp,
  parsePercent,
  parsePrice,
  parseSignedPrice,
  parseVolume,
} from './parse.js';

describe('parseNumber', () => {
  it('parses plain and formatted numbers', () => {
    expect(parseNumber('123')).toBe(123);
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('-0.13')).toBe(-0.13);
    expect(parseNumber('73,446,994')).toBe(73_446_994);
    expect(parseNumber('20,191,629,499')).toBe(20_191_629_499);
    expect(parseNumber('1.234,56'.replace('1.234,56', '1234.56'))).toBe(1234.56);
  });

  it('strips a percent sign without rescaling', () => {
    // PSX publishes whole-number percentages; callers divide by 100 if they
    // want a fraction. Rescaling here would silently double the value.
    expect(parseNumber('0.76%')).toBe(0.76);
    expect(parseNumber('-2.42%')).toBe(-2.42);
  });

  it('treats accounting parentheses as negative', () => {
    expect(parseNumber('(0.22)')).toBe(-0.22);
    expect(parseNumber('(1,234.50)')).toBe(-1234.5);
  });

  it('returns null for every absence token', () => {
    for (const token of ['', '  ', '-', '--', 'N/A', 'n/a', 'null', 'NULL', 'nil', 'None', 'No Data found!', 'no data']) {
      expect(parseNumber(token), `"${token}" should parse to null`).toBeNull();
    }
  });

  it('returns null rather than NaN for garbage', () => {
    for (const token of ['abc', '1.2.3.4', '--x--', 'e', 'NaN', 'Infinity']) {
      const value = parseNumber(token);
      expect(value, `"${token}" must not be NaN`).not.toBeNaN();
      expect(value === null || typeof value === 'number').toBe(true);
    }
  });

  it('never returns NaN for any input', () => {
    const inputs = ['', '-', 'abc', '0.76%', '(1.5)', '73,446,994', '1e5', 'x', '--'];
    for (const input of inputs) {
      expect(Number.isNaN(parseNumber(input) ?? 0), `${input} became NaN`).toBe(false);
    }
  });

  it('normalises negative zero to zero', () => {
    // `-0` and `0` must compare equal, or sort/filter behaviour diverges.
    expect(Object.is(parseNumber('-0'), 0)).toBe(true);
  });

  it('passes through numbers and rejects non-finite ones', () => {
    expect(parseNumber(42)).toBe(42);
    expect(parseNumber(0)).toBe(0);
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('parsePrice', () => {
  it('accepts plausible prices', () => {
    expect(parsePrice('25.63')).toBe(25.63);
    expect(parsePrice('1,600.74')).toBe(1600.74);
    expect(parsePrice('0')).toBe(0);
  });

  it('rejects negatives, because a PSX price is never negative', () => {
    expect(parsePrice('-0.13')).toBeNull();
    expect(parsePrice('-100')).toBeNull();
  });

  it('rejects implausible magnitudes as a column-mixup guard', () => {
    // A volume landing in a price field is the realistic failure.
    expect(parsePrice('73,446,994')).toBeNull();
    expect(parsePrice('99999999999')).toBeNull();
  });
});

describe('parseSignedPrice', () => {
  it('accepts negatives, unlike parsePrice', () => {
    // The regression guard: change fields are legitimately negative, and
    // parsePrice rejects them.
    expect(parseSignedPrice('-0.13')).toBe(-0.13);
    expect(parseSignedPrice('-2.42')).toBe(-2.42);
    expect(parseSignedPrice('368.92')).toBe(368.92);
    expect(parseSignedPrice('0.76%')).toBe(0.76);
  });

  it('still rejects absurd magnitudes', () => {
    expect(parseSignedPrice('99999999999999')).toBeNull();
  });

  it('returns null for absence', () => {
    expect(parseSignedPrice('No Data found!')).toBeNull();
  });
});

describe('parseInteger / parseVolume', () => {
  it('parses counts with separators', () => {
    expect(parseInteger('295,473')).toBe(295_473);
    expect(parseInteger('569')).toBe(569);
    expect(parseInteger('22,333')).toBe(22_333);
  });

  it('keeps a genuine zero distinct from absence', () => {
    // "Did not trade" is real data; "unknown" is not. Collapsing them loses
    // information a screener may need.
    expect(parseVolume('0')).toBe(0);
    expect(parseVolume('No Data found!')).toBeNull();
  });

  it('rejects negatives for volume', () => {
    expect(parseVolume('-5')).toBeNull();
  });

  it('rounds fractional volumes rather than dropping them', () => {
    expect(parseVolume('100.7')).toBe(101);
  });
});

describe('parsePercent', () => {
  it('preserves magnitude, without rescaling to a fraction', () => {
    expect(parsePercent('0.76%')).toBe(0.76);
    expect(parsePercent('-2.42%')).toBe(-2.42);
  });
});

describe('parseList', () => {
  it('splits comma-separated index memberships', () => {
    expect(parseList('ALLSHR,KMIALLSHR,KSE100,KSE100PR')).toEqual([
      'ALLSHR',
      'KMIALLSHR',
      'KSE100',
      'KSE100PR',
    ]);
  });

  it('returns an empty array for absence, not null', () => {
    // "Published nothing" is meaningfully different from "published one thing".
    expect(parseList('')).toEqual([]);
    expect(parseList(null)).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList('No Data found!')).toEqual([]);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(parseList(' A , B ,, C ')).toEqual(['A', 'B', 'C']);
  });

  it('accepts alternate separators', () => {
    expect(parseList('A;B')).toEqual(['A', 'B']);
    expect(parseList('A|B')).toEqual(['A', 'B']);
  });
});

describe('epochSecondsToIso', () => {
  it('converts epoch seconds to ISO UTC', () => {
    expect(epochSecondsToIso(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(epochSecondsToIso(1790766000)).toBe('2026-09-30T11:00:00.000Z');
  });

  it('returns null for non-finite input', () => {
    expect(epochSecondsToIso(Number.NaN)).toBeNull();
    expect(epochSecondsToIso(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('parsePktTimestamp', () => {
  it('treats exchange-local time as PKT (UTC+5)', () => {
    expect(parsePktTimestamp('2026-09-30 21:49:01')).toBe('2026-09-30T16:49:01.000Z');
  });

  it('applies exactly a five-hour offset, not four or six', () => {
    const parsed = parsePktTimestamp('2026-01-01 12:00:00');
    expect(parsed).toBe('2026-01-01T07:00:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    expect(parsePktTimestamp('not a date')).toBeNull();
    expect(parsePktTimestamp(null)).toBeNull();
    expect(parsePktTimestamp('')).toBeNull();
  });
});
