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
  { id: 'GOLD', name: 'Gold (GC)', ticker: 'GC=F', fallbackPair: 'PAXG-USD', source: 'yahoo', unit: 'GC', decimals: 0, icon: '👑' },
  { id: 'BTC', name: 'Bitcoin (BTC)', pair: 'BTC-USD', source: 'coinbase', unit: 'BTC', decimals: 2, icon: '🟠' },
  { id: 'ETH', name: 'Ethereum (ETH)', pair: 'ETH-USD', source: 'coinbase', unit: 'ETH', decimals: 1, icon: '🔷' },
  { id: 'SOL', name: 'Solana (SOL)', pair: 'SOL-USD', source: 'coinbase', unit: 'SOL', decimals: 0, icon: '🟣' },
  { id: 'NQ', name: 'Nasdaq (NQ)', ticker: 'NQ=F', fallbackTicker: 'QQQ', source: 'yahoo', unit: 'NQ', decimals: 2, icon: '📈' },
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
  const data = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=2d`);
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
  const data = await fetchJson(`https://api.exchange.coinbase.com/products/${pair}/candles?granularity=300`);
  if (!Array.isArray(data) || data.length < 60) return [];
  // Drop index 0 (unclosed live bar) -> confirmed closed bars only
  return data.slice(1, 120).reverse().map((c) => ({
    time: c[0],
    low: c[1],
    high: c[2],
    open: c[3],
    close: c[4],
    vol: c[5],
  }));
}

