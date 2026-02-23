'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const WebSocket = require('ws')
const BFX = require('../index')

const PORT = Number(process.env.PORT || 3001)
const DEFAULT_SYMBOL = process.env.SYMBOL || 'tBTCUSD'
const FRONT_DIR = path.resolve(__dirname, '..', 'front')
const FALLBACK_POLL_MS = Number(process.env.FALLBACK_POLL_MS || 8000)
const LIST_CACHE_MS = 60 * 1000
const COINLORE_CACHE_MS = 30 * 1000

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

const latestBySymbol = new Map()
const clients = new Map()
const trackedSymbols = new Set()
const tickerListeners = new Set()
let lastError = null
let wsIsConnected = false
let fallbackError = null
let fallbackProvider = 'coingecko'
let marketListCache = {
  at: 0,
  provider: 'coingecko',
  data: []
}
let coinLoreCache = {
  at: 0,
  data: []
}

const COIN_ID_BY_BASE = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  XRP: 'ripple',
  ADA: 'cardano',
  SOL: 'solana',
  DOGE: 'dogecoin',
  BNB: 'binancecoin',
  TON: 'the-open-network',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  LINK: 'chainlink',
  TRX: 'tron',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  XLM: 'stellar',
  ATOM: 'cosmos',
  ETC: 'ethereum-classic',
  UNI: 'uniswap',
  MATIC: 'matic-network',
  NEAR: 'near',
  SHIB: 'shiba-inu',
  FIL: 'filecoin',
  APT: 'aptos',
  OP: 'optimism',
  ARB: 'arbitrum'
}

const bfx = new BFX()
const marketWS = bfx.ws(2, {
  transform: true,
  autoReconnect: true,
  reconnectDelay: 2000
})

