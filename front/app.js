/* global WebSocket, document, window */
'use strict'

const statusEl = document.getElementById('status')
const healthBtnEl = document.getElementById('health-btn')
const apiHealthEl = document.getElementById('api-health')
const formEl = document.getElementById('search-form')
const inputEl = document.getElementById('symbol-input')
const pricesBodyEl = document.getElementById('prices-body')

const selectedNameEl = document.getElementById('selected-name')
const selectedSymbolEl = document.getElementById('selected-symbol')
const selectedPriceEl = document.getElementById('selected-price')
const selectedChangeEl = document.getElementById('selected-change')
const selectedVolumeEl = document.getElementById('selected-volume')
const selectedUpdatedEl = document.getElementById('selected-updated')

let socket = null
let activeSymbol = 'tBTCUSD'
let listTimer = null
const rowBySymbol = new Map()
const itemBySymbol = new Map()

const fmtCurrency = (value, digits = 2) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`
}

const fmtCompactCurrency = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `$${n.toLocaleString(undefined, {
    notation: 'compact',
    maximumFractionDigits: 2
  })}`
}

const fmtPercent = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `${n.toFixed(2)}%`
}

const normalizeSymbol = (raw = '') => {
  const cleaned = `${raw}`.trim().toUpperCase()
  if (!cleaned) return null

  if (/^[TF][A-Z0-9]{3,12}$/.test(cleaned)) {
    return `${cleaned[0].toLowerCase()}${cleaned.slice(1)}`
  }

  const plain = cleaned.replace(/[^A-Z0-9]/g, '')
  if (!plain) return null
  if (/^[A-Z]{3}$/.test(plain)) return `t${plain}USD`
  if (/^[A-Z0-9]{6,12}$/.test(plain)) return `t${plain}`
  return null
}

const updateStatus = (text) => {
  statusEl.textContent = text
}

const updateApiHealth = ({ text, level }) => {
  apiHealthEl.textContent = text
  apiHealthEl.className = `api-health${level ? ` ${level}` : ''}`
}

const hashCode = (text = '') => {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const badgeColor = (symbol = '') => {
  const palette = ['#f7931a', '#627eea', '#26a17b', '#2775ca', '#345d9d', '#16c784', '#ea3943', '#4f6ef7', '#7f8fa4']
  return palette[hashCode(symbol) % palette.length]
}

const sparkValues = (seedText = '', change = 0) => {
  const seed = hashCode(seedText) % 97
  const out = []
  let v = 50 + (seed % 10)

  for (let i = 0; i < 24; i += 1) {
    const wave = Math.sin((i + seed) / 2.6) * 3.5
    const drift = (Number(change) || 0) * 0.12
    v = Math.max(8, Math.min(92, v + wave + drift + ((seed % 7) - 3) * 0.22))
    out.push(v)
  }

  return out
}

const renderSparkSVG = (symbol, change24h) => {
  const values = sparkValues(symbol, change24h)
  const step = 120 / (values.length - 1)
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(40 - (v * 0.34)).toFixed(2)}`).join(' ')
  const stroke = Number(change24h) >= 0 ? '#16c784' : '#ea3943'

  return `<svg class="spark" viewBox="0 0 120 40" preserveAspectRatio="none"><polyline fill="none" stroke="${stroke}" stroke-width="2.2" points="${points}" /></svg>`
}

const setActiveRow = () => {
  rowBySymbol.forEach((row, symbol) => {
    if (symbol === activeSymbol) {
      row.classList.add('active')
    } else {
      row.classList.remove('active')
    }
  })
}

const selectSymbol = (symbol, shouldSend = true) => {
  const normalized = normalizeSymbol(symbol)
  if (!normalized) return

  activeSymbol = normalized
  selectedSymbolEl.textContent = normalized
  inputEl.value = normalized
  setActiveRow()

  const item = itemBySymbol.get(normalized)
  if (item) {
    selectedNameEl.textContent = item.name || item.base || normalized
    selectedPriceEl.textContent = fmtCurrency(item.price, 2)
    selectedChangeEl.textContent = fmtPercent(item.change24h)
    selectedChangeEl.className = `selected-change ${Number(item.change24h) >= 0 ? 'up' : 'down'}`
    selectedVolumeEl.textContent = fmtCompactCurrency(item.volume24h)
  }

  if (shouldSend && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'set-symbol', symbol: normalized }))
  }
}

