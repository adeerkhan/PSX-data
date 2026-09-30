/**
 * Error taxonomy.
 *
 * The distinction between PSX's failure modes is genuinely diagnostic and we
 * preserve it rather than collapsing everything into one "request failed":
 *
 * - **403** -- the request reached PSX and was *rejected*: a stale or wrong
 *   `X-Req-Id`, or an `Origin` header that is not `https://dps.psx.com.pk`.
 *   Retrying the same request cannot help; the key must be refreshed.
 * - **404** -- PSX did not recognise the request shape: a missing
 *   `X-Requested-With` header, or a genuinely absent path. Retrying with the
 *   header set may help.
 * - **429** -- rate limited. Back off and retry.
 *
 * Collapsing these would cost us the ability to tell "our key went stale" from
 * "we forgot a header" -- both of which produce an unhelpful generic error
 * when merged.
 */

import type { Timestamp } from './types.js';

/**
 * Discriminator carried by every error this library throws.
 *
 * Deliberately short: only the codes something actually raises are listed. An
 * earlier revision enumerated AUTH/NOT_FOUND/RATE_LIMITED/TIMEOUT/NETWORK/CONFIG/
 * ABORTED for HTTP conditions -- but no code existed to throw them, so the list
 * documented intent rather than behaviour. Re-add entries at the point of use.
 */
export type PsxErrorCode = 'SCHEMA' | 'PARSE';

/** Base class for every error raised by this library. */
export class PsxError extends Error {
  readonly code: PsxErrorCode;
  /** The request URL that failed, when known. */
  readonly url: string | null;
  /** Underlying cause, when this wraps a lower-level failure. */
  override readonly cause: unknown;

  constructor(
    code: PsxErrorCode,
    message: string,
    options: { url?: string | null; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.url = options.url ?? null;
    this.cause = options.cause;
    // Restore the prototype chain: required for `instanceof` to work when the
    // output is transpiled down to ES5-style constructors.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** True for any error raised by this library. */
export function isPsxError(value: unknown): value is PsxError {
  return value instanceof PsxError;
}
/**
 * The response parsed as well-formed HTML/JSON but did not match the shape we
 * expect -- PSX changed its markup.
 *
 * `detail` names the exact selector or header that failed to match, because
 * "parse error" is unactionable. This is the error that catches PSX's August
 * 2022 `TIME` -> `Date` rename, which silently broke a Python reference
 * implementation for four years.
 */
export class PsxSchemaError extends PsxError {
  override readonly code = 'SCHEMA' as const;
  /** The selector or header that failed to match. */
  readonly detail: string;
  /** Selector manifest version in force, so reports are attributable. */
  readonly selectorVersion: string;
  /** What we found, when diagnostic. */
  readonly actual: string | null;

  constructor(
    detail: string,
    options: {
      url?: string | null;
      selectorVersion: string;
      actual?: string | null;
      cause?: unknown;
    },
  ) {
    super(
      'SCHEMA',
      `PSX response did not match expected structure (selectors ${options.selectorVersion}): ${detail}`,
      options,
    );
    this.detail = detail;
    this.selectorVersion = options.selectorVersion;
    this.actual = options.actual ?? null;
  }
}

/** A value could not be parsed out of upstream text, or the body was not JSON. */
export class PsxParseError extends PsxError {
  override readonly code = 'PARSE' as const;
  /** The raw text that failed to parse, truncated. */
  readonly raw: string;

  constructor(message: string, raw: string, options: { url?: string | null; cause?: unknown } = {}) {
    super('PARSE', message, options);
    this.raw = raw.slice(0, 200);
  }
}