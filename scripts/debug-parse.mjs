import { parseMarketSummaryPage } from '../packages/client/dist/parsers.js';
import { parseSymbols } from '../packages/client/dist/parsers-json.js';
import { readFileSync } from 'node:fs';

const { quotes, summary } = parseMarketSummaryPage(
  readFileSync('packages/fixtures/data/market-summary.html', 'utf8'),
  'https://www.psx.com.pk/market-summary/',
);

console.log('summary:', JSON.stringify(summary, null, 1));
console.log('quote count:', quotes.length);

const image = quotes.find((q) => q.symbol === 'IMAGE');
console.log('IMAGE:', JSON.stringify(image, null, 1));

const withWarnings = quotes.filter((q) => q.warnings.length > 0);
console.log('rows with warnings:', withWarnings.length);
for (const q of withWarnings.slice(0, 5)) {
  console.log(`  ${q.symbol}: ${q.warnings.join('; ')}`);
}

const nullChange = quotes.filter((q) => q.change === null);
console.log('rows with null change:', nullChange.length, nullChange.map((q) => q.symbol).slice(0, 8));
