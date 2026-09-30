/**
 * Transport tests.
 *
 * Uses a stub `fetch` so no test touches the network. The gate logic is the
 * trickiest code in the package -- three required headers plus key rotation --
 * and it is exactly the code a live-only test would never pin down.
 */

import { describe, expect, it } from 'vitest';

import { createTransport } from './transport.js';
import { PsxAuthError, PsxConfigError, PsxNotFoundError, PsxRateLimitError, PsxTimeoutError } from './errors.js';

const KEY_A = 'keyaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'keybbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Build a stub fetch returning scripted responses, recording every request. */
function stubFetch(responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;

  const fn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url: String(url), headers });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec == null) throw new Error('stub exhausted');
    return new Response(spec.body ?? '', {
      status: spec.status ?? 200,
      headers: spec.headers ?? {},
    });
  }) as unknown as typeof globalThis.fetch;

  return { fn, calls };
}

describe('gate headers', () => {
  it('discovers the key from window.__ps and sends all three required headers', async () => {
    const { fn, calls } = stubFetch([
      { body: `<script>window.__ps = {"lc":"en","tz":"Asia/Karachi","_k":"${KEY_A}","rv":"1"};</script>` },
      { body: 'OK' },
    ]);

    const transport = createTransport({ fetch: fn });
    await transport.fetchGated('/market-watch');

    const gated = calls[1];
    expect(gated?.headers['X-Req-Id']).toBe(KEY_A);
    expect(gated?.headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(gated?.headers['User-Agent']).toContain('Chrome');
    // Referer must be same-origin if sent at all -- a foreign one gets 403.
    expect(gated?.headers['Referer']).toBe('https://dps.psx.com.pk/');
  });

  it('does not re-discover the key on a second request', async () => {
    const { fn, calls } = stubFetch([
      { body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` },
      { body: 'OK' },
      { body: 'OK' },
    ]);

    const transport = createTransport({ fetch: fn });
    await transport.fetchGated('/a');
    await transport.fetchGated('/b');

    expect(calls.length).toBe(3); // 1 discovery + 2 requests
    expect(calls[1]?.headers['X-Req-Id']).toBe(KEY_A);
    expect(calls[2]?.headers['X-Req-Id']).toBe(KEY_A);
  });

  it('refreshes the key once on 403, then retries', async () => {
    const { fn, calls } = stubFetch([
      { body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` },
      { status: 403 }, // rejected
      { body: `<script>window.__ps = {"_k":"${KEY_B}"};</script>` }, // rediscovery
      { body: 'OK' },
    ]);

    const transport = createTransport({ fetch: fn });
    const body = await transport.fetchGated('/market-watch');

    expect(body).toBe('OK');
    // Retried with a different key.
    expect(calls[1]?.headers['X-Req-Id']).toBe(KEY_A);
    expect(calls[3]?.headers['X-Req-Id']).toBe(KEY_B);
    expect(transport.keyRefreshCount).toBe(1);
  });

  it('gives up after one refresh rather than hammering PSX', async () => {
    const { fn, calls } = stubFetch([
      { body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` },
      { status: 403 },
      { body: `<script>window.__ps = {"_k":"${KEY_B}"};</script>` },
      { status: 403 },
      { status: 403 }, // no 5th attempt
    ]);

    const transport = createTransport({ fetch: fn });
    await expect(transport.fetchGated('/market-watch')).rejects.toBeInstanceOf(PsxAuthError);
    // 1 discovery + 1 attempt + 1 rediscovery + 1 attempt = 4. Not 5.
    expect(calls.length).toBe(4);
  });

  it('throws PsxAuthError when the key blob is missing', async () => {
    const { fn } = stubFetch([{ body: '<html>markup changed</html>' }]);
    const transport = createTransport({ fetch: fn });
    await expect(transport.fetchGated('/x')).rejects.toThrow(PsxAuthError);
  });

  it('accepts a caller-supplied key and skips discovery', async () => {
    const { fn, calls } = stubFetch([{ body: 'OK' }]);
    const transport = createTransport({ fetch: fn, key: KEY_A });
    await transport.fetchGated('/x');
    expect(calls.length).toBe(1);
    expect(calls[0]?.headers['X-Req-Id']).toBe(KEY_A);
  });
});

describe('error mapping', () => {
  it('maps 403 to PsxAuthError', async () => {
    const { fn } = stubFetch([{ body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` }, { status: 403 }]);
    const transport = createTransport({ fetch: fn, key: undefined });
    await expect(transport.fetchGated('/x')).rejects.toBeInstanceOf(PsxAuthError);
  });

  it('maps 404 to PsxNotFoundError', async () => {
    const { fn } = stubFetch([{ body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` }, { status: 404 }]);
    const transport = createTransport({ fetch: fn });
    await expect(transport.fetchGated('/nope')).rejects.toBeInstanceOf(PsxNotFoundError);
  });

  it('maps 429 to PsxRateLimitError and keeps Retry-After', async () => {
    const { fn } = stubFetch([
      { body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` },
      { status: 429, headers: { 'retry-after': '30' } },
    ]);
    const transport = createTransport({ fetch: fn });
    try {
      await transport.fetchGated('/x');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PsxRateLimitError);
      expect((error as PsxRateLimitError).retryAfter).toBe(30);
    }
  });

  it('maps 500 to PsxNetworkError, matching real PSX behaviour', async () => {
    // PSX answers an unknown ticker with 500, not 404. Verified live.
    const { fn } = stubFetch([
      { body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` },
      { status: 500 },
    ]);
    const transport = createTransport({ fetch: fn });
    await expect(transport.fetchGated('/company/NOPE')).rejects.toBeInstanceOf(Error);
  });

  it('maps a platform timeout to PsxTimeoutError', async () => {
    const fn = (async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const transport = createTransport({ fetch: fn, key: KEY_A });
    await expect(transport.fetchGated('/x')).rejects.toBeInstanceOf(PsxTimeoutError);
  });

  it('maps a socket failure to PsxNetworkError', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const transport = createTransport({ fetch: fn, key: KEY_A });
    await expect(transport.fetchGated('/x')).rejects.toBeInstanceOf(Error);
  });
});

describe('ungated source', () => {
  it('sends no gate headers to www', async () => {
    const { fn, calls } = stubFetch([{ body: '<html>market summary</html>' }]);
    const transport = createTransport({ fetch: fn });
    const body = await transport.fetchUngated();

    expect(body).toContain('market summary');
    expect(calls[0]?.url).toBe('https://www.psx.com.pk/market-summary/');
    expect(calls[0]?.headers['X-Req-Id']).toBeUndefined();
    expect(calls[0]?.headers['X-Requested-With']).toBeUndefined();
  });

  it('refuses fetchGated in ungatedOnly mode', async () => {
    const { fn } = stubFetch([{ body: 'x' }]);
    const transport = createTransport({ fetch: fn, ungatedOnly: true });
    await expect(transport.fetchGated('/x')).rejects.toBeInstanceOf(PsxConfigError);
  });
});

describe('diagnostics accessors', () => {
  it('reports no key before discovery', () => {
    const { fn } = stubFetch([{ body: 'x' }]);
    const transport = createTransport({ fetch: fn });
    expect(transport.hasKey).toBe(false);
    expect(transport.keyAgeMs).toBeNull();
    expect(transport.keyAcquiredAt).toBeNull();
  });

  it('reports key age once held', async () => {
    const { fn } = stubFetch([{ body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` }, { body: 'OK' }]);
    const transport = createTransport({ fetch: fn });
    await transport.fetchGated('/x');
    expect(transport.hasKey).toBe(true);
    expect(transport.keyAgeMs).not.toBeNull();
    expect(transport.keyAcquiredAt).toBeInstanceOf(Date);
  });

  it('invalidateKey forces rediscovery', async () => {
    const { fn } = stubFetch([{ body: `<script>window.__ps = {"_k":"${KEY_A}"};</script>` }, { body: 'OK' }]);
    const transport = createTransport({ fetch: fn });
    await transport.fetchGated('/x');
    transport.invalidateKey();
    expect(transport.hasKey).toBe(false);
  });
});
