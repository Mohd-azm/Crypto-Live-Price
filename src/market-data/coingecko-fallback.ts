export function buildCoinGeckoSimplePriceUrl(ids: string[]): string {
  const uniqueIds = [...new Set(ids.map((item) => item.trim()).filter(Boolean))];
  const idsParam = encodeURIComponent(uniqueIds.join(','));

  return `https://api.coingecko.com/api/v3/simple/price?ids=${idsParam}&vs_currencies=usd`;
}

export function parseCoinGeckoSimplePriceResponse(payload: unknown): Map<string, number> {
  const prices = new Map<string, number>();

  if (!payload || typeof payload !== 'object') {
    return prices;
  }

  for (const [coinId, row] of Object.entries(payload as Record<string, unknown>)) {
    if (!row || typeof row !== 'object') {
      continue;
    }

    const usd = (row as Record<string, unknown>).usd;
    if (typeof usd === 'number' && Number.isFinite(usd)) {
      prices.set(coinId, usd);
    }
  }

  return prices;
}
