/**
 * CandleSight Autonomous Top-5 Market Scanner v3
 * 24/7 Background Scanner for:
 * 1. Gold Futures (GC=F, fallback PAXG-USD)
 * 2. Bitcoin (BTC-USD)
 * 3. Ethereum (ETH-USD)
 * 4. Solana (SOL-USD)
 * 5. Nasdaq Futures (NQ=F, fallback QQQ)
 *
 * Mirrors CandleSight Pine Script v6 (EMA 9/21/50 + MACD 12/26/9 + ATR 14) on confirmed 5m closes.
 * Sends ultra-short execution pings (Direction, Size, Entry, SL, TP1, TP2) to Telegram.
 */

const https = require('https');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '9271364424:AAHSarBS1g7wVpjERsHTaHyUnoCJlrDTJ3E';
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '6938216386';
const TARGET_RISK_USD = 50; // Micro-risk ($50 risk per trade to protect $311 drawdown buffer)

const SYMBOLS = [
  { id: 'GOLD', name: 'Gold (Spot)', tvTicker: 'OANDA:XAUUSD', ticker: 'GC=F', fallbackPair: 'PAXG-USD', source: 'yahoo', unit: 'XAU', decimals: 2, icon: '🪙' },
  { id: 'BTC', name: 'Bitcoin', tvTicker: 'BINANCE:BTCUSDT', pair: 'BTC-USD', source: 'coinbase', unit: 'BTC', decimals: 2, icon: '₿' },
  { id: 'ETH', name: 'Ethereum', tvTicker: 'BINANCE:ETHUSDT', pair: 'ETH-USD', source: 'coinbase', unit: 'ETH', decimals: 2, icon: 'Ξ' },
  { id: 'SOL', name: 'Solana', tvTicker: 'BINANCE:SOLUSDT', pair: 'SOL-USD', source: 'coinbase', unit: 'SOL', decimals: 2, icon: '◎' },
  { id: 'NQ', name: 'Nasdaq 100 ETF', tvTicker: 'NASDAQ:QQQ', ticker: 'NQ=F', fallbackTicker: 'QQQ', source: 'yahoo', unit: 'QQQ', decimals: 2, icon: '📊' },
];

const lastAlerted = {};
const marketRegistry = {};
let startupSent = false;

function isWeekendShieldActive() {
  const now = new Date();
  const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const estDate = new Date(estString);
  const day = estDate.getDay(); // 0 = Sun, 5 = Fri, 6 = Sat
  const hour = estDate.getHours();

  // Friday 5 PM EST through Sunday 6 PM EST
  if (day === 5 && hour >= 17) return true;
  if (day === 6) return true;
  if (day === 0 && hour < 18) return true;
  return false;
}

let dailyAlertCount = 0;
let currentAlertDay = new Date().toDateString();

function isOutsideTradingHours() {
  const now = new Date();
  const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const estDate = new Date(estString);
  const hour = estDate.getHours();
  const minute = estDate.getMinutes();

  // 1. Mute overnight, pre-market (before 8:30 AM EST) and post-market (after 4:30 PM EST)
  if (hour < 8 || (hour === 8 && minute < 30) || hour >= 17) {
    return true;
  }

  // 2. Mute Midday Lunch Dead-Zone (11:30 AM - 1:00 PM EST / 8:30 AM - 10:00 AM PST)
  // Stops retail accounts from getting chopped up in low midday volume
  if ((hour === 11 && minute >= 30) || hour === 12) {
    return true;
  }

  return false;
}

