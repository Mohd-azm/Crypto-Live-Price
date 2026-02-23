const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBinanceTradeMessage } = require('../dist/market-data/binance-parser');

test('parses combined stream trade payload', () => {
  const message = JSON.stringify({
    stream: 'btcusdt@trade',
    data: {
      e: 'trade',
      s: 'BTCUSDT',
      p: '65234.12',
      T: 1710000000000
    }
  });

  const parsed = parseBinanceTradeMessage(message);

  assert.equal(parsed?.symbol, 'btcusdt');
  assert.equal(parsed?.price, 65234.12);
  assert.equal(parsed?.tradeTime, 1710000000000);
});

test('returns null on unsupported event', () => {
  const message = JSON.stringify({
    e: 'bookTicker',
    s: 'BTCUSDT',
    p: '65234.12'
  });

  const parsed = parseBinanceTradeMessage(message);
  assert.equal(parsed, null);
});
