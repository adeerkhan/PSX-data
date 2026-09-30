/**
 * Minimal HTTP transport.
 *
 * Everything here exists because PSX gates `dps.psx.com.pk` behind three
 * requirements, all verified against live responses:
 *
 *   1. `X-Req-Id` -- a value inlined in every page as `window.__ps._k`.
 *      **This rotates.** Two fetches an hour apart on 2026-09-30 produced
 *      different values, so it is fetched lazily and refreshed on 403 rather
 *      than cached as a constant.
 *   2. `X-Requested-With: XMLHttpRequest` -- omit it and PSX returns 403 with
 *      an empty body.
 *   3. A browser `User-Agent` -- `python-requests`, `curl`, `node-fetch` and
 *      Node's default `undici` UA all get 404.
 *
 * Plus: sending an `Origin` other than `https://dps.psx.com.pk` gets 403.
 * Omitting `Origin` works (undici sends none), which is what makes this usable
 * from Node at all.
 *
 * The ungated source (`www.psx.com.pk/market-summary/`) needs none of this, so
 * it is the fallback when the gate rejects us. A gated failure degrades to it
 * rather than throwing -- one dead endpoint should not cost the caller 589
 * symbols.
 */

import { HOSTS, BROWSER_UA } from './selectors.js';
import {
  PsxAuthError,
  PsxNetworkError,
  PsxNotFoundError,
  PsxRateLimitError,
  PsxTimeoutError,
  PsxAbortError,
  PsxConfigError,
} from './errors.js';

/** Default per-request timeout. PSX has no documented latency budget. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** How long a fetched gate key is trusted before being re-fetched. */
const KEY_TTL_MS = 10 * 60_000;

/** Transport options. */
export interface TransportOptions {
  /** Per-request timeout in milliseconds. Default 20000. */
  timeoutMs?: number;
  /**
   * Skip the gate entirely and read only the ungated source.
   *
   * Set when you cannot reach `dps.psx.com.pk` (a network blocking it, or a
   * deployment region PSX rejects). Yields the 589-symbol market-summary page
   * and nothing else.
   */
  ungatedOnly?: boolean;
  /**
   * Supply a gate key you already hold, skipping the discovery request.
   *
   * Useful to avoid one extra round trip per process. Rotates, so prefer
   * letting the client manage it unless you know you are behind a cache.
   */
  key?: string;
  /** Inject a `fetch` implementation. Defaults to the global. */
  fetch?: typeof globalThis.fetch;
}

/** Mutable transport state. Resetting the key forces re-discovery. */
interface State {
  key: string | null;
  keyAt: number;
  refreshes: number;
}

/**
 * Create a PSX transport.
 *
 * @example
 * ```ts
 * const psx = createPsxClient();
 * const html = await psx.fetchGated('/market-watch');
 * ```
 */
export function createTransport(options: TransportOptions = {}): Transport {
  return new Transport(options);
}

/** PSX HTTP transport. Handles the gate, timeouts, and error mapping. */
export class Transport {
  readonly #timeoutMs: number;
  readonly #ungatedOnly: boolean;
  readonly #fetch: typeof globalThis.fetch;
  readonly #state: State;

  constructor(options: TransportOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#ungatedOnly = options.ungatedOnly ?? false;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#state = { key: options.key ?? null, keyAt: options.key ? Date.now() : 0, refreshes: 0 };

    if (this.#fetch == null) {
      throw new PsxConfigError('no global fetch available; pass options.fetch');
    }
  }

  /** Whether the gate key is currently held and unexpired. */
  get hasKey(): boolean {
    return this.#state.key != null && Date.now() - this.#state.keyAt < KEY_TTL_MS;
  }

  /** Forget the gate key, forcing re-discovery on the next gated request. */
  invalidateKey(): void {
    this.#state.key = null;
    this.#state.keyAt = 0;
  }

