export interface SymbolMapItem {
  binanceSymbol: string;
  coinGeckoId: string;
}

export const MARKET_SYMBOLS: SymbolMapItem[] = [
  { binanceSymbol: 'btcusdt', coinGeckoId: 'bitcoin' },
  { binanceSymbol: 'ethusdt', coinGeckoId: 'ethereum' },
  { binanceSymbol: 'bnbusdt', coinGeckoId: 'binancecoin' }
];

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toLowerCase();
}

export function getConfiguredSymbols(): string[] {
  return MARKET_SYMBOLS.map((item) => item.binanceSymbol);
}

export function getSymbolToCoinGeckoIdMap(): Map<string, string> {
  const map = new Map<string, string>();

  for (const item of MARKET_SYMBOLS) {
    map.set(item.binanceSymbol, item.coinGeckoId);
  }

  return map;
}
