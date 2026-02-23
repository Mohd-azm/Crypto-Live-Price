const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCoinGeckoSimplePriceUrl,
  parseCoinGeckoSimplePriceResponse
} = require('../dist/market-data/coingecko-fallback');

test('builds CoinGecko URL with deduplicated ids', () => {
  const url = buildCoinGeckoSimplePriceUrl(['bitcoin', 'ethereum', 'bitcoin']);

  assert.equal(
    url,
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Cethereum&vs_currencies=usd'
  );
});

test('parses CoinGecko simple price response', () => {
  const response = {
    bitcoin: { usd: 64000.5 },
    ethereum: { usd: 2300.1 },
    invalid: { usd: 'x' }
  };

  const parsed = parseCoinGeckoSimplePriceResponse(response);

  assert.equal(parsed.get('bitcoin'), 64000.5);
  assert.equal(parsed.get('ethereum'), 2300.1);
  assert.equal(parsed.has('invalid'), false);
});