const sendJSON = (res, statusCode, payload) => {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const sendClient = (client, payload) => {
  if (client.readyState !== WebSocket.OPEN) return
  client.send(JSON.stringify(payload))
}

const sendStatus = (client) => {
  const state = clients.get(client)
  if (!state) return

  const provider = wsIsConnected ? 'bitfinex' : fallbackProvider
  const error = wsIsConnected ? null : (fallbackError || lastError)

  sendClient(client, {
    type: 'status',
    data: {
      connectedToBitfinex: wsIsConnected,
      provider,
      symbol: state.symbol,
      error
    }
  })
}

const broadcastStatus = () => {
  clients.forEach((_, client) => sendStatus(client))
}

const broadcastToSymbol = (symbol, payload) => {
  clients.forEach((state, client) => {
    if (state.symbol === symbol) {
      sendClient(client, payload)
    }
  })
}

const normalizeSymbol = (input = '') => {
  const trimmed = `${input}`.trim().toUpperCase()
  if (!trimmed) return null

  const basic = trimmed.replace(/\s+/g, '')

  if (/^[TF][A-Z0-9]{3,12}$/.test(basic)) {
    return `${basic[0].toLowerCase()}${basic.slice(1)}`
  }

  const noSeparators = basic.replace(/[^A-Z0-9]/g, '')
  if (!noSeparators) return null

  if (/^[A-Z]{3}$/.test(noSeparators)) {
    return `t${noSeparators}USD`
  }

  if (/^[A-Z0-9]{6,12}$/.test(noSeparators)) {
    return `t${noSeparators}`
  }

  return null
}

const INITIAL_SYMBOL = normalizeSymbol(DEFAULT_SYMBOL) || 'tBTCUSD'

const getBaseFromSymbol = (symbol) => {
  const normalized = normalizeSymbol(symbol)
  if (!normalized) return null
  const pair = normalized.slice(1)

  if (pair.endsWith('USDT')) {
    return pair.slice(0, -4)
  }

  if (pair.endsWith('USD')) {
    return pair.slice(0, -3)
  }

  return null
}

const getCoinIdForSymbol = (symbol) => {
  const base = getBaseFromSymbol(symbol)
  if (!base) return null
  return COIN_ID_BY_BASE[base] || null
}

const getBinancePairForSymbol = (symbol) => {
  const base = getBaseFromSymbol(symbol)
  if (!base) return null
  return `${base}USDT`
}

const toTickerPayload = (symbol, ticker) => {
  const raw = typeof ticker?.toJS === 'function' ? ticker.toJS() : ticker
  const isArray = Array.isArray(raw)

  return {
    symbol,
    raw,
    bid: isArray ? raw[0] : raw?.bid,
    ask: isArray ? raw[2] : raw?.ask,
    dailyChange: isArray ? raw[4] : raw?.dailyChange,
    dailyChangePerc: isArray ? raw[5] : raw?.dailyChangePerc,
    lastPrice: isArray ? raw[6] : raw?.lastPrice,
    volume: isArray ? raw[7] : raw?.volume,
    high: isArray ? raw[8] : raw?.high,
    low: isArray ? raw[9] : raw?.low,
    at: Date.now()
  }
}

const toFallbackTickerPayload = (symbol, data = {}) => {
  const price = Number(data.usd)
  const changePct = Number(data.usd_24h_change)
  const dailyChangePerc = Number.isFinite(changePct) ? (changePct / 100) : null
  const dailyChange = (Number.isFinite(price) && Number.isFinite(dailyChangePerc))
    ? price * dailyChangePerc
    : null

  return {
    symbol,
    raw: data,
    bid: Number.isFinite(price) ? price : null,
    ask: Number.isFinite(price) ? price : null,
    dailyChange,
    dailyChangePerc,
    lastPrice: Number.isFinite(price) ? price : null,
    volume: Number(data.usd_24h_vol),
    high: Number(data.usd_24h_high),
    low: Number(data.usd_24h_low),
    at: Number(data.last_updated_at) ? Number(data.last_updated_at) * 1000 : Date.now()
  }
}

const fetchCoinGeckoSnapshot = async (symbols = []) => {
  const symbolToCoinId = new Map()

  symbols.forEach((symbol) => {
    const coinId = getCoinIdForSymbol(symbol)
    if (coinId) symbolToCoinId.set(symbol, coinId)
  })

  const coinIds = [...new Set(symbolToCoinId.values())]
  if (coinIds.length === 0) return new Map()

  const url = new URL('https://api.coingecko.com/api/v3/simple/price')
  url.searchParams.set('ids', coinIds.join(','))
  url.searchParams.set('vs_currencies', 'usd')
  url.searchParams.set('include_24hr_change', 'true')
  url.searchParams.set('include_24hr_vol', 'true')
  url.searchParams.set('include_24hr_high', 'true')
  url.searchParams.set('include_24hr_low', 'true')
  url.searchParams.set('include_last_updated_at', 'true')

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`fallback provider unavailable (${res.status})`)
  }

  const body = await res.json()
  const bySymbol = new Map()

  symbolToCoinId.forEach((coinId, symbol) => {
    const row = body[coinId]
    if (!row || row.usd === undefined || row.usd === null) return
    bySymbol.set(symbol, toFallbackTickerPayload(symbol, row))
  })

  return bySymbol
}

const fetchBinanceTicker = async (symbol) => {
  const pair = getBinancePairForSymbol(symbol)
  if (!pair) return null

  const url = new URL('https://api.binance.com/api/v3/ticker/24hr')
  url.searchParams.set('symbol', pair)

  const res = await fetch(url.toString())
  if (!res.ok) return null

  const body = await res.json()
  const lastPrice = Number(body.lastPrice)
  const changePct = Number(body.priceChangePercent)

  return {
    symbol,
    raw: body,
    bid: Number(body.bidPrice),
    ask: Number(body.askPrice),
    dailyChange: Number(body.priceChange),
    dailyChangePerc: Number.isFinite(changePct) ? (changePct / 100) : null,
    lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
    volume: Number(body.quoteVolume),
    high: Number(body.highPrice),
    low: Number(body.lowPrice),
    at: Date.now()
  }
}

