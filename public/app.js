const tableBodyElement = document.getElementById('table-body');
const statsElement = document.getElementById('stats');
const lastUpdateElement = document.getElementById('last-update');

const numberFA = new Intl.NumberFormat('fa-IR');
const compactNumberFA = new Intl.NumberFormat('fa-IR', {
  notation: 'compact',
  maximumFractionDigits: 2
});
const compactUsdFA = new Intl.NumberFormat('fa-IR', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2
});

const previousPrices = new Map();
const priceHistory = new Map();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function priceFormatter(value) {
  const maxFractionDigits = value >= 1000 ? 2 : value >= 1 ? 4 : 8;
  return new Intl.NumberFormat('fa-IR', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: maxFractionDigits
  }).format(value);
}

function percentText(value) {
  const abs = Math.abs(value).toFixed(2);
  if (value > 0) {
    return `+${abs}%`;
  }
  if (value < 0) {
    return `-${abs}%`;
  }
  return `${abs}%`;
}

function percentClass(value) {
  if (value > 0) {
    return 'positive';
  }
  if (value < 0) {
    return 'negative';
  }
  return '';
}

function getRowMoveClass(coinId, currentPrice) {
  const previous = previousPrices.get(coinId);
  previousPrices.set(coinId, currentPrice);

  if (previous === undefined || previous === currentPrice) {
    return '';
  }

  return currentPrice > previous ? 'row-up' : 'row-down';
}

function updateSparkHistory(coinId, currentPrice) {
  const history = priceHistory.get(coinId) || [];
  history.push(currentPrice);

  if (history.length > 42) {
    history.shift();
  }

  priceHistory.set(coinId, history);
  return history;
}

function sparklineSvg(values) {
  const list = values.length > 1 ? values : [values[0] || 0, values[0] || 0];
  const min = Math.min(...list);
  const max = Math.max(...list);
  const range = max - min || 1;

  const points = list
    .map((value, index) => {
      const x = (index / (list.length - 1)) * 120;
      const y = 32 - ((value - min) / range) * 28;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const trendClass = list[list.length - 1] >= list[0] ? 'up' : 'down';

  return `
    <svg class="sparkline ${trendClass}" viewBox="0 0 120 34" aria-hidden="true">
      <polyline points="${points}"></polyline>
    </svg>
  `;
}

function supplyProgress(coin) {
  if (!coin.maxSupply || coin.maxSupply <= 0) {
    return null;
  }

  const percent = (coin.circulatingSupply / coin.maxSupply) * 100;
  return Math.max(0, Math.min(100, percent));
}

function renderStats(data) {
  const totalMarketCap = data.reduce((sum, coin) => sum + coin.marketCap, 0);
  const totalVolume = data.reduce((sum, coin) => sum + coin.volume24h, 0);
  const gainers = data.filter((coin) => coin.change24h > 0).length;
  const averageDayMove = data.reduce((sum, coin) => sum + coin.change24h, 0) / (data.length || 1);

  statsElement.innerHTML = `
    <article class="stat-card">
      <span>ارزش بازار کل (لیست فعلی)</span>
      <strong>${compactUsdFA.format(totalMarketCap)}</strong>
    </article>
    <article class="stat-card">
      <span>حجم معاملات ۲۴ ساعته</span>
      <strong>${compactUsdFA.format(totalVolume)}</strong>
    </article>
    <article class="stat-card">
      <span>تعداد ارزهای مثبت (۲۴ ساعت)</span>
      <strong>${numberFA.format(gainers)} از ${numberFA.format(data.length)}</strong>
    </article>
    <article class="stat-card">
      <span>میانگین تغییر ۲۴ ساعت</span>
      <strong class="${percentClass(averageDayMove)}">${percentText(averageDayMove)}</strong>
    </article>
  `;
}

function renderRows(data) {
  tableBodyElement.innerHTML = data
    .map((coin) => {
      const safeName = escapeHtml(coin.name);
      const safeSymbol = escapeHtml(coin.symbol);
      const safeLogoId = encodeURIComponent(coin.id);
      const moveClass = getRowMoveClass(coin.id, coin.price);
      const spark = sparklineSvg(updateSparkHistory(coin.id, coin.price));
      const progress = supplyProgress(coin);
      const volumeInCoin = coin.price > 0 ? coin.volume24h / coin.price : 0;

      return `
        <tr class="${moveClass}">
          <td class="star-cell"><button class="star-btn" type="button" aria-label="نشان کردن">☆</button></td>
          <td class="rank-cell">${numberFA.format(coin.rank)}</td>
          <td>
            <div class="name-cell">
              <span class="logo-wrap">
                <img src="https://static.coinpaprika.com/coin/${safeLogoId}/logo.png" alt="${safeName}" loading="lazy" onerror="this.remove()" />
                <span class="logo-fallback">${safeSymbol.slice(0, 1)}</span>
              </span>
              <div class="coin-text">
                <strong>${safeName}</strong>
                <span>${safeSymbol}</span>
              </div>
            </div>
          </td>
          <td class="price-cell">${priceFormatter(coin.price)}</td>
          <td class="${percentClass(coin.change1h)}">${percentText(coin.change1h)}</td>
          <td class="${percentClass(coin.change24h)}">${percentText(coin.change24h)}</td>
          <td class="hide-md ${percentClass(coin.change7d)}">${percentText(coin.change7d)}</td>
          <td class="market-cap">${compactUsdFA.format(coin.marketCap)}</td>
          <td class="volume-cell hide-lg">
            ${compactUsdFA.format(coin.volume24h)}
            <small>${compactNumberFA.format(volumeInCoin)} ${safeSymbol}</small>
          </td>
          <td class="supply-cell">
            ${compactNumberFA.format(coin.circulatingSupply)} ${safeSymbol}
            ${
              progress === null
                ? '<small>حداکثر عرضه مشخص نیست</small>'
                : `<div class="supply-bar"><span style="width:${progress.toFixed(2)}%"></span></div>`
            }
          </td>
          <td class="spark-cell hide-md">${spark}</td>
        </tr>
      `;
    })
    .join('');
}

async function loadData() {
  try {
    const response = await fetch('/api/prices');

    if (!response.ok) {
      throw new Error('پاسخ نامعتبر از سرور');
    }

    const data = await response.json();
    renderStats(data);
    renderRows(data);
    lastUpdateElement.textContent = new Date().toLocaleTimeString('fa-IR');
  } catch (error) {
    tableBodyElement.innerHTML =
      '<tr><td class="error-cell" colspan="11">خطا در دریافت داده‌ها. دریافت دوباره به‌صورت خودکار انجام می‌شود.</td></tr>';
  }
}

loadData();
setInterval(loadData, 1000);
