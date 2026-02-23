import { Injectable, ServiceUnavailableException } from '@nestjs/common';

interface CoinPaprikaQuotes {
  USD?: {
    price?: number;
    percent_change_1h?: number;
    percent_change_24h?: number;
    percent_change_7d?: number;
    market_cap?: number;
    volume_24h?: number;
  };
}

interface CoinPaprikaTicker {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  circulating_supply: number | string | null;
  total_supply?: number | string | null;
  max_supply?: number | string | null;
  quotes?: CoinPaprikaQuotes;
}

export interface CoinSummary {
  id: string;
  name: string;
  symbol: string;
  rank: number;
  price: number;
  change1h: number;
  change24h: number;
  change7d: number;
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
  maxSupply: number;
}

@Injectable()
export class AppService {
  private readonly endpoint = 'https://api.coinpaprika.com/v1/tickers';
  private readonly cacheTtlMs = 900;
  private lastFetchAt = 0;
  private cached: CoinSummary[] = [];
  private inflight?: Promise<CoinSummary[]>;

  async getTopTickers(limit = 24): Promise<CoinSummary[]> {
    const now = Date.now();
    if (this.cached.length > 0 && now - this.lastFetchAt < this.cacheTtlMs) {
      return this.cached;
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.fetchTickers(limit)
      .then((rows) => {
        this.cached = rows;
        this.lastFetchAt = Date.now();
        return rows;
      })
      .catch((error: unknown) => {
        if (this.cached.length > 0) {
          return this.cached;
        }
        const message = error instanceof Error ? error.message : 'خطای ناشناخته';
        throw new ServiceUnavailableException(`دریافت قیمت ممکن نشد: ${message}`);
      })
      .finally(() => {
        this.inflight = undefined;
      });

    return this.inflight;
  }

  private async fetchTickers(limit: number): Promise<CoinSummary[]> {
    const response = await fetch(this.endpoint, {
      headers: {
        accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`وضعیت پاسخ نامعتبر: ${response.status}`);
    }

    const data = (await response.json()) as CoinPaprikaTicker[];

    return data
      .filter((item) => Number.isFinite(item.rank) && item.rank > 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit)
      .map((item) => {
        const usd = item.quotes?.USD;
        const circulating = this.toFinite(item.circulating_supply);
        const totalSupply = this.toFinite(item.total_supply);
        const maxSupply = this.toFinite(item.max_supply);

        return {
          id: item.id,
          name: item.name,
          symbol: item.symbol,
          rank: item.rank,
          price: this.toFinite(usd?.price),
          change1h: this.toFinite(usd?.percent_change_1h),
          change24h: this.toFinite(usd?.percent_change_24h),
          change7d: this.toFinite(usd?.percent_change_7d),
          marketCap: this.toFinite(usd?.market_cap),
          volume24h: this.toFinite(usd?.volume_24h),
          circulatingSupply: circulating > 0 ? circulating : totalSupply,
          maxSupply
        };
      });
  }

  private toFinite(value: unknown): number {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    return 0;
  }
}
