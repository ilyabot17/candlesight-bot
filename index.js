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

function fetchJson(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers }, timeout: 10000 }, (res) => {
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
    }).on('error', (err) => {
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
        timeout: 10000,
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

function calculateMACDSeries(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12.map((val, idx) => val - ema26[idx]);
  const signalLine = calculateEMA(macdLine, 9);
  return { macdLine, signalLine };
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

    if (candles.length < 55) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const { macdLine, signalLine } = calculateMACDSeries(closes);
    const atr = calculateATRSeries(highs, lows, closes, 14);

    // Replay Pine v6 state machine across historical confirmed bars
    let marketState = 0;
    let lastSignal = null;
    let firedOnLastBar = null;

    for (let i = 50; i < candles.length; i++) {
      // 1. EMA 50 Slope Filter (Blocks counter-trend bounces in strong trends)
      const ema50Slope = ema50[i] - ema50[i - 3];
      const bullSlope = ema50Slope >= -(atr[i] * 0.05); // Cannot be sloping hard downward
      const bearSlope = ema50Slope <= (atr[i] * 0.05);  // Cannot be sloping hard upward

      // 2. Ribbon Separation Filter (Chop Killer — eliminates flat criss-crosses)
      const ribbonSpread = Math.abs(ema9[i] - ema21[i]);
      const minSpread = (atr[i] || 1) * 0.18;
      const hasMomentumSpread = ribbonSpread >= minSpread;

      // 3. Decisive Candle Body Filter (Anti-Wick Shield)
      const candleRange = highs[i] - lows[i];
      const candleBody = Math.abs(closes[i] - candles[i].open);
      const isSolidBody = candleRange === 0 || (candleBody / candleRange >= 0.35);
      const isGreenClose = closes[i] > candles[i].open;
      const isRedClose = closes[i] < candles[i].open;

      // STRICT INSTITUTIONAL 3-WAY CONFLUENCE (No unconfirmed breakout bypasses)
      const bullTrend = closes[i] > ema50[i] && ema9[i] > ema21[i] && macdLine[i] >= signalLine[i] && bullSlope && hasMomentumSpread;
      const freshBuyTrigger = ((ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) || 
                               (macdLine[i - 1] <= signalLine[i - 1] && macdLine[i] > signalLine[i]) ||
                               (closes[i - 1] <= ema50[i - 1] && closes[i] > ema50[i])) && isGreenClose && isSolidBody;
      const buyEntry = bullTrend && freshBuyTrigger;

      const bearTrend = closes[i] < ema50[i] && ema9[i] < ema21[i] && macdLine[i] <= signalLine[i] && bearSlope && hasMomentumSpread;
      const freshSellTrigger = ((ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) || 
                                (macdLine[i - 1] >= signalLine[i - 1] && macdLine[i] < signalLine[i]) ||
                                (closes[i - 1] >= ema50[i - 1] && closes[i] < ema50[i])) && isRedClose && isSolidBody;
      const sellEntry = bearTrend && freshSellTrigger;

      const exitLong = ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i];
      const exitShort = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];

      const fireBuy = (marketState === 0 || marketState === -1) && buyEntry;
      const fireSellShort = (marketState === 0 || marketState === 1) && sellEntry;
      const fireExitLong = marketState === 1 && exitLong && !sellEntry;
      const fireExitShort = marketState === -1 && exitShort && !buyEntry;

      if (fireBuy) {
        marketState = 1;
        const sl = Math.min(closes[i] - atr[i] * 1.5, ema50[i] - atr[i] * 0.5);
        const risk = Math.abs(closes[i] - sl);
        lastSignal = {
          type: 'BUY',
          time: candles[i].time,
          entry: closes[i],
          sl,
          risk,
          tp1: closes[i] + risk * 1.0,
          tp2: closes[i] + risk * 2.2,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      } else if (fireSellShort) {
        marketState = -1;
        const sl = Math.max(closes[i] + atr[i] * 1.5, ema50[i] + atr[i] * 0.5);
        const risk = Math.abs(sl - closes[i]);
        lastSignal = {
          type: 'SHORT',
          time: candles[i].time,
          entry: closes[i],
          sl,
          risk,
          tp1: closes[i] - risk * 1.0,
          tp2: closes[i] - risk * 2.2,
        };
        if (i === candles.length - 1) firedOnLastBar = lastSignal;
      } else if (fireExitLong || fireExitShort) {
        marketState = 0;
      }
    }

    const curClose = closes[closes.length - 1];
    const bias = marketState === 1 ? '🟢 LONG' : marketState === -1 ? '🔴 SHORT' : '⚪️ WAIT';

    // Store state in global registry for cross-asset macro correlation
    marketRegistry[target.id] = {
      price: curClose,
      bias,
      marketState,
      ema9: ema9[ema9.length - 1],
      atr: atr[atr.length - 1]
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

      const alertKey = `${target.id}_${firedOnLastBar.type}_${firedOnLastBar.time}`;
      if (lastAlerted[target.id] !== alertKey) {
        lastAlerted[target.id] = alertKey;
        const badge = firedOnLastBar.type === 'BUY' ? '🟢 LONG' : '🔴 SHORT';
        const sugSize = formatSize(firedOnLastBar.risk, target);
        const msg =
          `${target.icon} <b>${target.name} — ${badge}</b>\n` +
          `📍 <b>Entry:</b> ${formatPrice(firedOnLastBar.entry)}\n` +
          `🛑 <b>SL:</b> ${formatPrice(firedOnLastBar.sl)} <i>(Size: ${sugSize} | ~$${TARGET_RISK_USD} risk)</i>\n` +
          `🎯 <b>TP:</b> ${formatPrice(firedOnLastBar.tp1)}`;

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

async function pollTelegramUpdates() {
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
        const isTradeable = info.bias === '🟢 LONG' || info.bias === '🔴 SHORT';
        const verdict = isTradeable 
          ? `✅ <b>YES: TAKE ${matchedTarget} ${info.bias.includes('LONG') ? 'LONG' : 'SHORT'}</b>` 
          : `❌ <b>NO: STAY FLAT ON ${matchedTarget}</b>`;
        let levelsStr = '';
        if (info.lastSignal) {
          levelsStr = `\n• Entry: ${formatPrice(info.lastSignal.entry)} | SL: ${formatPrice(info.lastSignal.sl)}\n• TP1: ${formatPrice(info.lastSignal.tp1)} | TP2: ${formatPrice(info.lastSignal.tp2)}`;
        }
        const reply = 
          `${verdict}\n` +
          `• Price: ${formatPrice(info.price)} | Status: ${info.bias}` +
          levelsStr +
          `\n• ${isTradeable ? 'Sizing: Max $50 risk.' : 'Wait for clean trend breakout.'}`;
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
  }
}

console.log('🚀 CandleSight Autonomous Top-5 Scanner v3 Initialized (GC=F, BTC, ETH, SOL, NQ=F)');
runScanCycle();
setInterval(runScanCycle, 60000);
setInterval(pollTelegramUpdates, 2500);