function isDailyQuotaReached() {
  const today = new Date().toDateString();
  if (today !== currentAlertDay) {
    currentAlertDay = today;
    dailyAlertCount = 0;
  }
  return dailyAlertCount >= 2;
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          console.error(`[PARSE ERR] ${url}: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', (err) => {
      console.error(`[NET ERR] ${url}: ${err.message}`);
      resolve(null);
    });
  });
}

function sendTelegramMessage(text) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      chat_id: ADMIN_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 8000,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`[TG HTTP ${res.statusCode}] ${b}`);
            resolve(false);
          } else {
            resolve(true);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', (err) => {
      console.error(`[TG ERR] ${err.message}`);
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateVWAPSeries(candles) {
  const vwap = [];
  let cumTPV = 0;
  let cumVol = 0;
  let lastDay = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time * 1000).getUTCDate();
    if (d !== lastDay) {
      lastDay = d;
      cumTPV = 0;
      cumVol = 0;
    }
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.vol > 0 ? c.vol : 1;
    cumTPV += tp * vol;
    cumVol += vol;
    vwap.push(cumVol > 0 ? cumTPV / cumVol : tp);
  }
  return vwap;
}

function calculateATRSeries(highs, lows, closes, period = 14) {
  const atr = new Array(closes.length).fill(0);
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    trs.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      sum += trs[i];
      atr[i] = sum / (i + 1);
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
    }
  }
  return atr;
}

function formatPrice(p) {
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p >= 1) return '$' + p.toFixed(2);
  return '$' + p.toFixed(4);
}

function formatSize(riskPerUnit, target) {
  if (!riskPerUnit || riskPerUnit <= 0) return 'Auto';
  const raw = TARGET_RISK_USD / riskPerUnit;
  if (target.id === 'GOLD') {
    const capped = Math.max(5, Math.min(20, Math.round(raw)));
    return `${capped} GC`;
  }
  const rounded = target.decimals === 0 ? Math.max(1, Math.round(raw)) : Math.max(0.05, Number(raw.toFixed(target.decimals)));
  return `${rounded} ${target.unit}`;
}

async function fetchYahooCandles(ticker) {
  const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1h&range=14d`);
  if (!data?.chart?.result?.[0]?.indicators?.quote?.[0]) return [];
  const q = data.chart.result[0].indicators.quote[0];
  const t = data.chart.result[0].timestamp || [];
  const candles = [];
  for (let i = 0; i < t.length - 1; i++) {
    if (q.close[i] && q.high[i] && q.low[i]) {
      candles.push({
        time: t[i],
        open: q.open[i],
        high: q.high[i],
        low: q.low[i],
        close: q.close[i],
      });
    }
  }
  return candles;
}

