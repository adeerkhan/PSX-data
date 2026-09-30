import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';

const html = readFileSync('packages/fixtures/data/market-summary.html', 'utf8');
const $ = cheerio.load(html);

const cells = $('td.dataportal[data-srip]').first();
const row = cells.closest('tr');
const tds = row.children('td');
console.log('market-summary cell count:', tds.length);
tds.each((index, cell) => {
  const raw = $(cell).text().replace(/\s+/g, ' ').trim();
  console.log(`  [${index}] ${JSON.stringify(raw)}`);
});

console.log('');
const mwHtml = readFileSync('packages/fixtures/data/market-watch.html', 'utf8');
const $mw = cheerio.load(mwHtml);
const mwRow = $mw('td[data-search][data-order]').first().closest('tr');
console.log('market-watch cell count:', mwRow.children('td').length);
mwRow.children('td').each((index, cell) => {
  console.log(
    `  [${index}] data-order=${JSON.stringify($mw(cell).attr('data-order'))} text=${JSON.stringify($mw(cell).text().replace(/\s+/g, ' ').trim())}`,
  );
});