const rowCell = (tag = 'td', text = '') => {
  const cell = document.createElement(tag)
  cell.textContent = text
  return cell
}

const renderTable = (items = []) => {
  pricesBodyEl.innerHTML = ''
  rowBySymbol.clear()
  itemBySymbol.clear()

  const fragment = document.createDocumentFragment()

  items.forEach((item, index) => {
    const symbol = normalizeSymbol(item.symbol)
    if (!symbol) return

    itemBySymbol.set(symbol, { ...item, symbol })

    const tr = document.createElement('tr')
    tr.dataset.symbol = symbol

    const rank = rowCell('td', `${index + 1}`)

    const nameTd = document.createElement('td')
    const wrap = document.createElement('div')
    wrap.className = 'coin-name'

    const badge = document.createElement('span')
    badge.className = 'coin-badge'
    badge.style.background = badgeColor(symbol)
    badge.textContent = `${(item.base || '').slice(0, 1) || '?'}`

    const textWrap = document.createElement('div')
    textWrap.className = 'coin-text'

    const strong = document.createElement('strong')
    strong.textContent = item.name || symbol

    const span = document.createElement('span')
    span.textContent = item.base || symbol.replace(/^t/i, '').replace(/USD$/, '')

    textWrap.appendChild(strong)
    textWrap.appendChild(span)
    wrap.appendChild(badge)
    wrap.appendChild(textWrap)
    nameTd.appendChild(wrap)

    const price = rowCell('td', fmtCurrency(item.price, 2))
    price.className = 'price-cell'

    const change = rowCell('td', fmtPercent(item.change24h))
    change.className = Number(item.change24h) >= 0 ? 'up' : 'down'

    const marketCap = rowCell('td', fmtCompactCurrency(item.marketCap))
    const volume = rowCell('td', fmtCompactCurrency(item.volume24h))

    const spark = document.createElement('td')
    spark.innerHTML = renderSparkSVG(symbol, item.change24h)

    tr.appendChild(rank)
    tr.appendChild(nameTd)
    tr.appendChild(price)
    tr.appendChild(change)
    tr.appendChild(marketCap)
    tr.appendChild(volume)
    tr.appendChild(spark)

    tr.addEventListener('click', () => {
      selectSymbol(symbol, true)
      updateStatus(`Tracking ${symbol}...`)
    })

    rowBySymbol.set(symbol, tr)
    fragment.appendChild(tr)
  })

  pricesBodyEl.appendChild(fragment)
  setActiveRow()
}

const updateRowFromTicker = (ticker = {}) => {
  const symbol = normalizeSymbol(ticker.symbol || '')
  if (!symbol) return

  const row = rowBySymbol.get(symbol)
  if (!row) return

  const price = Number(ticker.lastPrice)
  const changePct = Number(ticker.dailyChangePerc) * 100
  const volume = Number(ticker.volume)

  if (Number.isFinite(price)) {
    row.children[2].textContent = fmtCurrency(price, 2)
  }

  if (Number.isFinite(changePct)) {
    row.children[3].textContent = fmtPercent(changePct)
    row.children[3].className = changePct >= 0 ? 'up' : 'down'
    row.children[6].innerHTML = renderSparkSVG(symbol, changePct)
  }

  if (Number.isFinite(volume)) {
    row.children[5].textContent = fmtCompactCurrency(volume)
  }
}

const updateSelectedFromTicker = (ticker = {}) => {
  const symbol = normalizeSymbol(ticker.symbol || activeSymbol)
  if (!symbol) return

  selectedSymbolEl.textContent = symbol
  selectedPriceEl.textContent = fmtCurrency(ticker.lastPrice, 2)

  const changePct = Number(ticker.dailyChangePerc) * 100
  selectedChangeEl.textContent = fmtPercent(changePct)
  selectedChangeEl.className = `selected-change ${changePct >= 0 ? 'up' : 'down'}`

  selectedVolumeEl.textContent = fmtCompactCurrency(ticker.volume)
  selectedUpdatedEl.textContent = ticker.at
    ? new Date(ticker.at).toLocaleTimeString()
    : '-'

  const item = itemBySymbol.get(symbol)
  selectedNameEl.textContent = (item && item.name) || symbol
}