const fetchBinanceSnapshot = async (symbols = []) => {
  const out = new Map()
  const jobs = symbols.map(async (symbol) => {
    const row = await fetchBinanceTicker(symbol)
    if (row) out.set(symbol, row)
  })

  await Promise.all(jobs)
  return out
}

const getCoinLoreList = async () => {
  if ((Date.now() - coinLoreCache.at) < COINLORE_CACHE_MS && coinLoreCache.data.length > 0) {
    return coinLoreCache.data
  }

  const url = new URL('https://api.coinlore.net/api/tickers/')
  url.searchParams.set('start', '0')
  url.searchParams.set('limit', '200')

  const res = await fetch(url.toString())
  if (!res.ok) {
    throw new Error(`coinlore unavailable (${res.status})`)
  }

  const body = await res.json()
  const rows = Array.isArray(body?.data) ? body.data : []
  const mapped = rows.map((row) => {
    const base = String(row.symbol || '').toUpperCase()
    return {
      id: row.id,
      symbol: `t${base}USD`,
      base,
      name: row.name,
      price: Number(row.price_usd),
      change24h: Number(row.percent_change_24h),
      marketCap: Number(row.market_cap_usd),
      volume24h: Number(row.volume24),
      high24h: Number(row.high24h),
      low24h: Number(row.low24h)
    }
  })

  coinLoreCache = {
    at: Date.now(),
    data: mapped
  }

  return mapped
}

const fetchCoinLoreSnapshot = async (symbols = []) => {
  const out = new Map()
  const list = await getCoinLoreList()
  const byBase = new Map(list.map(item => [item.base, item]))

  symbols.forEach((symbol) => {
    const base = getBaseFromSymbol(symbol)
    if (!base) return
    const row = byBase.get(base)
    if (!row) return

    const dailyChangePerc = Number.isFinite(Number(row.change24h))
      ? (Number(row.change24h) / 100)
      : null
    const lastPrice = Number(row.price)
    const dailyChange = (Number.isFinite(lastPrice) && Number.isFinite(dailyChangePerc))
      ? lastPrice * dailyChangePerc
      : null

    out.set(symbol, {
      symbol,
      raw: row,
      bid: Number.isFinite(lastPrice) ? lastPrice : null,
      ask: Number.isFinite(lastPrice) ? lastPrice : null,
      dailyChange,
      dailyChangePerc,
      lastPrice: Number.isFinite(lastPrice) ? lastPrice : null,
      volume: Number(row.volume24h),
      high: Number(row.high24h),
      low: Number(row.low24h),
      at: Date.now()
    })
  })

  return out
}

const fetchFallbackSnapshot = async (symbols = []) => {
  try {
    const bySymbol = await fetchCoinGeckoSnapshot(symbols)
    fallbackProvider = 'coingecko'
    return bySymbol
  } catch (err) {
    try {
      const bySymbol = await fetchBinanceSnapshot(symbols)
      if (bySymbol.size === 0) throw err
      fallbackProvider = 'binance'
      return bySymbol
    } catch (binanceErr) {
      const bySymbol = await fetchCoinLoreSnapshot(symbols)
      if (bySymbol.size === 0) throw binanceErr
      fallbackProvider = 'coinlore'
      return bySymbol
    }
  }
}

const pushFallbackTickers = async (symbols, targetClient = null) => {
  const fallbackData = await fetchFallbackSnapshot(symbols)
  fallbackError = null

  fallbackData.forEach((payload, symbol) => {
    latestBySymbol.set(symbol, payload)

    const message = {
      type: 'ticker',
      data: payload
    }

    if (targetClient) {
      const state = clients.get(targetClient)
      if (state && state.symbol === symbol) {
        sendClient(targetClient, message)
      }
      return
    }

    broadcastToSymbol(symbol, message)
  })
}