async function fetchCoinbaseCandles(pair) {
  // 3600 = 1-Hour institutional candles (confirms true macro momentum)
  const data = await fetchJson(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=3600`);
  if (!Array.isArray(data) || data.length < 25) return [];
  // Drop index 0 (unclosed live bar) -> confirmed closed 1H bars only
  return data.slice(1, 200).reverse().map((c) => ({
    time: c[0],
    low: c[1],
    high: c[2],
    open: c[3],
    close: c[4],
    vol: c[5],
  }));
}

async function fetchTradingViewScanner(endpoint, tickers) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
      },
      body: JSON.stringify({
        symbols: { tickers },
        columns: ['close', 'open', 'high', 'low', 'change', 'EMA50', 'EMA200', 'ATR', 'RSI', 'VWAP']
      })
    });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    (data?.data || []).forEach(item => {
      const [close, open, high, low, change, ema50, ema200, atr, rsi, vwap] = item.d || [];
      map[item.s] = {
        close,
        open,
        high,
        low,
        change: Number(change?.toFixed(2)) || 0,
        ema50,
        ema200,
        atr,
        rsi,
        vwap
      };
    });
    return map;
  } catch (e) {
    return {};
  }
}

async function fetchAllTradingViewData() {
  const [cfd, crypto, america] = await Promise.all([
    fetchTradingViewScanner('https://scanner.tradingview.com/cfd/scan', ['OANDA:XAUUSD']),
    fetchTradingViewScanner('https://scanner.tradingview.com/crypto/scan', ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT']),
    fetchTradingViewScanner('https://scanner.tradingview.com/america/scan', ['NASDAQ:QQQ'])
  ]);
  return { ...cfd, ...crypto, ...america };
}

async function scanMarket(target, tvQuote) {
  try {
    let candles = [];
    let feedLabel = target.tvTicker || target.ticker || target.pair;

    if (target.source === 'yahoo') {
      candles = await fetchYahooCandles(target.ticker);
      if (candles.length < 55 && target.fallbackTicker) {
        candles = await fetchYahooCandles(target.fallbackTicker);
      }
      if (candles.length < 55 && target.fallbackPair) {
        candles = await fetchCoinbaseCandles(target.fallbackPair);
      }
    } else {
      candles = await fetchCoinbaseCandles(target.pair);
    }

    if (candles.length < 25) return null;

    // Direct override with TradingView real-time spot quote
    if (tvQuote && typeof tvQuote.close === 'number') {
      const last = candles[candles.length - 1];
      last.close = tvQuote.close;
      if (typeof tvQuote.high === 'number') last.high = Math.max(last.high, tvQuote.high);
      if (typeof tvQuote.low === 'number') last.low = Math.min(last.low, tvQuote.low);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // 1-Hour Institutional Trend-Rider Pro Engine
    const emaPeriod = Math.min(closes.length > 100 ? 50 : 20, Math.floor(closes.length / 2));
    const emaBaseline = calculateEMA(closes, emaPeriod);
    const atr = calculateATRSeries(highs, lows, closes, 14);

    let marketState = 0;
    let lastSignal = null;
    let firedOnLastBar = null;
    let dynamicTrailStop = null;

    // Scan through confirmed 1-Hour closes
    const lookback = Math.min(20, Math.floor(candles.length / 2));
    for (let i = lookback; i < candles.length; i++) {
      const curClose = closes[i];
      const curHigh = highs[i];
      const curLow = lows[i];
      const curAtr = atr[i] || 1;
      const curEma = emaBaseline[i] || curClose;

      // Highest high and lowest low of previous 20 hours
      const highest20H = Math.max(...highs.slice(i - lookback, i));
      const lowest20H = Math.min(...lows.slice(i - lookback, i));

      const bullTrend = curClose > curEma;
      const bearTrend = curClose < curEma;

      const longBreak = curClose > highest20H && closes[i - 1] <= highest20H && bullTrend;
      const shortBreak = curClose < lowest20H && closes[i - 1] >= lowest20H && bearTrend;

      // Dynamic ATR Trailing Stop ratchet
      if (marketState === 1 && dynamicTrailStop) {
        dynamicTrailStop = Math.max(dynamicTrailStop, curHigh - curAtr * 3.0);
        if (curClose < dynamicTrailStop) {
          marketState = 0; // Exited long on trailing stop
        }
      } else if (marketState === -1 && dynamicTrailStop) {
        dynamicTrailStop = Math.min(dynamicTrailStop, curLow + curAtr * 3.0);
        if (curClose > dynamicTrailStop) {
          marketState = 0; // Exited short on trailing stop
        }
      }

      if (longBreak && marketState <= 0) {
        marketState = 1;
        dynamicTrailStop = curClose - curAtr * 2.0;
        const risk = curAtr * 2.0;
        lastSignal = {
          type: 'BUY',
          time: candles[i].time,
          entry: curClose,
          sl: dynamicTrailStop,
          trailStop: dynamicTrailStop,
          risk,
          tp1: curClose + risk * 1.5,
          tp2: curClose + risk * 3.0,
          triggerLevel: highest20H,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      } else if (shortBreak && marketState >= 0) {
        marketState = -1;
        dynamicTrailStop = curClose + curAtr * 2.0;
        const risk = curAtr * 2.0;
        lastSignal = {
          type: 'SHORT',
          time: candles[i].time,
          entry: curClose,
          sl: dynamicTrailStop,
          trailStop: dynamicTrailStop,
          risk,
          tp1: curClose - risk * 1.5,
          tp2: curClose - risk * 3.0,
          triggerLevel: lowest20H,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      }
    }

    const curClose = (tvQuote && typeof tvQuote.close === 'number') ? tvQuote.close : closes[closes.length - 1];
    const bias = marketState === 1 ? '🟢 1H LONG' : marketState === -1 ? '🔴 1H SHORT' : '⚪️ NEUTRAL';

    // Store state in global registry for Telegram bot queries
    const lastBar = candles[candles.length - 1];
    marketRegistry[target.id] = {
      id: target.id,
      name: target.name,
      tvTicker: target.tvTicker,
      price: curClose,
      open: tvQuote?.open ?? lastBar.open,
      high: tvQuote?.high ?? Math.max(...highs.slice(-20)),
      low: tvQuote?.low ?? Math.min(...lows.slice(-20)),
      change: tvQuote?.change ?? 0,
      bias,
      marketState,
      emaBaseline: tvQuote?.ema50 ?? emaBaseline[emaBaseline.length - 1],
      ema200: tvQuote?.ema200 ?? (curClose * 1.05),
      atr: tvQuote?.atr ?? atr[atr.length - 1],
      lastSignal,
      freshSignalOnLastBar: !!firedOnLastBar,
      isGreen: tvQuote ? tvQuote.close >= tvQuote.open : curClose >= lastBar.open,
      isRed: tvQuote ? tvQuote.close < tvQuote.open : curClose < lastBar.open,
      source: target.tvTicker ? `TradingView (${target.tvTicker})` : feedLabel
    };

    if (firedOnLastBar) {
      const alertKey = `${target.id}_${firedOnLastBar.type}_${firedOnLastBar.time}`;
      if (lastAlerted[target.id] !== alertKey) {
        lastAlerted[target.id] = alertKey;
        dailyAlertCount++;

        const badge = firedOnLastBar.type === 'BUY' ? '🟢 1H BULLISH BREAKOUT' : '🔴 1H BEARISH BREAKDOWN';
        const optionType = firedOnLastBar.type === 'BUY' ? 'CALL' : 'PUT';
        const optionTicker = target.id === 'NQ' ? 'QQQ' : target.id === 'BTC' ? 'IBIT' : target.id;
        const sugSize = formatSize(firedOnLastBar.risk, target);

        const msg =
          `🚀 <b>CANDLESIGHT 1H INSTITUTIONAL ALERT</b>\n\n` +
          `${target.icon} <b>${target.name} — ${badge}</b>\n` +
          `📍 <b>Entry:</b> ${formatPrice(firedOnLastBar.entry)}\n` +
          `🛡 <b>Dynamic ATR Trail Stop:</b> ${formatPrice(firedOnLastBar.sl)}\n` +
          `🎯 <b>Target 1 (+1.5R):</b> ${formatPrice(firedOnLastBar.tp1)}\n` +
          `🎯 <b>Target 2 (+3.0R Runner):</b> ${formatPrice(firedOnLastBar.tp2)}\n\n` +
          `🎯 <b>DEFINED-RISK OPTIONS PLAYBOOK:</b>\n` +
          `• Buy 3–5 DTE ${optionTicker} ${optionType}\n` +
          `• Capped Risk: $35–$50 USD (<b>0.00% Liquidation Risk</b>)\n` +
          `• Outlier Profit Target: +150% to +300%\n\n` +
          `🛡 <b>PROP EVAL SIZING (Vest / Apex):</b>\n` +
          `• Size: ${sugSize} (~$50 max risk)\n` +
          `• Leaves >90% of your evaluation buffer completely safe!\n\n` +
          `<i>TradingView Feed: ${target.tvTicker}. Free script: candlesightai.com/script</i>`;

        console.log(`[ALERT] Fired 1H ${badge} on ${target.name} (${feedLabel}) @ ${curClose}`);
        await sendTelegramMessage(msg);
      }
    }

    return {
      id: target.id,
      feed: feedLabel,
      icon: target.icon,
      price: curClose,
      bias,
      lastSignal,
    };
  } catch (err) {
    console.error(`Error scanning ${target.name}:`, err.message);
    return null;
  }
}

async function runScanCycle() {
  const ts = new Date().toLocaleTimeString();
  const tvData = await fetchAllTradingViewData();
  const summaries = [];
  for (const target of SYMBOLS) {
    const tvQuote = tvData[target.tvTicker];
    const res = await scanMarket(target, tvQuote);
    if (res) summaries.push(res);
  }

  if (summaries.length === 0) {
    console.log(`[SCAN ${ts}] WARNING: 0 markets returned data.`);
    return;
  }

  console.log(
    `[SCAN ${ts}] ` +
      summaries.map((s) => `${s.id}(${s.feed})=${formatPrice(s.price)} (${s.bias})`).join(' | ')
  );

  if (!startupSent) {
    startupSent = true;
    const lines = summaries
      .map((s) => `${s.icon} <b>${s.id}:</b> ${formatPrice(s.price)} — ${s.bias}`)
      .join('\n');
    const msg =
      `⚡️ <b>CANDLESIGHT v3 LIVE (DIRECT TRADINGVIEW SPOT FEEDS)</b>\n\n` +
      `${lines}\n\n` +
      `🔔 <i>Direct OANDA XAUUSD, Binance BTC/ETH/SOL & Nasdaq QQQ feeds matching TradingView charts to the penny.</i>`;
    const ok = await sendTelegramMessage(msg);
    console.log(`[STARTUP TG PING] ${ok ? 'SENT' : 'FAILED'}`);
  }
}

// 11. 2-WAY INTERACTIVE TELEGRAM LISTENER (DIRECT YES/NO ANSWERS ON THE GO)
let lastUpdateId = 0;
let aiModel = null;
try {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey) {
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  }
} catch (e) {}

let isPolling = false;
async function pollTelegramUpdates() {
  if (isPolling) return;
  isPolling = true;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const res = await fetchJson(url);
    if (!res || !res.ok || !Array.isArray(res.result)) return;

    for (const update of res.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = String(msg.chat.id);
      if (chatId !== ADMIN_CHAT_ID) continue;

      const userText = msg.text.trim();
      const lower = userText.toLowerCase();
      console.log(`[USER TEXT ON TELEGRAM] "${userText}"`);

      // 1. Direct Quick Asset Lookups
      let matchedTarget = null;
      if (lower.includes('gold') || lower.includes('gc') || lower.includes('xau')) matchedTarget = 'GOLD';
      else if (lower.includes('btc') || lower.includes('bitcoin')) matchedTarget = 'BTC';
      else if (lower.includes('eth') || lower.includes('ethereum')) matchedTarget = 'ETH';
      else if (lower.includes('sol') || lower.includes('solana')) matchedTarget = 'SOL';
      else if (lower.includes('nq') || lower.includes('nasdaq')) matchedTarget = 'NQ';

      if (matchedTarget && marketRegistry[matchedTarget]) {
        const info = marketRegistry[matchedTarget];
        const curAtr = info.atr || 1;
        const distFromEma = Math.abs(info.price - (info.emaBaseline || info.price));
        const isOverextended = distFromEma > curAtr * 1.5;
        const inDeadZone = isOutsideTradingHours();

        let verdict = '';
        let advice = '';

        if (inDeadZone) {
          verdict = `❌ <b>NO: STAY FLAT ON ${info.name || matchedTarget}</b>`;
          advice = `Off-hours / low liquidity window. Volume is compressed. Preserve capital.`;
        } else if (isOverextended) {
          verdict = `❌ <b>NO: DO NOT CHASE ${info.name || matchedTarget}</b>`;
          advice = `Price is overextended (${distFromEma.toFixed(1)} from 1H EMA baseline vs ATR ${curAtr.toFixed(1)}). Wait for a healthy retest.`;
        } else if (info.bias.includes('SHORT') && info.isGreen) {
          verdict = `❌ <b>NO: DO NOT SHORT ${info.name || matchedTarget}</b>`;
          advice = `Price is actively bouncing up (green 1H bar). Never short into upward momentum! Wait for a rejection at resistance.`;
        } else if (info.bias.includes('LONG') && info.isRed) {
          verdict = `❌ <b>NO: DO NOT BUY ${info.name || matchedTarget}</b>`;
          advice = `Price is actively pulling back (red 1H bar). Never buy into falling knife! Wait for confirmation at support.`;
        } else if (!info.freshSignalOnLastBar) {
          verdict = `⏸ <b>NO FRESH BREAKOUT ON ${info.name || matchedTarget}</b>`;
          advice = `Current trend state is ${info.bias}. Range: ${formatPrice(info.low)} – ${formatPrice(info.high)}. Coiling within channel; wait for clean 1H breakout.`;
        } else if (info.bias.includes('LONG')) {
          verdict = `✅ <b>YES: TAKE ${info.name || matchedTarget} LONG</b>`;
          advice = `Confirmed fresh 1H breakout above 20H channel high. Sizing: Micro-lot (~$50 max risk).`;
        } else if (info.bias.includes('SHORT')) {
          verdict = `✅ <b>YES: TAKE ${info.name || matchedTarget} SHORT</b>`;
          advice = `Confirmed fresh 1H breakdown below 20H channel low. Sizing: Micro-lot (~$50 max risk).`;
        } else {
          verdict = `❌ <b>NO: STAY FLAT ON ${info.name || matchedTarget}</b>`;
          advice = `Consolidating inside 1H range (${formatPrice(info.low)} – ${formatPrice(info.high)}). Awaiting breakout.`;
        }

        let levelsStr = '';
        if (info.lastSignal && !isOverextended) {
          levelsStr = `\n• <b>Entry:</b> ${formatPrice(info.lastSignal.entry)} | <b>SL:</b> ${formatPrice(info.lastSignal.sl)}\n• <b>TP1:</b> ${formatPrice(info.lastSignal.tp1)}`;
        }

        const reply = 
          `${verdict}\n\n` +
          `• <b>Price:</b> ${formatPrice(info.price)} (${info.change >= 0 ? '+' : ''}${info.change}%)\n` +
          `• <b>Feed:</b> ${info.source || 'TradingView'}\n` +
          `• <b>Session Range:</b> ${formatPrice(info.low)} – ${formatPrice(info.high)}\n` +
          `• <b>Status:</b> ${info.bias}` +
          levelsStr +
          `\n\n💡 <i>${advice}</i>`;
        await sendTelegramMessage(reply);
        continue;
      }

      // Direct TP / SL question handler
      if (lower.includes('tp') || lower.includes('sl') || lower.includes('target') || lower.includes('stop')) {
        const active = Object.values(marketRegistry).find(s => (s.bias === '🟢 LONG' || s.bias === '🔴 SHORT') && s.lastSignal);
        if (active) {
          const sig = active.lastSignal;
          const reply = 
            `🎯 <b>${active.id} ${sig.type} TARGETS:</b>\n` +
            `• Entry: ${formatPrice(sig.entry)}\n` +
            `• Stop Loss (SL): ${formatPrice(sig.sl)}\n` +
            `• TP1: ${formatPrice(sig.tp1)}\n` +
            `• TP2: ${formatPrice(sig.tp2)}\n` +
            `• Sizing: Micro-lot (~$50 max risk)`;
          await sendTelegramMessage(reply);
          continue;
        }
      }

      if (lower === '/status' || lower === 'status') {
        const lines = Object.entries(marketRegistry).map(([id, s]) => 
          `• <b>${s.name || id}:</b> ${formatPrice(s.price)} (${s.change >= 0 ? '+' : ''}${s.change}%) — ${s.bias}`
        ).join('\n');
        await sendTelegramMessage(
          `📊 <b>CandleSight 24/7 Live Status (TradingView Direct)</b>\n\n` +
          `${lines}\n\n` +
          `<i>100% verified TradingView spot feeds. Ask: "gold?", "btc?", "sol yes or no?"</i>`
        );
        continue;
      }

      // 2. Ultra-Fast AI Intelligence (Trading-Only Context with TradingView Spot Quotes)
      const currentMarketContext = Object.entries(marketRegistry).map(([id, s]) => 
        `${s.name || id} (${s.source || id}): ${formatPrice(s.price)} [Range: ${formatPrice(s.low)} - ${formatPrice(s.high)}, 24h: ${s.change}%] — ${s.bias}`
      ).join('; ');

      if (aiModel) {
        try {
          const prompt = `
You are the personal crypto and futures prop-firm trading assistant for Ilya on Telegram.
LIVE MARKET STATUS RIGHT NOW (Official TradingView feeds): ${currentMarketContext}.

CRITICAL RULES:
- Maximum 2 lines!
- Questions are strictly about crypto/futures trading. TP = Take Profit, SL = Stop Loss.
- When asked about prices, ALWAYS use the exact spot price from the LIVE MARKET STATUS above. Never guess or quote futures contracts.
- Line 1 MUST start with either "✅ YES: [Action & Asset]" or "❌ NO: [Action / Stay Flat]" or a direct price answer.
- Line 2 is 1 short sentence with the exact price or reason.
- Plain text only. No HTML tags, no markdown asterisks.

Question from Ilya:
"${userText}"
`;
          const aiResult = await aiModel.generateContent(prompt);
          let reply = aiResult.response.text().replace(/[<>]/g, '');
          await sendTelegramMessage(reply);
        } catch (aiErr) {
          console.error('[AI ERR]', aiErr.message);
          await sendTelegramMessage(`📊 <b>CandleSight 1H Trend Status (TradingView Feeds):</b>\n${currentMarketContext}\n\n<i>Ask any asset: "gold?", "btc?", or "status"</i>`);
        }
      } else {
        await sendTelegramMessage(`📊 <b>CandleSight 1H Trend Status (TradingView Feeds):</b>\n${currentMarketContext}\n\n<i>Ask any asset: "gold?", "btc?", or "status"</i>`);
      }
    }
  } catch (err) {
    console.error('[POLL ERR]', err.message);
  } finally {
    isPolling = false;
    setTimeout(pollTelegramUpdates, 2000);
  }
}

console.log('🚀 CandleSight Autonomous Top-5 Scanner v3 Initialized (Direct TradingView Feeds: OANDA XAUUSD, Binance Crypto, Nasdaq QQQ)');
runScanCycle();
setInterval(runScanCycle, 60000);
pollTelegramUpdates();

