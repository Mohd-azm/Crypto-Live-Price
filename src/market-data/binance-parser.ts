export interface BinanceTradeUpdate {
  symbol: string;
  price: number;
  tradeTime: number;
}

interface BinanceTradePayload {
  e?: string;
  s?: string;
  p?: string;
  T?: number;
}

interface BinanceCombinedMessage {
  stream?: string;
  data?: BinanceTradePayload;
}

function parsePayload(payload: BinanceTradePayload): BinanceTradeUpdate | null {
  if (payload.e !== 'trade') {
    return null;
  }

  if (!payload.s || !payload.p) {
    return null;
  }

  const price = Number(payload.p);
  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    symbol: payload.s.toLowerCase(),
    price,
    tradeTime: typeof payload.T === 'number' ? payload.T : Date.now()
  };
}

export function parseBinanceTradeMessage(message: string): BinanceTradeUpdate | null {
  let parsed: BinanceTradePayload | BinanceCombinedMessage;

  try {
    parsed = JSON.parse(message) as BinanceTradePayload | BinanceCombinedMessage;
  } catch {
    return null;
  }

  if ('data' in parsed && parsed.data) {
    return parsePayload(parsed.data);
  }

  return parsePayload(parsed as BinanceTradePayload);
}
