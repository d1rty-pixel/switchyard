import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseBytes,
  parseDuration,
  parsePercent,
  parseRate,
  parseRatio,
} from '../src/config/units.js';

describe('parseDuration', () => {
  it('parses single units', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('5m'), 300_000);
    assert.equal(parseDuration('2h'), 7_200_000);
  });

  it('parses compound durations in descending order', () => {
    assert.equal(parseDuration('1m30s'), 90_000);
    assert.equal(parseDuration('1h5m'), 3_900_000);
  });

  it('accepts surrounding whitespace and mixed case', () => {
    assert.equal(parseDuration('  45S '), 45_000);
  });

  it('rejects ambiguous or unitless input', () => {
    for (const input of ['', '30', '30x', 's', '1m 30s', '30s1m', 'abc', '0s', '-5s', '5m30']) {
      assert.throws(() => parseDuration(input), /invalid duration|empty duration/, `should reject ${input}`);
    }
  });
});

describe('parseBytes', () => {
  it('parses binary and decimal units', () => {
    assert.equal(parseBytes('512B'), 512);
    assert.equal(parseBytes('1KiB'), 1024);
    assert.equal(parseBytes('2GiB'), 2 * 1024 ** 3);
    assert.equal(parseBytes('500MB'), 500_000_000);
    assert.equal(parseBytes('1.5GiB'), Math.round(1.5 * 1024 ** 3));
  });

  it('parses the shapes docker stats emits', () => {
    assert.equal(parseBytes('213.6MiB'), Math.round(213.6 * 1024 ** 2));
    assert.equal(parseBytes('49.2kB'), 49_200);
    assert.equal(parseBytes('0B'), 0);
  });

  it('rejects a bare number, so nobody has to guess the unit', () => {
    assert.throws(() => parseBytes('2048'), /invalid size/);
  });

  it('rejects unknown units', () => {
    for (const input of ['2Gigs', '5', '', 'MiB', '2 Mi', '2GiB/s']) {
      assert.throws(() => parseBytes(input), /invalid size/, `should reject ${input}`);
    }
  });
});

describe('parseRate', () => {
  it('requires an explicit per-second suffix', () => {
    assert.equal(parseRate('50MiB/s'), 50 * 1024 ** 2);
    assert.equal(parseRate('1MB / s'), 1_000_000);
    assert.throws(() => parseRate('50MiB'), /invalid rate/);
    assert.throws(() => parseRate('50/s'), /invalid rate/);
  });
});

describe('parsePercent', () => {
  it('accepts percentages above 100, since 100% is one core', () => {
    assert.equal(parsePercent('400%'), 400);
    assert.equal(parsePercent('12.5%'), 12.5);
    assert.equal(parsePercent(150), 150);
  });

  it('rejects malformed values', () => {
    for (const input of ['150', 'abc', '%', '-5%']) {
      assert.throws(() => parsePercent(input), /invalid percentage/, `should reject ${input}`);
    }
    assert.throws(() => parsePercent(-1), /invalid percentage/);
  });
});

describe('parseRatio', () => {
  it('accepts 0 < value <= 1', () => {
    assert.equal(parseRatio(0.9), 0.9);
    assert.equal(parseRatio(1), 1);
    assert.throws(() => parseRatio(0), /invalid ratio/);
    assert.throws(() => parseRatio(1.5), /invalid ratio/);
  });
});