const getMarketList = async () => {
  if ((Date.now() - marketListCache.at) < LIST_CACHE_MS && marketListCache.data.length > 0) {
    return marketListCache.data
  }

  const url = new URL('https://api.coingecko.com/api/v3/coins/markets')
  url.searchParams.set('vs_currency', 'usd')
  url.searchParams.set('order', 'market_cap_desc')
  url.searchParams.set('per_page', '150')
  url.searchParams.set('page', '1')
  url.searchParams.set('sparkline', 'false')
  url.searchParams.set('price_change_percentage', '24h')

  try {
    const res = await fetch(url.toString())
    if (!res.ok) {
      throw new Error(`coingecko list unavailable (${res.status})`)
    }

    const rows = await res.json()
    const mapped = rows.map((coin) => ({
      id: coin.id,
      symbol: `t${String(coin.symbol || '').toUpperCase()}USD`,
      base: String(coin.symbol || '').toUpperCase(),
      name: coin.name,
      price: coin.current_price,
      change24h: coin.price_change_percentage_24h,
      marketCap: coin.market_cap,
      volume24h: coin.total_volume,
      high24h: coin.high_24h,
      low24h: coin.low_24h
    }))

    marketListCache = {
      at: Date.now(),
      provider: 'coingecko',
      data: mapped
    }

    return mapped
  } catch (err) {
    try {
      const bUrl = new URL('https://api.binance.com/api/v3/ticker/24hr')
      const bRes = await fetch(bUrl.toString())
      if (!bRes.ok) {
        throw new Error(`binance unavailable (${bRes.status})`)
      }

      const rows = await bRes.json()
      const mapped = rows
        .filter(row => typeof row.symbol === 'string' && row.symbol.endsWith('USDT'))
        .map((row) => {
          const base = row.symbol.replace(/USDT$/, '')
          return {
            id: row.symbol,
            symbol: `t${base}USD`,
            base,
            name: `${base}/USDT`,
            price: Number(row.lastPrice),
            change24h: Number(row.priceChangePercent),
            marketCap: null,
            volume24h: Number(row.quoteVolume),
            high24h: Number(row.highPrice),
            low24h: Number(row.lowPrice)
          }
        })
        .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
        .slice(0, 150)

      marketListCache = {
        at: Date.now(),
        provider: 'binance',
        data: mapped
      }

      return mapped
    } catch (binanceErr) {
      const mapped = await getCoinLoreList()
      marketListCache = {
        at: Date.now(),
        provider: 'coinlore',
        data: mapped
      }
      return mapped
    }
  }
}

const ensureTickerListener = (symbol) => {
  if (tickerListeners.has(symbol)) return

  tickerListeners.add(symbol)
  marketWS.onTicker({ symbol }, (ticker) => {
    const payload = toTickerPayload(symbol, ticker)
    latestBySymbol.set(symbol, payload)

    broadcastToSymbol(symbol, {
      type: 'ticker',
      data: payload
    })
  })
}

const ensureSubscription = async (symbol) => {
  ensureTickerListener(symbol)
  trackedSymbols.add(symbol)

  if (!marketWS.isOpen()) return
  if (marketWS.hasDataChannel('ticker', { symbol })) return

  await marketWS.subscribeTicker(symbol)
}

const serveStatic = (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  const normalizedPath = path.posix.normalize(pathname)
  const safePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath
  const filePath = path.resolve(FRONT_DIR, safePath)
  const frontRoot = `${FRONT_DIR}${path.sep}`

  if (!filePath.startsWith(frontRoot)) {
    sendJSON(res, 400, { error: 'invalid path' })
    return
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJSON(res, 404, { error: 'not found' })
        return
      }

      sendJSON(res, 500, { error: 'failed to read file' })
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': contentType })
    res.end(content)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')

  if (url.pathname === '/api/health') {
    sendJSON(res, 200, {
      ok: true,
      provider: wsIsConnected ? 'bitfinex' : fallbackProvider,
      fallbackProvider,
      symbols: [...trackedSymbols],
      wsConnected: wsIsConnected,
      hasTicker: latestBySymbol.size > 0,
      fallbackError,
      lastError
    })
    return
  }

  if (url.pathname === '/api/prices') {
    const q = `${url.searchParams.get('q') || ''}`.trim().toLowerCase()
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)))

    getMarketList().then((list) => {
      const filtered = q
        ? list.filter(row => row.symbol.toLowerCase().includes(q) || row.name.toLowerCase().includes(q) || row.base.toLowerCase().includes(q))
        : list

      sendJSON(res, 200, {
        ok: true,
        provider: marketListCache.provider || 'coingecko',
        items: filtered.slice(0, limit)
      })
    }).catch((err) => {
      sendJSON(res, 502, {
        ok: false,
        error: err.message
      })
    })
    return
  }

  serveStatic(req, res)
})

