import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'events';
import * as WebSocket from 'ws';
import { Observable, Subject } from 'rxjs';
import { parseBinanceTradeMessage } from './binance-parser';
import { buildCoinGeckoSimplePriceUrl, parseCoinGeckoSimplePriceResponse } from './coingecko-fallback';
import { getConfiguredSymbols, getSymbolToCoinGeckoIdMap, normalizeSymbol } from './symbol-map';

export type PriceSource = 'binance_ws' | 'binance_rest_bootstrap' | 'coingecko_fallback';

export interface LatestPrice {
  symbol: string;
  price: number;
  updatedAt: string;
  source: PriceSource;
}

interface BinanceRestTicker {
  symbol: string;
  price: string;
}

@Injectable()
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly symbols = getConfiguredSymbols();
  private readonly symbolToCoinGeckoId = getSymbolToCoinGeckoIdMap();
  private readonly reconnectDelaysMs = [1000, 2000, 5000, 10000, 30000];
  private readonly fallbackIntervalMs = 60000;

  private ws?: WebSocket;
  private reconnectAttempt = 0;
  private reconnectCount = 0;
  private reconnectTimer?: NodeJS.Timeout;

  private fallbackActive = false;
  private fallbackTimer?: NodeJS.Timeout;

  private readonly updatesSubject = new Subject<LatestPrice>();
  readonly updates$: Observable<LatestPrice> = this.updatesSubject.asObservable();
  readonly eventEmitter = new EventEmitter();

  private readonly latestPrices = new Map<string, LatestPrice>();
  private lastPriceUpdateAt?: Date;

  async onModuleInit(): Promise<void> {
    this.logger.log(`راه‌اندازی MarketDataService برای نمادها: ${this.symbols.join(', ')}`);

    await this.bootstrapFromBinanceRest();
    this.connectWebSocket();
  }

  onModuleDestroy(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }

    this.eventEmitter.removeAllListeners();
    this.updatesSubject.complete();
  }

  getTrackedSymbols(): string[] {
    return [...this.symbols];
  }

  getLatestPrice(symbol: string): LatestPrice | null {
    const normalized = normalizeSymbol(symbol);
    return this.latestPrices.get(normalized) ?? null;
  }

  getLatestPrices(symbols?: string[]): LatestPrice[] {
    if (!symbols || symbols.length === 0) {
      return this.symbols
        .map((symbol) => this.latestPrices.get(symbol))
        .filter((item): item is LatestPrice => Boolean(item));
    }

    return symbols
      .map((symbol) => this.latestPrices.get(normalizeSymbol(symbol)))
      .filter((item): item is LatestPrice => Boolean(item));
  }

  getStatus() {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      fallbackActive: this.fallbackActive,
      reconnectCount: this.reconnectCount,
      reconnectAttempt: this.reconnectAttempt,
      trackedSymbols: this.getTrackedSymbols(),
      lastPriceUpdateAt: this.lastPriceUpdateAt ? this.lastPriceUpdateAt.toISOString() : null
    };
  }

  private connectWebSocket(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const streams = this.symbols.map((symbol) => `${symbol}@trade`).join('/');
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.logger.log(`اتصال به Binance WS: ${wsUrl}`);

    this.ws = new WebSocket(wsUrl, {
      handshakeTimeout: 10000
    });

    this.ws.on('open', () => {
      this.logger.log('اتصال WS برقرار شد');
      this.reconnectAttempt = 0;
      this.stopFallbackPolling();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      const message = this.rawDataToText(raw);
      const parsed = parseBinanceTradeMessage(message);

      if (!parsed) {
        return;
      }

      if (!this.symbols.includes(parsed.symbol)) {
        return;
      }

      this.publishPrice(parsed.symbol, parsed.price, parsed.tradeTime, 'binance_ws');
    });

    this.ws.on('ping', (payload: Buffer) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong(payload);
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error(`خطا در WS بایننس: ${error.message}`);

      if (this.shouldEnableFallback(error.message)) {
        this.startFallbackPolling('ws-error');
      }
    });

    this.ws.on('close', (code: number, reasonBuffer: Buffer) => {
      const reason = reasonBuffer.toString() || 'بدون دلیل';
      this.logger.warn(`اتصال WS قطع شد. code=${code}, reason=${reason}`);
      this.ws = undefined;

      this.scheduleReconnect();
      this.startFallbackPolling('ws-close');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const delay =
      this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ??
      this.reconnectDelaysMs[this.reconnectDelaysMs.length - 1];

    this.reconnectAttempt += 1;
    this.reconnectCount += 1;

    this.logger.warn(`تلاش مجدد WS در ${delay}ms (reconnect #${this.reconnectCount})`);

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket();
    }, delay);
  }

  private rawDataToText(raw: WebSocket.RawData): string {
    if (typeof raw === 'string') {
      return raw;
    }

    if (Buffer.isBuffer(raw)) {
      return raw.toString('utf8');
    }

    if (Array.isArray(raw)) {
      return Buffer.concat(raw).toString('utf8');
    }

    return raw.toString();
  }

  private publishPrice(symbol: string, price: number, timestampMs: number, source: PriceSource): void {
    const normalized = normalizeSymbol(symbol);
    const timestamp = new Date(timestampMs || Date.now());

    const update: LatestPrice = {
      symbol: normalized,
      price,
      updatedAt: timestamp.toISOString(),
      source
    };

    this.latestPrices.set(normalized, update);
    this.lastPriceUpdateAt = timestamp;

    this.updatesSubject.next(update);
    this.eventEmitter.emit('price.update', update);
  }

  private shouldEnableFallback(message: string): boolean {
    const errorText = message.toLowerCase();

    return (
      errorText.includes('econnreset') ||
      errorText.includes('403') ||
      errorText.includes('timeout') ||
      errorText.includes('timedout') ||
      errorText.includes('fetch failed') ||
      errorText.includes('unexpected server response')
    );
  }

  private async bootstrapFromBinanceRest(): Promise<void> {
    const restSymbols = this.symbols.map((symbol) => symbol.toUpperCase());
    const symbolsParam = encodeURIComponent(JSON.stringify(restSymbols));
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${symbolsParam}`;

    try {
      const response = await this.fetchWithTimeout(url, 10000);

      if (!response.ok) {
        throw new Error(`Binance REST status=${response.status}`);
      }

      const payload = (await response.json()) as BinanceRestTicker[];

      for (const row of payload) {
        const symbol = row.symbol.toLowerCase();
        const price = Number(row.price);

        if (this.symbols.includes(symbol) && Number.isFinite(price)) {
          this.publishPrice(symbol, price, Date.now(), 'binance_rest_bootstrap');
        }
      }

      this.logger.log('Bootstrap اولیه قیمت از Binance REST انجام شد');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'خطای ناشناخته';
      this.logger.warn(`Bootstrap از Binance REST ناموفق بود: ${message}`);

      if (this.shouldEnableFallback(message)) {
        this.startFallbackPolling('binance-rest');
      }
    }
  }

  private startFallbackPolling(reason: string): void {
    if (this.fallbackActive) {
      return;
    }

    this.fallbackActive = true;
    this.logger.warn(`فعال‌سازی fallback (CoinGecko) به علت: ${reason}`);

    void this.fetchFromCoinGecko();

    this.fallbackTimer = setInterval(() => {
      void this.fetchFromCoinGecko();
    }, this.fallbackIntervalMs);
  }

  private stopFallbackPolling(): void {
    if (!this.fallbackActive) {
      return;
    }

    this.fallbackActive = false;

    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = undefined;
    }

    this.logger.log('fallback (CoinGecko) متوقف شد؛ WS بایننس در دسترس است');
  }

  private async fetchFromCoinGecko(): Promise<void> {
    const ids = [...new Set(Array.from(this.symbolToCoinGeckoId.values()))];
    const url = buildCoinGeckoSimplePriceUrl(ids);

    try {
      const response = await this.fetchWithTimeout(url, 10000);

      if (!response.ok) {
        throw new Error(`CoinGecko status=${response.status}`);
      }

      const payload = (await response.json()) as unknown;
      const pricesById = parseCoinGeckoSimplePriceResponse(payload);

      for (const symbol of this.symbols) {
        const coinGeckoId = this.symbolToCoinGeckoId.get(symbol);
        if (!coinGeckoId) {
          continue;
        }

        const price = pricesById.get(coinGeckoId);
        if (typeof price === 'number' && Number.isFinite(price)) {
          this.publishPrice(symbol, price, Date.now(), 'coingecko_fallback');
        }
      }

      this.logger.log('به‌روزرسانی قیمت از CoinGecko انجام شد');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'خطای ناشناخته';
      this.logger.error(`خطا در fallback کوین‌گکو: ${message}`);
    }
  }

  private async fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