  /** Age of the held key in milliseconds, or `null` when none is held. */
  get keyAgeMs(): number | null {
    if (this.#state.key == null) return null;
    return Date.now() - this.#state.keyAt;
  }

  /** When the held key was acquired, or `null`. */
  get keyAcquiredAt(): Date | null {
    if (this.#state.key == null) return null;
    return new Date(this.#state.keyAt);
  }

  /** How many times a 403 forced a key refresh. */
  get keyRefreshCount(): number {
    return this.#state.refreshes;
  }

  /** True when this transport refuses the gated source entirely. */
  get ungatedOnly(): boolean {
    return this.#ungatedOnly;
  }

  /**
   * Fetch a gated `dps.psx.com.pk` path with the required headers.
   *
   * @param path - Path beginning with `/`, e.g. `/market-watch`.
   * @param init - Extra init merged over the gate headers.
   * @throws {@link PsxAuthError} on 403 after a key refresh attempt.
   * @throws {@link PsxNotFoundError} on 404 (missing header, or bad path).
   * @throws {@link PsxRateLimitError} on 429.
   * @throws {@link PsxTimeoutError} past the configured timeout.
   */
  async fetchGated(path: string, init: RequestInit = {}): Promise<string> {
    if (this.#ungatedOnly) {
      throw new PsxConfigError(
        'transport is ungatedOnly; fetchGated is unavailable. Use fetchUngated instead.',
      );
    }

    // First attempt with the held key. A 403 means the key was refused, so
    // re-discover once and retry -- if a fresh key is also refused, the cause is
    // not staleness and hammering PSX helps nobody.
    //
    // The 403 must be caught rather than thrown out of `#send`, since `#send`
    // maps statuses to typed errors and would otherwise abort before the retry.
    let response = await this.#send(HOSTS.dps + path, await this.#headers()).catch(
      (error: unknown) => {
        if (error instanceof PsxAuthError) return null;
        throw error;
      },
    );

    if (response == null) {
      this.#state.refreshes += 1;
      this.invalidateKey();
      response = await this.#send(HOSTS.dps + path, await this.#headers(true));
    }

    return response.text;
  }

  /**
   * Fetch the ungated `www.psx.com.pk` market-summary page.
   *
   * No key, no `X-Requested-With`, no spoofed UA. Verified to return
   * 815 KB of server-rendered HTML from a bare `fetch`.
   */
  async fetchUngated(path = '/market-summary/', init: RequestInit = {}): Promise<string> {
    const { text } = await this.#send(HOSTS.www + path, {
      'User-Agent': BROWSER_UA,
      ...toRecord(init.headers),
    });
    return text;
  }

  /** Assemble gate headers, discovering the key if needed. */
  async #headers(forceRefresh = false): Promise<Record<string, string>> {
    if (forceRefresh) this.invalidateKey();

    const key = await this.#ensureKey();

    return {
      'User-Agent': BROWSER_UA,
      'X-Req-Id': key,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${HOSTS.dps}/`,
      Accept: 'application/json, text/html, */*',
    };
  }

  /** Return the held key, fetching a fresh one when absent or stale. */
  async #ensureKey(): Promise<string> {
    if (this.hasKey && this.#state.key != null) {
      return this.#state.key;
    }

    const { text } = await this.#send(`${HOSTS.dps}/`, {
      'User-Agent': BROWSER_UA,
    });

    // The key is inlined in every page; it is not a JSON endpoint.
    const match = /window\.__ps\s*=\s*(\{[^}]+\})/.exec(text);
    const rawBlob = match?.[1];
    if (rawBlob == null) {
      throw new PsxAuthError('no window.__ps blob in dps root; PSX markup changed?', {
        url: `${HOSTS.dps}/`,
      });
    }

    const blob = JSON.parse(rawBlob) as { _k?: unknown };
    if (typeof blob._k !== 'string' || blob._k.length === 0) {
      throw new PsxAuthError('window.__ps._k missing or empty');
    }

    this.#state.key = blob._k;
    this.#state.keyAt = Date.now();
    return blob._k;
  }

  /** Perform one request, mapping transport and HTTP failures to our errors. */
  async #send(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; text: string }> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, { headers, signal: timeout });
    } catch (error) {
      // Node distinguishes abort by error name; anything else is a network fault.
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new PsxTimeoutError(this.#timeoutMs, { url, cause: error });
      }
      throw new PsxNetworkError(
        `request failed: ${error instanceof Error ? error.message : String(error)}`,
        { url, cause: error },
      );
    }

    const text = await response.text();

    switch (response.status) {
      case 403:
        throw new PsxAuthError('PSX rejected the request (stale or refused X-Req-Id)', { url });
      case 404:
        throw new PsxNotFoundError('PSX did not recognise the request (missing header, or bad path)', { url });
      case 429: {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new PsxRateLimitError('PSX rate limit exceeded', {
          url,
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
        });
      }
      default:
        break;
    }

    if (!response.ok) {
      throw new PsxNetworkError(`unexpected HTTP ${response.status}`, { url });
    }

    return { status: response.status, text };
  }
}

/** Normalise a `HeadersInit` to a plain record for header merging. */
function toRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers == null) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (typeof (headers as Headers).forEach === 'function' && !(headers instanceof Object && !('get' in headers))) {
    const out: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return { ...(headers as Record<string, string>) };
}
