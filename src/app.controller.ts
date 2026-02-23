import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { AppService, CoinSummary } from './app.service';
import { LatestPrice, MarketDataService } from './market-data/market-data.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly marketDataService: MarketDataService
  ) {}

  @Get('api/prices')
  getPrices(): Promise<CoinSummary[]> {
    return this.appService.getTopTickers();
  }

  @Get('api/market/latest')
  getLatestPrices(@Query('symbols') symbols?: string): LatestPrice[] {
    if (!symbols) {
      return this.marketDataService.getLatestPrices();
    }

    const requested = symbols
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    return this.marketDataService.getLatestPrices(requested);
  }

  @Get('api/market/latest/:symbol')
  getLatestPriceBySymbol(@Param('symbol') symbol: string): LatestPrice {
    const latest = this.marketDataService.getLatestPrice(symbol);

    if (!latest) {
      throw new NotFoundException(`قیمتی برای نماد "${symbol}" موجود نیست`);
    }

    return latest;
  }

  @Get('api/market/status')
  getMarketStatus() {
    return this.marketDataService.getStatus();
  }
}