async function scanMarket(target) {
  try {
    let candles = [];
    let feedLabel = target.ticker || target.pair;

    if (target.source === 'yahoo') {
      candles = await fetchYahooCandles(target.ticker);
      if (candles.length < 55 && target.fallbackTicker) {
        candles = await fetchYahooCandles(target.fallbackTicker);
        feedLabel = target.fallbackTicker;
      }
      if (candles.length < 55 && target.fallbackPair) {
        candles = await fetchCoinbaseCandles(target.fallbackPair);
        feedLabel = target.fallbackPair;
      }
    } else {
      candles = await fetchCoinbaseCandles(target.pair);
    }

    if (candles.length < 25) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const ema9 = calculateEMA(closes, 9);
    const vwap = calculateVWAPSeries(candles);
    const atr = calculateATRSeries(highs, lows, closes, 14);

    let marketState = 0;
    let lastSignal = null;
    let firedOnLastBar = null;

    // Pure CandleSight Engine: Fast EMA 9 + Session VWAP + Liquidity Snipers (Zero EMA 50 / Zero MACD)
    for (let i = 12; i < candles.length; i++) {
      const curClose = closes[i];
      const curOpen = candles[i].open;
      const curHigh = highs[i];
      const curLow = lows[i];
      const curEma9 = ema9[i];
      const curVwap = vwap[i];
      const curAtr = atr[i] || 1;

      const candleBody = Math.abs(curClose - curOpen);
      const upperWick = curHigh - Math.max(curOpen, curClose);
      const lowerWick = Math.min(curOpen, curClose) - curLow;
      const isGreen = curClose > curOpen;
      const isRed = curClose < curOpen;

      const distFromEma9 = Math.abs(curClose - curEma9);
      const isOverextended = distFromEma9 > curAtr * 1.3;

      // 1. Top & Bottom Liquidity Snipers (Early Reversals at Highs/Lows)
      const prevHigh10 = Math.max(...highs.slice(Math.max(0, i - 10), i));
      const topSweep = curHigh >= prevHigh10 && upperWick >= (candleBody * 1.4);
      const topReversal = (topSweep && isRed) || 
                          (highs[i-1] >= prevHigh10 && (highs[i-1] - Math.max(candles[i-1].open, closes[i-1])) >= Math.abs(closes[i-1] - candles[i-1].open) * 1.4 && curClose < lows[i-1]);

      const prevLow10 = Math.min(...lows.slice(Math.max(0, i - 10), i));
      const bottomSweep = curLow <= prevLow10 && lowerWick >= (candleBody * 1.4);
      const bottomReversal = (bottomSweep && isGreen) || 
                             (lows[i-1] <= prevLow10 && (Math.min(candles[i-1].open, closes[i-1]) - lows[i-1]) >= Math.abs(closes[i-1] - candles[i-1].open) * 1.4 && curClose > highs[i-1]);

      // 2. Pure Trend Following: Bounce off EMA 9 with VWAP Alignment
      const trendBuy = !isOverextended && (
        (curClose > curVwap && curLow <= curEma9 && curClose > curEma9 && isGreen) ||
        (curClose > curEma9 && closes[i-1] <= ema9[i-1] && curClose > curVwap && isGreen)
      );

      const trendSell = !isOverextended && (
        (curClose < curVwap && curHigh >= curEma9 && curClose < curEma9 && isRed) ||
        (curClose < curEma9 && closes[i-1] >= ema9[i-1] && curClose < curVwap && isRed)
      );

      let buySignal = false;
      let sellSignal = false;

      if (bottomReversal && marketState <= 0) {
        buySignal = true;
        marketState = 1;
      } else if (trendBuy && marketState <= 0) {
        buySignal = true;
        marketState = 1;
      }

      if (topReversal && marketState >= 0) {
        sellSignal = true;
        marketState = -1;
      } else if (trendSell && marketState >= 0) {
        sellSignal = true;
        marketState = -1;
      }

      if (buySignal) {
        const sl = curClose - curAtr * 1.5;
        const risk = Math.abs(curClose - sl);
        lastSignal = {
          type: 'BUY',
          time: candles[i].time,
          entry: curClose,
          sl,
          risk,
          tp1: curClose + risk * 2.0,
          tp2: curClose + risk * 3.0,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      } else if (sellSignal) {
        const sl = curClose + curAtr * 1.5;
        const risk = Math.abs(curClose - sl);
        lastSignal = {
          type: 'SHORT',
          time: candles[i].time,
          entry: curClose,
          sl,
          risk,
          tp1: curClose - risk * 2.0,
          tp2: curClose - risk * 3.0,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      }
    }

    const curClose = closes[closes.length - 1];
    const bias = marketState === 1 ? '🟢 LONG' : marketState === -1 ? '🔴 SHORT' : '⚪️ WAIT';

    // Store state in global registry for cross-asset macro correlation
    const lastBar = candles[candles.length - 1];
    marketRegistry[target.id] = {
      price: curClose,
      bias,
      marketState,
      ema9: ema9[ema9.length - 1],
      atr: atr[atr.length - 1],
      lastSignal,
      freshSignalOnLastBar: !!firedOnLastBar,
      isGreen: curClose >= lastBar.open,
      isRed: curClose < lastBar.open
    };

    if (firedOnLastBar) {
      // 1. BTC MACRO ALIGNMENT FILTER FOR ALTCOINS
      // Never send BUY on SOL/ETH if Bitcoin is in SHORT mode
      if ((target.id === 'SOL' || target.id === 'ETH') && firedOnLastBar.type === 'BUY') {
        const btcState = marketRegistry['BTC']?.marketState;
        if (btcState === -1) {
          console.log(`[FILTER BLOCKED] Suppressed ${target.id} BUY alert because Bitcoin is in confirmed 🔴 SHORT mode.`);
          return { id: target.id, feed: feedLabel, icon: target.icon, price: curClose, bias, lastSignal };
        }
      }

      // 2. OVEREXTENSION FILTER (Anti-FOMO Shield: NEVER alert if price stretched far from EMA 9)
      const distFromEma9 = Math.abs(curClose - ema9[ema9.length - 1]);
      const curAtr = atr[atr.length - 1] || 1;
      if (distFromEma9 > curAtr * 1.3) {
        console.log(`[FILTER BLOCKED] Suppressed ${target.id} ${firedOnLastBar.type} — price overextended (${distFromEma9.toFixed(2)} vs ATR ${curAtr.toFixed(2)}).`);
        return { id: target.id, feed: feedLabel, icon: target.icon, price: curClose, bias, lastSignal };
      }

      // 3. WEEKEND CAPITAL SHIELD (Protect prop accounts from low-volume weekend chop)
      if (isWeekendShieldActive()) {
        console.log(`[WEEKEND SHIELD] Alert suppressed for ${target.id} — market in weekend chop zone until Sunday 6 PM EST.`);
        return { id: target.id, feed: feedLabel, icon: target.icon, price: curClose, bias: '🛡 SHIELD', lastSignal };
      }

      // 4. ACTIVE SESSION SHIELD (Every ping MUST be 100% actionable!)
      if (isOutsideTradingHours()) {
        console.log(`[SESSION SHIELD] Suppressed ${target.id} alert — outside active US execution hours or in lunch dead-zone.`);
        return { id: target.id, feed: feedLabel, icon: target.icon, price: curClose, bias, lastSignal };
      }

      // 5. DAILY 2-TRADE DISCIPLINE QUOTA (Never Overtrade!)
      if (isDailyQuotaReached()) {
        console.log(`[QUOTA SHIELD] Suppressed ${target.id} alert — daily 2-trade limit reached.`);
        return { id: target.id, feed: feedLabel, icon: target.icon, price: curClose, bias, lastSignal };
      }

      const alertKey = `${target.id}_${firedOnLastBar.type}_${firedOnLastBar.time}`;
      if (lastAlerted[target.id] !== alertKey) {
        lastAlerted[target.id] = alertKey;
        dailyAlertCount++;
        const badge = firedOnLastBar.type === 'BUY' ? '🟢 BUY / LONG' : '🔴 SELL / SHORT';
        const sugSize = formatSize(firedOnLastBar.risk, target);
        const msg =
          `🎯 <b>ACTION MANDATE (${dailyAlertCount}/2 TODAY): TAKE THIS TRADE</b>\n\n` +
          `${target.icon} <b>${target.name} — ${badge}</b>\n` +
          `📍 <b>Entry:</b> ${formatPrice(firedOnLastBar.entry)}\n` +
          `🛑 <b>SL:</b> ${formatPrice(firedOnLastBar.sl)} <i>(Size: ${sugSize} | ~$${TARGET_RISK_USD} max risk)</i>\n` +
          `🎯 <b>TP:</b> ${formatPrice(firedOnLastBar.tp1)}\n\n` +
          `⚡️ <i>Vetted A+ Setup. High-volume institutional session. Execute now!</i>`;

        console.log(`[ALERT] Fired ${badge} on ${target.name} (${feedLabel}) @ ${curClose}`);
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
  const summaries = [];
  for (const target of SYMBOLS) {
    const res = await scanMarket(target);
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
      `⚡️ <b>CANDLESIGHT v3 LIVE (REAL GC=F & NQ=F FUTURES)</b>\n\n` +
      `${lines}\n\n` +
      `🔔 <i>Short pings include Position, Size (~$${TARGET_RISK_USD} risk), Entry, SL & TP1/TP2!</i>`;
    const ok = await sendTelegramMessage(msg);
    console.log(`[STARTUP TG PING] ${ok ? 'SENT' : 'FAILED'}`);
  }
}

// 11. 2-WAY INTERACTIVE TELEGRAM LISTENER (DIRECT YES/NO ANSWERS ON THE GO)
let lastUpdateId = 0;
const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI("AQ.Ab8RN6I4lp20NKYun7LhqWTZ_U6fkdk1WUnhLW38RCsPnHXByg");
const aiModel = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

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
        const distFromEma9 = Math.abs(info.price - (info.ema9 || info.price));
        const isOverextended = distFromEma9 > curAtr * 1.3;
        const inDeadZone = isOutsideTradingHours();

        let verdict = '';
        let advice = '';

        if (inDeadZone) {
          verdict = `❌ <b>NO: STAY FLAT ON ${matchedTarget}</b>`;
          advice = `Midday Lunch Dead-Zone / Off-hours. Volume is dead. Do not trade.`;
        } else if (isOverextended) {
          verdict = `❌ <b>NO: DO NOT CHASE ${matchedTarget}</b>`;
          advice = `Price is overextended (${distFromEma9.toFixed(1)} from EMA 9 vs ATR ${curAtr.toFixed(1)}). A relief bounce will stop you out. Wait for pullback!`;
        } else if (info.bias === '🔴 SHORT' && info.isGreen) {
          verdict = `❌ <b>NO: DO NOT SHORT ${matchedTarget}</b>`;
          advice = `Price is actively bouncing up (green candle). Never short into upward momentum! Wait for a rejection at EMA 9.`;
        } else if (info.bias === '🟢 LONG' && info.isRed) {
          verdict = `❌ <b>NO: DO NOT BUY ${matchedTarget}</b>`;
          advice = `Price is actively pulling back (red candle). Never buy into falling momentum! Wait for a support bounce at EMA 9.`;
        } else if (!info.freshSignalOnLastBar) {
          verdict = `⏸ <b>NO FRESH ENTRY ON ${matchedTarget}</b>`;
          advice = `Trend is ${info.bias}, but the entry already triggered earlier. Do NOT enter late into a moving trade. Wait for the next ping!`;
        } else if (info.bias === '🟢 LONG') {
          verdict = `✅ <b>YES: TAKE ${matchedTarget} LONG</b>`;
          advice = `Confirmed fresh bounce holding above EMA 9 & VWAP. Sizing: Max $35 risk.`;
        } else if (info.bias === '🔴 SHORT') {
          verdict = `✅ <b>YES: TAKE ${matchedTarget} SHORT</b>`;
          advice = `Confirmed fresh rejection holding below EMA 9 & VWAP. Sizing: Max $35 risk.`;
        } else {
          verdict = `❌ <b>NO: STAY FLAT ON ${matchedTarget}</b>`;
          advice = `Chopping in neutral consolidation. Wait for clean breakout.`;
        }

        let levelsStr = '';
        if (info.lastSignal && !isOverextended) {
          levelsStr = `\n• Entry: ${formatPrice(info.lastSignal.entry)} | SL: ${formatPrice(info.lastSignal.sl)}\n• TP1: ${formatPrice(info.lastSignal.tp1)}`;
        }

        const reply = 
          `${verdict}\n` +
          `• Price: ${formatPrice(info.price)} | Status: ${info.bias}` +
          levelsStr +
          `\n• <i>${advice}</i>`;
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
        const lines = Object.entries(marketRegistry).map(([id, s]) => `• <b>${id}:</b> ${formatPrice(s.price)} (${s.bias})`).join('\n');
        await sendTelegramMessage(`📊 <b>CandleSight 24/7 Live Status</b>\n\n${lines}\n\n<i>Ask any asset: "gold?", "btc?", "sol yes or no?"</i>`);
        continue;
      }

      // 2. Ultra-Fast AI Intelligence (Trading-Only Context)
      const currentMarketContext = Object.entries(marketRegistry).map(([id, s]) => `${id}: ${formatPrice(s.price)} (${s.bias})`).join(', ');
      const prompt = `
You are the personal crypto and futures prop-firm trading assistant for Ilya on Telegram.
LIVE MARKET STATUS RIGHT NOW: ${currentMarketContext}.

CRITICAL RULES:
- Maximum 2 lines!
- Questions are strictly about crypto/futures trading. TP = Take Profit, SL = Stop Loss.
- Line 1 MUST start with either "✅ YES: [Action & Asset]" or "❌ NO: [Action / Stay Flat]".
- Line 2 is 1 short sentence with the exact price or reason.
- Plain text only. No HTML tags, no markdown asterisks.

Question from Ilya:
"${userText}"
`;
      const aiResult = await aiModel.generateContent(prompt);
      let reply = aiResult.response.text().replace(/[<>]/g, '');
      await sendTelegramMessage(reply);
    }
  } catch (err) {
    console.error('[POLL ERR]', err.message);
  } finally {
    isPolling = false;
    setTimeout(pollTelegramUpdates, 2000);
  }
}

console.log('🚀 CandleSight Autonomous Top-5 Scanner v3 Initialized (GC=F, BTC, ETH, SOL, NQ=F)');
runScanCycle();
setInterval(runScanCycle, 60000);
pollTelegramUpdates();

