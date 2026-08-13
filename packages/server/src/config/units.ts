import { z } from 'zod';

/**
 * Strict parsers for the human-readable units used by the monitoring config.
 *
 * Every parser refuses anything it cannot read unambiguously — a threshold that
 * silently means something other than what was written is worse than a config
 * error at startup. In particular a bare number is rejected wherever a unit
 * carries meaning (`2` is not a size), so nobody has to remember whether the
 * file wanted bytes, kilobytes or mebibytes.
 */

/** `500ms`, `30s`, `5m`, `2h`, and compound forms like `1m30s`. */
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseDuration(input: string): number {
  const text = input.trim();
  if (text === '') throw new Error('empty duration');

  // A fresh regex per call: a shared /g/ one carries lastIndex between calls.
  const part = /(\d+(?:\.\d+)?)(ms|s|m|h)/gi;
  let consumed = 0;
  let total = 0;
  let previousUnit = Number.POSITIVE_INFINITY;

  for (let match = part.exec(text); match; match = part.exec(text)) {
    // Enforce a single contiguous run of parts: `1m 30s x` must not parse.
    if (match.index !== consumed) break;
    consumed = match.index + match[0].length;
    const factor = DURATION_UNITS[(match[2] ?? '').toLowerCase()];
    if (factor === undefined) break;
    // Descending units only, so `30s1m` (ambiguous ordering) is an error.
    if (factor >= previousUnit) {
      throw new Error(`invalid duration "${input}": units must be in descending order (e.g. 1m30s)`);
    }
    previousUnit = factor;
    total += Number(match[1]) * factor;
  }

  if (consumed !== text.length || total <= 0) {
    throw new Error(`invalid duration "${input}": expected a value with a unit, e.g. 500ms, 30s, 5m, 2h`);
  }
  return Math.round(total);
}

/**
 * `512B`, `2GiB`, `500MB`. An `i` in the unit means binary (1024), otherwise the
 * SI prefix is decimal (1000) — the same convention `ls -h` and Docker use.
 */
const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*(B|[KMGTP]i?B)$/i;

export function parseBytes(input: string): number {
  const text = input.trim();
  const match = SIZE_PATTERN.exec(text);
  if (!match) {
    throw new Error(`invalid size "${input}": expected a value with a unit, e.g. 512B, 256MiB, 2GiB, 500MB`);
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toUpperCase();
  if (unit === 'B') return Math.round(value);

  const binary = unit.includes('I');
  const exponent = 'KMGTP'.indexOf(unit.slice(0, 1)) + 1;
  const base = binary ? 1024 : 1000;
  const bytes = value * base ** exponent;
  if (!Number.isFinite(bytes)) throw new Error(`invalid size "${input}": value out of range`);
  return Math.round(bytes);
}

/** `50MiB/s`. The `/s` is mandatory — a rate is not a size. */
export function parseRate(input: string): number {
  const text = input.trim();
  const match = /^(.*?)\s*\/\s*s(?:ec|econd)?$/i.exec(text);
  if (!match || match[1] === undefined) {
    throw new Error(`invalid rate "${input}": expected a size per second, e.g. 50MiB/s`);
  }
  try {
    return parseBytes(match[1]);
  } catch {
    throw new Error(`invalid rate "${input}": expected a size per second, e.g. 50MiB/s`);
  }
}

/**
 * `150%` or a bare number meaning percent. 100 % is one fully busy core, so
 * values above 100 are normal and deliberately allowed.
 */
export function parsePercent(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid percentage "${input}": must be >= 0`);
    return input;
  }
  const text = input.trim();
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (!match) throw new Error(`invalid percentage "${input}": expected a value like 150%`);
  return Number(match[1]);
}

/** A plain ratio between 0 and 1, used for the hysteresis factor. */
export function parseRatio(input: number): number {
  if (!Number.isFinite(input) || input <= 0 || input > 1) {
    throw new Error(`invalid ratio "${input}": must be > 0 and <= 1`);
  }
  return input;
}

/** Wraps a parser as a zod transform that reports the parser's own message. */
function parsed<In, Out>(schema: z.ZodType<In, z.ZodTypeDef, unknown>, parse: (value: In) => Out): z.ZodType<Out, z.ZodTypeDef, unknown> {
  return schema.transform((value, context) => {
    try {
      return parse(value);
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  });
}

export const durationSchema = parsed(z.string(), parseDuration);
export const bytesSchema = parsed(z.string(), parseBytes);
export const rateSchema = parsed(z.string(), parseRate);
export const percentSchema = parsed(z.union([z.string(), z.number()]), parsePercent);
export const ratioSchema = parsed(z.number(), parseRatio);