const fetchPriceList = async (query = '') => {
  try {
    const url = new URL('/api/prices', window.location.origin)
    if (query) url.searchParams.set('q', query)
    url.searchParams.set('limit', '80')

    const res = await fetch(url.toString(), { cache: 'no-store' })
    if (!res.ok) throw new Error(`list fetch failed (${res.status})`)

    const data = await res.json()
    const items = Array.isArray(data.items) ? data.items : []
    renderTable(items)

    if (!itemBySymbol.has(activeSymbol) && items.length > 0) {
      selectSymbol(items[0].symbol, false)
    } else {
      selectSymbol(activeSymbol, false)
    }
  } catch (err) {
    updateStatus(`Price list error: ${err.message}`)
  }
}

const checkApiHealth = async () => {
  healthBtnEl.disabled = true
  const oldLabel = healthBtnEl.textContent
  healthBtnEl.textContent = 'Checking...'

  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    if (!res.ok) throw new Error(`health failed (${res.status})`)
    const health = await res.json()

    const provider = health.provider || 'unknown'
    const active = provider !== 'bitfinex'
      ? `fallback: ${provider}`
      : `live: ${provider}`
    const level = provider === 'bitfinex' || provider === 'coinlore' || provider === 'coingecko' || provider === 'binance'
      ? 'ok'
      : 'error'

    const errText = health.lastError ? ` | ${health.lastError}` : ''
    updateApiHealth({
      text: `API status: ${active}${errText}`,
      level
    })
  } catch (err) {
    updateApiHealth({
      text: `API status: check failed | ${err.message}`,
      level: 'error'
    })
  } finally {
    healthBtnEl.disabled = false
    healthBtnEl.textContent = oldLabel
  }
}

const connect = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  socket = new WebSocket(`${protocol}://${window.location.host}/live`)

  socket.onopen = () => {
    updateStatus('Connected to backend')
    socket.send(JSON.stringify({ type: 'set-symbol', symbol: activeSymbol }))
  }

  socket.onclose = () => {
    updateStatus('Disconnected. Retrying...')
    setTimeout(connect, 1400)
  }

  socket.onerror = () => {
    updateStatus('WebSocket error. Retrying...')
  }

  socket.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (err) {
      return
    }

    if (msg.type === 'status' && msg.data) {
      if (msg.data.symbol) {
        activeSymbol = normalizeSymbol(msg.data.symbol) || activeSymbol
        setActiveRow()
      }

      if (msg.data.connectedToBitfinex) {
        updateStatus(`Bitfinex stream connected (${msg.data.symbol})`)
      } else {
        const provider = msg.data.provider || 'fallback'
        updateStatus(`Bitfinex blocked, fallback active: ${provider}`)
      }
    }

    if (msg.type === 'ticker' && msg.data) {
      const symbol = normalizeSymbol(msg.data.symbol || '')
      if (symbol === activeSymbol) {
        updateSelectedFromTicker(msg.data)
      }
      updateRowFromTicker(msg.data)
    }

    if (msg.type === 'error' && msg.data && msg.data.message) {
      updateStatus(`Stream error: ${msg.data.message}`)
    }
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault()
  const symbol = normalizeSymbol(inputEl.value)
  if (!symbol) {
    updateStatus('Invalid symbol. Example: BTC, ETH, SOL')
    return
  }

  selectSymbol(symbol, true)
  updateStatus(`Tracking ${symbol}...`)
})

inputEl.addEventListener('input', () => {
  const q = inputEl.value.trim()
  if (listTimer) clearTimeout(listTimer)
  listTimer = setTimeout(() => {
    fetchPriceList(q)
  }, 220)
})

healthBtnEl.addEventListener('click', () => {
  checkApiHealth()
})

selectedNameEl.textContent = 'Loading...'
selectedSymbolEl.textContent = activeSymbol
selectedPriceEl.textContent = '$-'
selectedChangeEl.textContent = '-'
selectedVolumeEl.textContent = '-'
selectedUpdatedEl.textContent = '-'

checkApiHealth()
fetchPriceList()
connect()
