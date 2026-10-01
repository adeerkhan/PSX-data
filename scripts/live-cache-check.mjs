/**
 * Live end-to-end check of the caching, rate limiting, and streaming layers.
 */
import { createPsxClient, isMarketSession, sessionTtlMs } from '../packages/client/dist/index.js';

const psx = createPsxClient();

console.log('=== session awareness ===');
console.log('  PKT now:      ', new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'full', timeStyle: 'short' }).format(new Date()));
console.log('  in session:   ', isMarketSession());
console.log('  cache ttl ms: ', sessionTtlMs());

console.log('\n=== marketWatch: cache hit on second call ===');
const t0 = Date.now();
const first = await psx.marketWatch();
const t1 = Date.now();
const second = await psx.marketWatch();
const t2 = Date.now();

console.log(`  first:  ${first.data.length} rows in ${t1 - t0}ms (source ${first.source})`);
console.log(`  second: ${second.data.length} rows in ${t2 - t1}ms (source ${second.source})`);
console.log(`  cache hit was faster: ${t2 - t1 < t1 - t0}`);
console.log(`  identical payload: ${JSON.stringify(first.data[0]) === JSON.stringify(second.data[0])}`);

console.log('\n=== bypassCache forces a real fetch ===');
const bypassed = await psx.marketWatch({ bypassCache: true });
console.log(`  bypassed: ${bypassed.data.length} rows, source ${bypassed.source}`);

console.log('\n=== cache stats ===');
console.log(' ', JSON.stringify(psx.stats()));

console.log('\n=== marketSummary cached ===');
const s1 = await psx.marketSummary();
const s2 = await psx.marketSummary();
console.log(`  status=${s1.status} total=${s1.total} (same object second time: ${s1 === s2})`);

console.log('\n=== symbols cached for an hour ===');
const sym1 = await psx.symbols();
const sym2 = await psx.symbols();
console.log(`  ${sym1.length} symbols, cached: ${sym1 === sym2}`);

console.log('\n=== constituents() (new) ===');
try {
  const cons = await psx.constituents('KSE100');
  console.log(`  KSE100 constituents: ${cons.length}`);
  console.log('  sample:', JSON.stringify(cons[0]));
} catch (e) {
  console.log(`  FAILED: ${e.constructor.name}: ${e.message.slice(0, 90)}`);
}

console.log('\n=== rate limiter: two history calls, same symbol ===');
const r0 = Date.now();
await psx.history('HBL', { bypassCache: true });
const r1 = Date.now();
console.log(`  first history: ${r1 - r0}ms`);

console.log('\n=== stream(): two ticks then abort ===');
const controller = new AbortController();
let ticks = 0;
const tStart = Date.now();
for await (const tick of psx.stream(['HBL', 'OGDC'], { intervalMs: 1000, signal: controller.signal })) {
  console.log(`  tick: ${tick.symbol} price=${tick.price} change=${tick.change}`);
  ticks += 1;
  if (ticks >= 2) controller.abort();
}
console.log(`  received ${ticks} ticks in ${Date.now() - tStart}ms`);

console.log('\n=== final stats ===');
console.log(' ', JSON.stringify(psx.stats()));
console.log(' ', JSON.stringify(await psx.diagnostics(), null, 1));

console.log('\nLIVE CHECK COMPLETE');