const wss = new WebSocket.Server({ server, path: '/live' })

wss.on('connection', (client) => {
  const symbol = INITIAL_SYMBOL
  clients.set(client, { symbol })
  sendStatus(client)

  const latest = latestBySymbol.get(symbol)
  if (latest) {
    sendClient(client, {
      type: 'ticker',
      data: latest
    })
  }

  ensureSubscription(symbol).catch((err) => {
    lastError = err.message
    sendClient(client, { type: 'error', data: { message: err.message } })
  })

  if (!wsIsConnected) {
    pushFallbackTickers([symbol], client).catch((err) => {
      fallbackError = err.message
      sendStatus(client)
      sendClient(client, { type: 'error', data: { message: err.message } })
    })
  }

  client.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch (err) {
      sendClient(client, { type: 'error', data: { message: 'invalid message format' } })
      return
    }

    if (msg.type !== 'set-symbol') return

    const symbolInput = normalizeSymbol(msg.symbol)
    if (!symbolInput) {
      sendClient(client, { type: 'error', data: { message: 'invalid symbol' } })
      return
    }

    clients.set(client, { symbol: symbolInput })

    try {
      await ensureSubscription(symbolInput)
      sendStatus(client)

      const cached = latestBySymbol.get(symbolInput)
      if (cached) {
        sendClient(client, { type: 'ticker', data: cached })
      }

      if (!wsIsConnected) {
        await pushFallbackTickers([symbolInput], client)
      }
    } catch (err) {
      lastError = err.message
      sendClient(client, { type: 'error', data: { message: err.message } })
    }
  })

  client.on('close', () => {
    clients.delete(client)
  })
})

marketWS.on('open', async () => {
  wsIsConnected = true
  lastError = null
  fallbackError = null
  fallbackProvider = 'coingecko'
  broadcastStatus()

  try {
    for (const symbol of trackedSymbols) {
      if (!marketWS.hasDataChannel('ticker', { symbol })) {
        await marketWS.subscribeTicker(symbol)
      }
    }
  } catch (err) {
    lastError = err.message
    clients.forEach((_, client) => {
      sendClient(client, {
        type: 'error',
        data: { message: err.message }
      })
    })
  }
})

marketWS.on('close', () => {
  wsIsConnected = false
  broadcastStatus()
})

marketWS.on('error', (err) => {
  lastError = err.message
  broadcastStatus()
  clients.forEach((_, client) => {
    sendClient(client, {
      type: 'error',
      data: { message: err.message }
    })
  })
})

trackedSymbols.add(INITIAL_SYMBOL)
ensureTickerListener(INITIAL_SYMBOL)

setInterval(() => {
  if (wsIsConnected) return
  const symbols = [...trackedSymbols]
  if (symbols.length === 0) return

  pushFallbackTickers(symbols).then(() => {
    broadcastStatus()
  }).catch((err) => {
    fallbackError = err.message
    broadcastStatus()
  })
}, FALLBACK_POLL_MS)

server.listen(PORT, async () => {
  console.log(`frontend: http://localhost:${PORT}`)
  console.log(`default symbol: ${INITIAL_SYMBOL}`)

  try {
    await marketWS.open()
  } catch (err) {
    lastError = err.message
    console.error(`failed to connect to Bitfinex WS: ${err.message}`)
  }
})

const shutdown = async () => {
  try {
    await marketWS.close()
  } catch (e) {}

  wss.close(() => {
    server.close(() => process.exit(0))
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
