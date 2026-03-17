import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Cell, PieChart, Pie,
  AreaChart, Area, Legend, ScatterChart, Scatter, ZAxis
} from "recharts";
import {
  Activity, TrendingUp, TrendingDown, DollarSign, Target, Clock,
  BarChart3, Calendar, Shield, ExternalLink, Copy, Check, Loader2,
  Wallet, ChevronDown, ChevronRight, X, ArrowUpRight, ArrowDownRight,
  Percent, Zap, Eye, RefreshCw, AlertTriangle, Info, Play, Database
} from "lucide-react";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const COLORS = {
  profit: "#22c55e", profitMuted: "#16a34a", profitBg: "rgba(34,197,94,0.08)",
  loss: "#ef4444", lossMuted: "#dc2626", lossBg: "rgba(239,68,68,0.08)",
  accent: "#6366f1", accentMuted: "#818cf8",
  neutral: "#94a3b8", bg: "#0a0e17", card: "#111827",
  cardHover: "#1a2332", border: "#1e293b", text: "#e2e8f0",
  textMuted: "#64748b", yellow: "#eab308", demo: "#f59e0b"
};
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS_LABEL = ["Mon","","Wed","","Fri","",""];

// Seeded PRNG
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Demo Data Generator — ~700 trades across 10 assets over 8 months
function generateDemoFills() {
  const rng = mulberry32(42);
  const coins = [
    { name: "BTC", basePrice: 67500, vol: 0.025 },
    { name: "ETH", basePrice: 3450, vol: 0.03 },
    { name: "SOL", basePrice: 172, vol: 0.045 },
    { name: "HYPE", basePrice: 28.5, vol: 0.06 },
    { name: "DOGE", basePrice: 0.165, vol: 0.05 },
    { name: "ARB", basePrice: 1.12, vol: 0.055 },
    { name: "WIF", basePrice: 2.85, vol: 0.07 },
    { name: "ONDO", basePrice: 1.38, vol: 0.05 },
    { name: "PENDLE", basePrice: 5.92, vol: 0.06 },
    { name: "TIA", basePrice: 11.2, vol: 0.05 },
  ];
  const fills = [];
  const startDate = new Date("2025-10-01T08:00:00Z").getTime();
  const endDate = new Date("2026-05-15T20:00:00Z").getTime();
  let cursor = startDate;

  while (cursor < endDate) {
    const tradesThisDay = rng() < 0.15 ? 0 : Math.floor(rng() * 5) + 1;
    for (let t = 0; t < tradesThisDay; t++) {
      const coinIdx = Math.floor(rng() * coins.length);
      const coin = coins[coinIdx];
      coin.basePrice *= (1 + (rng() - 0.48) * 0.008);
      const isBuy = rng() > 0.47;
      const entryPrice = coin.basePrice * (1 + (rng() - 0.5) * coin.vol);
      const holdTime = (rng() * 14400 + 300) * 1000;
      const notional = 500 + rng() * 9500;
      const sz = notional / entryPrice;
      const isWin = rng() < 0.54;
      const magnitude = rng() * coin.vol * 1.5;
      const exitPrice = isBuy
        ? entryPrice * (isWin ? 1 + magnitude : 1 - magnitude * 0.8)
        : entryPrice * (isWin ? 1 - magnitude : 1 + magnitude * 0.8);
      const rawPnl = isBuy ? (exitPrice - entryPrice) * sz : (entryPrice - exitPrice) * sz;
      const fee = notional * 0.00035;
      const openTime = cursor + rng() * 3600000 * 3 + t * 1800000;
      const closeTime = openTime + holdTime;

      fills.push({
        coin: coin.name, px: entryPrice.toString(), sz: sz.toString(),
        side: isBuy ? "B" : "A", time: openTime, fee: (fee * 0.4).toString(),
        closedPnl: "0", dir: isBuy ? "Open Long" : "Open Short",
        hash: "0xdemo" + fills.length.toString(16).padStart(8, "0"), oid: fills.length,
      });
      fills.push({
        coin: coin.name, px: exitPrice.toString(), sz: sz.toString(),
        side: isBuy ? "A" : "B", time: closeTime, fee: (fee * 0.6).toString(),
        closedPnl: rawPnl.toString(), dir: isBuy ? "Close Long" : "Close Short",
        hash: "0xdemo" + fills.length.toString(16).padStart(8, "0"), oid: fills.length,
      });
    }
    cursor += 86400000;
  }
  return fills.sort((a, b) => a.time - b.time);
}

// Hyperliquid API
const MAX_FILLS = 100000;

function fillsCacheKey(address) { return "hl_fills_" + address.toLowerCase(); }

function getCachedFills(address) {
  try {
    const raw = localStorage.getItem(fillsCacheKey(address));
    if (!raw) return null;
    const { fills, ts } = JSON.parse(raw);
    if (Date.now() - ts > 5 * 60 * 1000) return null; // 5 min TTL
    return fills;
  } catch { return null; }
}

function setCachedFills(address, fills) {
  try { localStorage.setItem(fillsCacheKey(address), JSON.stringify({ fills, ts: Date.now() })); }
  catch { /* storage full — ignore */ }
}

function clearCachedFills(address) {
  try { localStorage.removeItem(fillsCacheKey(address)); } catch { /* ignore */ }
}

async function fetchRecentFills(address) {
  const resp = await fetch(HL_INFO_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFills", user: address, aggregateByTime: true })
  });
  if (!resp.ok) throw new Error("API Error: " + resp.status);
  return resp.json();
}

async function fetchUserFillsByTime(address, startTime, endTime) {
  const resp = await fetch(HL_INFO_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "userFillsByTime", user: address, startTime, endTime, aggregateByTime: true })
  });
  if (!resp.ok) throw new Error("API Error: " + resp.status);
  return resp.json();
}

async function fetchUserState(address) {
  const resp = await fetch(HL_INFO_URL, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: address })
  });
  if (!resp.ok) throw new Error("API Error: " + resp.status);
  return resp.json();
}

function deduplicateFills(fills) {
  const seen = new Set();
  return fills.filter(f => {
    const key = f.tid ?? (f.time + ":" + f.coin + ":" + f.px + ":" + f.sz + ":" + f.side);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchAllFills(address, onProgress) {
  const cached = getCachedFills(address);
  if (cached) { onProgress && onProgress("Loaded " + cached.length + " fills from cache"); return cached; }

  // Source A: recent buffer (most recent fills, no time params)
  onProgress && onProgress("Fetching recent fills...");
  let recentFills;
  try { recentFills = await fetchRecentFills(address); }
  catch (e) { throw e; }
  if (!recentFills || recentFills.length === 0) return [];

  let allFills = [...recentFills];
  onProgress && onProgress("Fetched " + allFills.length + " fills...");

  // Source B: walk backward from oldest fill in recent buffer
  if (recentFills.length >= 2000) {
    const oldestRecent = Math.min(...recentFills.map(f => f.time));
    let endTime = oldestRecent - 1;
    while (allFills.length < MAX_FILLS) {
      await new Promise(r => setTimeout(r, 200));
      onProgress && onProgress("Fetched " + allFills.length + " fills...");
      let fills;
      try { fills = await fetchUserFillsByTime(address, 0, endTime); }
      catch (e) { break; }
      if (!fills || fills.length === 0) break;
      allFills = allFills.concat(fills);
      if (fills.length < 2000) break;
      const oldest = Math.min(...fills.map(f => f.time));
      endTime = oldest - 1;
    }
  }

  allFills = deduplicateFills(allFills);
  allFills.sort((a, b) => a.time - b.time);
  onProgress && onProgress("Fetched " + allFills.length + " fills total");
  setCachedFills(address, allFills);
  return allFills;
}

// Trade Processing Engine
function processHyperliquidFills(fills) {
  if (!fills || fills.length === 0) return { trades: [], dailyPnl: {}, stats: {} };
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const positions = {};
  const trades = [];

  for (const fill of sorted) {
    const coin = fill.coin;
    if (!positions[coin]) positions[coin] = { entries: [], totalSize: 0, side: null, fees: 0, startTime: null, fills: [], realizedPnl: 0 };
    const pos = positions[coin];
    const size = parseFloat(fill.sz), price = parseFloat(fill.px);
    const fee = parseFloat(fill.fee || "0") + parseFloat(fill.builderFee || "0");
    const closedPnl = parseFloat(fill.closedPnl || "0");
    const isClosing = fill.dir === "Close Long" || fill.dir === "Close Short";
    const isBuy = fill.side === "B" || fill.side === "Buy" || fill.dir === "Open Long" || fill.dir === "Close Short";
    pos.fees += fee;
    pos.fills.push({ ...fill, parsedSize: size, parsedPrice: price, parsedFee: fee, isBuy });

    if (pos.totalSize === 0) {
      pos.side = isBuy ? "Long" : "Short";
      pos.startTime = fill.time;
      pos.entries = [{ price, size }];
      pos.totalSize = size;
      pos.realizedPnl = 0;
    } else {
      const sameDir = (pos.side === "Long" && isBuy) || (pos.side === "Short" && !isBuy);
      if (sameDir) { pos.entries.push({ price, size }); pos.totalSize += size; }
      else {
        if (isClosing) pos.realizedPnl += closedPnl;
        pos.totalSize -= size;
        if (pos.totalSize <= 0.00001) {
          const avgEntry = pos.entries.reduce((s, e) => s + e.price * e.size, 0) / pos.entries.reduce((s, e) => s + e.size, 0);
          const pnl = pos.realizedPnl - pos.fees;
          const fillPrices = pos.fills.map(f => f.parsedPrice);
          let mfe = 0, mae = 0;
          for (const fp of fillPrices) {
            const exc = pos.side === "Long" ? (fp - avgEntry) / avgEntry : (avgEntry - fp) / avgEntry;
            if (exc > mfe) mfe = exc; if (exc < mae) mae = exc;
          }
          trades.push({
            coin, side: pos.side, entryPrice: avgEntry, exitPrice: price,
            size: pos.entries.reduce((s, e) => s + e.size, 0),
            pnl, pnlRaw: pos.realizedPnl, fees: pos.fees,
            openTime: pos.startTime, closeTime: fill.time,
            duration: fill.time - pos.startTime, fillCount: pos.fills.length,
            mfe: mfe * 100, mae: mae * 100,
          });
          if (pos.totalSize < -0.00001) {
            pos.side = pos.side === "Long" ? "Short" : "Long";
            pos.entries = [{ price, size: Math.abs(pos.totalSize) }];
            pos.totalSize = Math.abs(pos.totalSize);
            pos.fees = 0; pos.startTime = fill.time;
            pos.fills = [pos.fills[pos.fills.length - 1]]; pos.realizedPnl = 0;
          } else {
            positions[coin] = { entries: [], totalSize: 0, side: null, fees: 0, startTime: null, fills: [], realizedPnl: 0 };
          }
        }
      }
    }
  }

  const dailyPnl = {};
  for (const t of trades) {
    const day = new Date(t.closeTime).toISOString().slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = { pnl: 0, trades: [], wins: 0, losses: 0 };
    dailyPnl[day].pnl += t.pnl; dailyPnl[day].trades.push(t);
    if (t.pnl >= 0) dailyPnl[day].wins++; else dailyPnl[day].losses++;
  }

  const wins = trades.filter(t => t.pnl >= 0), losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const byAsset = {};
  for (const t of trades) {
    if (!byAsset[t.coin]) byAsset[t.coin] = { pnl: 0, count: 0, wins: 0, losses: 0 };
    byAsset[t.coin].pnl += t.pnl; byAsset[t.coin].count++;
    if (t.pnl >= 0) byAsset[t.coin].wins++; else byAsset[t.coin].losses++;
  }

  const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, pnl: 0, count: 0 }));
  for (const t of trades) { const h = new Date(t.closeTime).getUTCHours(); byHour[h].pnl += t.pnl; byHour[h].count++; }

  const longs = trades.filter(t => t.side === "Long"), shorts = trades.filter(t => t.side === "Short");
  let cumPnl = 0;
  const equityCurve = trades.map(t => { cumPnl += t.pnl; return { time: t.closeTime, pnl: cumPnl, date: new Date(t.closeTime).toLocaleDateString() }; });

  let curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of trades) {
    if (t.pnl >= 0) { curStreak = curStreak >= 0 ? curStreak + 1 : 1; maxWinStreak = Math.max(maxWinStreak, curStreak); }
    else { curStreak = curStreak <= 0 ? curStreak - 1 : -1; maxLossStreak = Math.max(maxLossStreak, Math.abs(curStreak)); }
  }

  return { trades, dailyPnl, stats: {
    totalPnl, totalFees, winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWin, avgLoss, profitFactor, totalTrades: trades.length,
    wins: wins.length, losses: losses.length, grossProfit, grossLoss,
    avgTrade: trades.length ? totalPnl / trades.length : 0,
    bestTrade: trades.length ? Math.max(...trades.map(t => t.pnl)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.pnl)) : 0,
    avgDuration: trades.length ? trades.reduce((s, t) => s + t.duration, 0) / trades.length : 0,
    longPnl: longs.reduce((s, t) => s + t.pnl, 0), shortPnl: shorts.reduce((s, t) => s + t.pnl, 0),
    longCount: longs.length, shortCount: shorts.length,
    longWinRate: longs.length ? (longs.filter(t => t.pnl >= 0).length / longs.length) * 100 : 0,
    shortWinRate: shorts.length ? (shorts.filter(t => t.pnl >= 0).length / shorts.length) * 100 : 0,
    maxWinStreak, maxLossStreak, byAsset, byHour, equityCurve
  }};
}

// Utilities
const fmt = (n, d = 2) => {
  if (n === undefined || n === null || isNaN(n)) return "$0.00";
  const abs = Math.abs(n), sign = n < 0 ? "-" : n > 0 ? "+" : "";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
  return sign + "$" + abs.toFixed(d);
};
const fmtDuration = (ms) => { const m = ms / 60000; if (m < 60) return m.toFixed(0) + "m"; if (m < 1440) return (m / 60).toFixed(1) + "h"; return (m / 1440).toFixed(1) + "d"; };
const pnlColor = (v) => v >= 0 ? COLORS.profit : COLORS.loss;

// Sub Components
function StatCard({ icon: Icon, label, value, subValue, color }) {
  return (
    <div style={{ background: COLORS.card, borderRadius: 12, padding: "18px 20px", border: "1px solid " + COLORS.border, transition: "border-color 0.2s" }}
      onMouseEnter={e => e.currentTarget.style.borderColor = color || COLORS.accent}
      onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.border}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ width: 32, height: 32, borderRadius: 8, background: (color || COLORS.accent) + "15", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon size={16} color={color || COLORS.accent} />
        </div>
        <span style={{ fontSize: 12, color: COLORS.textMuted, fontWeight: 500, letterSpacing: 0.5 }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || COLORS.text, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      {subValue && <div style={{ fontSize: 12, color: COLORS.textMuted, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{subValue}</div>}
    </div>
  );
}

function PnlCalendar({ dailyPnl, year, onDayClick }) {
  const startDate = new Date(year, 0, 1), endDate = new Date(year, 11, 31);
  const weeks = []; let cw = [];
  const sd = (startDate.getDay() + 6) % 7;
  for (let i = 0; i < sd; i++) cw.push(null);
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    cw.push({ date: d.toISOString().slice(0, 10), data: dailyPnl[d.toISOString().slice(0, 10)] || null });
    if (cw.length === 7) { weeks.push(cw); cw = []; }
  }
  if (cw.length) { while (cw.length < 7) cw.push(null); weeks.push(cw); }
  const maxAbs = Math.max(1, ...Object.values(dailyPnl).map(d => Math.abs(d.pnl)));
  const cc = (data) => { if (!data) return COLORS.border + "40"; const i = Math.min(Math.abs(data.pnl) / maxAbs, 1); const a = 0.15 + i * 0.85; return data.pnl >= 0 ? "rgba(34,197,94," + a + ")" : "rgba(239,68,68," + a + ")"; };
  const ml = []; let lm = -1;
  weeks.forEach((w, wi) => { for (const c of w) { if (c) { const m = parseInt(c.date.slice(5, 7)) - 1; if (m !== lm) { ml.push({ month: MONTHS[m], wi }); lm = m; } break; } } });
  const cs = 14, g = 3;
  return (
    <div style={{ overflowX: "auto", padding: "4px 0" }}>
      <div style={{ display: "flex", gap: 2, marginBottom: 4, paddingLeft: 32 }}>
        {ml.map((m, i) => <span key={i} style={{ fontSize: 10, color: COLORS.textMuted, position: "absolute", left: 32 + m.wi * (cs + g), fontFamily: "'JetBrains Mono', monospace" }}>{m.month}</span>)}
      </div>
      <div style={{ display: "flex", gap: g, marginTop: 18, position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: g, marginRight: 4 }}>
          {DAYS_LABEL.map((d, i) => <div key={i} style={{ height: cs, fontSize: 9, color: COLORS.textMuted, display: "flex", alignItems: "center", justifyContent: "flex-end", width: 24, fontFamily: "'JetBrains Mono', monospace" }}>{d}</div>)}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: g }}>
            {week.map((cell, di) => (
              <div key={di} onClick={() => cell?.data && onDayClick?.(cell.date, cell.data)}
                title={cell ? cell.date + ": " + (cell.data ? fmt(cell.data.pnl) : "No trades") : ""}
                style={{ width: cs, height: cs, borderRadius: 3, background: cell ? cc(cell.data) : "transparent", cursor: cell?.data ? "pointer" : "default", transition: "transform 0.1s" }}
                onMouseEnter={e => { if (cell?.data) { e.currentTarget.style.transform = "scale(1.4)"; e.currentTarget.style.zIndex = "10"; e.currentTarget.style.position = "relative"; }}}
                onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.zIndex = "auto"; }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayDetail({ date, data, onClose }) {
  if (!data) return null;
  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <div style={{ background: COLORS.card, borderRadius: 16, padding: 28, maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto", border: "1px solid " + COLORS.border, boxShadow: "0 24px 48px rgba(0,0,0,0.4)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div>
            <h3 style={{ color: COLORS.text, fontSize: 18, fontWeight: 700, margin: 0 }}>{date}</h3>
            <span style={{ color: pnlColor(data.pnl), fontSize: 24, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(data.pnl)}</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textMuted, cursor: "pointer", padding: 4 }}><X size={20} /></button>
        </div>
        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: COLORS.profit }}>Wins: {data.wins}</span>
          <span style={{ fontSize: 13, color: COLORS.loss }}>Losses: {data.losses}</span>
          <span style={{ fontSize: 13, color: COLORS.textMuted }}>Total: {data.trades.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.trades.map((t, i) => (
            <div key={i} style={{ background: COLORS.bg, borderRadius: 8, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid " + COLORS.border }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: t.side === "Long" ? COLORS.profitBg : COLORS.lossBg, color: t.side === "Long" ? COLORS.profit : COLORS.loss }}>{t.side.toUpperCase()}</span>
                <span style={{ color: COLORS.text, fontWeight: 600, fontSize: 14 }}>{t.coin}</span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: pnlColor(t.pnl), fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontSize: 14 }}>{fmt(t.pnl)}</div>
                <div style={{ fontSize: 11, color: COLORS.textMuted }}>{fmtDuration(t.duration)} · {t.fillCount} fills</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a2332", border: "1px solid " + COLORS.border, borderRadius: 8, padding: "10px 14px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
      <div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ fontSize: 13, color: p.color || COLORS.text, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{formatter ? formatter(p.value) : fmt(p.value)}</div>)}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: COLORS.accent + "15", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon size={18} color={COLORS.accent} />
      </div>
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: COLORS.text }}>{title}</h2>
        {subtitle && <div style={{ fontSize: 12, color: COLORS.textMuted }}>{subtitle}</div>}
      </div>
    </div>
  );
}

// Main App
export default function HyperliquidAnalytics() {
  const [address, setAddress] = useState("");
  const [inputAddr, setInputAddr] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedDay, setSelectedDay] = useState(null);
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());
  const [copied, setCopied] = useState(false);
  const [verifyUrl, setVerifyUrl] = useState(null);
  const [timeframe, setTimeframe] = useState("all");

  const loadDemoData = () => {
    setLoading(true); setLoadingMsg("Generating demo trading history..."); setError(null);
    setTimeout(() => {
      const fills = generateDemoFills();
      const processed = processHyperliquidFills(fills);
      processed.rawFillCount = fills.length;
      setData(processed); setAddress("0xDEMO...d3m0"); setIsDemo(true);
      const dates = Object.keys(processed.dailyPnl).sort();
      const ly = parseInt(dates[dates.length - 1]?.slice(0, 4));
      if (ly) setCalendarYear(ly);
      setLoading(false); setLoadingMsg("");
    }, 500);
  };

  const connectWallet = async () => {
    if (typeof window.ethereum === "undefined") { setError("No wallet detected. Paste an address or try demo mode."); return; }
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts[0]) { setInputAddr(accounts[0]); loadLiveData(accounts[0]); }
    } catch { setError("Wallet connection rejected."); }
  };

  const loadLiveData = async (addr) => {
    const target = addr || inputAddr;
    if (!target || target.length < 10) { setError("Please enter a valid Hyperliquid address."); return; }
    setError(null); setLoading(true); setAddress(target); setIsDemo(false);
    try {
      setLoadingMsg("Connecting to Hyperliquid...");
      const [fills, state] = await Promise.all([fetchAllFills(target, setLoadingMsg), fetchUserState(target).catch(() => null)]);
      setLoadingMsg("Processing trade data...");
      await new Promise(r => setTimeout(r, 100));
      const processed = processHyperliquidFills(fills);
      processed.accountState = state; processed.rawFillCount = fills.length;
      setData(processed);
      if (processed.trades.length > 0) { const dates = Object.keys(processed.dailyPnl).sort(); const ly = parseInt(dates[dates.length - 1]?.slice(0, 4)); if (ly) setCalendarYear(ly); }
    } catch (e) {
      const isNet = e.message?.includes("Failed to fetch") || e.message?.includes("NetworkError") || e.message?.includes("fetch");
      setError(isNet ? "NETWORK_BLOCKED" : "Failed to load data: " + e.message);
    } finally { setLoading(false); setLoadingMsg(""); }
  };

  const generateVerifyUrl = () => { setVerifyUrl("https://verify.hlanalytics.io/pnl/" + btoa(address + ":" + Date.now()).slice(0, 16)); };
  const copyToClipboard = (text) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: Activity },
    { id: "calendar", label: "PnL Calendar", icon: Calendar },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "execution", label: "Execution", icon: Target },
    { id: "verify", label: "Verify", icon: Shield },
  ];

  // Timeframe filtering for dashboard (must be before early return for hook rules)
  const TIMEFRAMES = [
    { id: "1d", label: "1D" },
    { id: "1w", label: "1W" },
    { id: "1m", label: "1M" },
    { id: "1y", label: "1Y" },
    { id: "ytd", label: "YTD" },
    { id: "all", label: "All" },
  ];

  const tfData = useMemo(() => {
    if (!data || !data.trades || !data.trades.length) {
      const emptyHours = Array.from({ length: 24 }, (_, i) => ({ hour: i, pnl: 0, count: 0 }));
      return { trades: [], stats: { totalPnl: 0, totalFees: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, totalTrades: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, avgTrade: 0, bestTrade: 0, worstTrade: 0, avgDuration: 0, longPnl: 0, shortPnl: 0, longCount: 0, shortCount: 0, longWinRate: 0, shortWinRate: 0, maxWinStreak: 0, maxLossStreak: 0, byAsset: {}, byHour: emptyHours, equityCurve: [] }, dailyPnl: {}, pnlDistribution: [], longShortData: [{ name: "Long", value: 0, pnl: 0, wr: 0 }, { name: "Short", value: 0, pnl: 0, wr: 0 }] };
    }
    const trades = data.trades;
    const now = Date.now();
    let cutoff = 0;
    if (timeframe === "1d") cutoff = now - 86400000;
    else if (timeframe === "1w") cutoff = now - 7 * 86400000;
    else if (timeframe === "1m") cutoff = now - 30 * 86400000;
    else if (timeframe === "1y") cutoff = now - 365 * 86400000;
    else if (timeframe === "ytd") cutoff = new Date(new Date().getFullYear(), 0, 1).getTime();
    else cutoff = 0;

    const ft = cutoff > 0 ? trades.filter(t => t.closeTime >= cutoff) : trades;

    if (ft.length === 0) {
      const emptyHours = Array.from({ length: 24 }, (_, i) => ({ hour: i, pnl: 0, count: 0 }));
      return { trades: ft, stats: { totalPnl: 0, totalFees: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, totalTrades: 0, wins: 0, losses: 0, grossProfit: 0, grossLoss: 0, avgTrade: 0, bestTrade: 0, worstTrade: 0, avgDuration: 0, longPnl: 0, shortPnl: 0, longCount: 0, shortCount: 0, longWinRate: 0, shortWinRate: 0, maxWinStreak: 0, maxLossStreak: 0, byAsset: {}, byHour: emptyHours, equityCurve: [] }, dailyPnl: {}, pnlDistribution: [], longShortData: [{ name: "Long", value: 0, pnl: 0, wr: 0 }, { name: "Short", value: 0, pnl: 0, wr: 0 }] };
    }

    const wins = ft.filter(t => t.pnl >= 0), losses = ft.filter(t => t.pnl < 0);
    const totalPnl = ft.reduce((s, t) => s + t.pnl, 0);
    const totalFees = ft.reduce((s, t) => s + t.fees, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const longs = ft.filter(t => t.side === "Long"), shorts = ft.filter(t => t.side === "Short");
    let cumPnl = 0;
    const equityCurve = ft.map(t => { cumPnl += t.pnl; return { time: t.closeTime, pnl: cumPnl, date: new Date(t.closeTime).toLocaleDateString() }; });
    let curStreak = 0, maxWinStreak = 0, maxLossStreak = 0;
    for (const t of ft) {
      if (t.pnl >= 0) { curStreak = curStreak >= 0 ? curStreak + 1 : 1; maxWinStreak = Math.max(maxWinStreak, curStreak); }
      else { curStreak = curStreak <= 0 ? curStreak - 1 : -1; maxLossStreak = Math.max(maxLossStreak, Math.abs(curStreak)); }
    }
    const byAsset = {};
    for (const t of ft) { if (!byAsset[t.coin]) byAsset[t.coin] = { pnl: 0, count: 0, wins: 0, losses: 0 }; byAsset[t.coin].pnl += t.pnl; byAsset[t.coin].count++; if (t.pnl >= 0) byAsset[t.coin].wins++; else byAsset[t.coin].losses++; }
    const byHour = Array.from({ length: 24 }, (_, i) => ({ hour: i, pnl: 0, count: 0 }));
    for (const t of ft) { const h = new Date(t.closeTime).getUTCHours(); byHour[h].pnl += t.pnl; byHour[h].count++; }
    const fdp = {};
    for (const t of ft) { const day = new Date(t.closeTime).toISOString().slice(0, 10); if (!fdp[day]) fdp[day] = { pnl: 0, trades: [], wins: 0, losses: 0 }; fdp[day].pnl += t.pnl; fdp[day].trades.push(t); if (t.pnl >= 0) fdp[day].wins++; else fdp[day].losses++; }

    const fStats = {
      totalPnl, totalFees, winRate: ft.length ? (wins.length / ft.length) * 100 : 0,
      avgWin, avgLoss, profitFactor, totalTrades: ft.length,
      wins: wins.length, losses: losses.length, grossProfit, grossLoss,
      avgTrade: ft.length ? totalPnl / ft.length : 0,
      bestTrade: Math.max(...ft.map(t => t.pnl)),
      worstTrade: Math.min(...ft.map(t => t.pnl)),
      avgDuration: ft.reduce((s, t) => s + t.duration, 0) / ft.length,
      longPnl: longs.reduce((s, t) => s + t.pnl, 0), shortPnl: shorts.reduce((s, t) => s + t.pnl, 0),
      longCount: longs.length, shortCount: shorts.length,
      longWinRate: longs.length ? (longs.filter(t => t.pnl >= 0).length / longs.length) * 100 : 0,
      shortWinRate: shorts.length ? (shorts.filter(t => t.pnl >= 0).length / shorts.length) * 100 : 0,
      maxWinStreak, maxLossStreak, byAsset, byHour, equityCurve
    };

    const pnlDist = (() => {
      const bs = Math.max(1, (fStats.bestTrade - fStats.worstTrade) / 20);
      const b = {}; ft.forEach(t => { const k = Math.floor(t.pnl / bs) * bs; b[k] = (b[k] || 0) + 1; });
      return Object.entries(b).map(([k, v]) => ({ range: parseFloat(k), count: v })).sort((a, bb) => a.range - bb.range);
    })();

    return { trades: ft, stats: fStats, dailyPnl: fdp, pnlDistribution: pnlDist, longShortData: [
      { name: "Long", value: fStats.longCount, pnl: fStats.longPnl, wr: fStats.longWinRate },
      { name: "Short", value: fStats.shortCount, pnl: fStats.shortPnl, wr: fStats.shortWinRate }
    ]};
  }, [data, timeframe]);

  // CONNECT SCREEN
  if (!data) {
    return (
      <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'Inter', -apple-system, sans-serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${COLORS.border};border-radius:3px}input:focus{outline:none}@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(99,102,241,0.2)}50%{box-shadow:0 0 40px rgba(99,102,241,0.4)}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ textAlign: "center", maxWidth: 520, animation: "fadeIn 0.6s ease" }}>
          <div style={{ width: 72, height: 72, borderRadius: 20, margin: "0 auto 24px", background: "linear-gradient(135deg, " + COLORS.accent + ", " + COLORS.accentMuted + ")", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 32px rgba(99,102,241,0.3)", animation: "glow 3s ease infinite" }}>
            <Activity size={32} color="white" />
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8, background: "linear-gradient(135deg, #e2e8f0, #94a3b8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Hyperliquid Analytics</h1>
          <p style={{ color: COLORS.textMuted, fontSize: 15, marginBottom: 36, lineHeight: 1.6 }}>Professional-grade trading analytics for Hyperliquid DEX.<br />Connect your wallet, paste an address, or explore with demo data.</p>

          <div style={{ display: "flex", gap: 8, marginBottom: 12, background: COLORS.card, borderRadius: 12, padding: 6, border: "1px solid " + COLORS.border }}>
            <input value={inputAddr} onChange={e => setInputAddr(e.target.value)} onKeyDown={e => e.key === "Enter" && loadLiveData()} placeholder="0x... Hyperliquid address" style={{ flex: 1, background: "transparent", border: "none", color: COLORS.text, fontSize: 14, padding: "12px 14px", fontFamily: "'JetBrains Mono', monospace" }} />
            <button onClick={() => loadLiveData()} disabled={loading} style={{ background: COLORS.accent, border: "none", borderRadius: 8, color: "white", padding: "12px 20px", cursor: "pointer", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6, opacity: loading ? 0.6 : 1 }}>
              {loading && !isDemo ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <ArrowUpRight size={16} />} Analyze
            </button>
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
            <button onClick={connectWallet} disabled={loading} style={{ flex: 1, background: COLORS.card, border: "1px solid " + COLORS.border, borderRadius: 12, color: COLORS.text, padding: "14px 20px", cursor: "pointer", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "border-color 0.2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = COLORS.accent} onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.border}>
              <Wallet size={18} /> Connect Wallet
            </button>
            <button onClick={loadDemoData} disabled={loading} style={{ flex: 1, background: COLORS.demo + "10", border: "1px solid " + COLORS.demo + "40", borderRadius: 12, color: COLORS.demo, padding: "14px 20px", cursor: "pointer", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "border-color 0.2s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = COLORS.demo} onMouseLeave={e => e.currentTarget.style.borderColor = COLORS.demo + "40"}>
              <Play size={18} /> Try Demo
            </button>
          </div>

          {loading && <div style={{ marginTop: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, animation: "fadeIn 0.3s ease" }}><Loader2 size={16} color={COLORS.accent} style={{ animation: "spin 1s linear infinite" }} /><span style={{ color: COLORS.textMuted, fontSize: 13 }}>{loadingMsg}</span></div>}

          {error === "NETWORK_BLOCKED" && (
            <div style={{ marginTop: 20, animation: "fadeIn 0.3s ease", textAlign: "left" }}>
              <div style={{ padding: "16px 20px", borderRadius: 12, background: COLORS.demo + "08", border: "1px solid " + COLORS.demo + "30" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <AlertTriangle size={18} color={COLORS.demo} />
                  <span style={{ color: COLORS.demo, fontWeight: 700, fontSize: 14 }}>External API blocked by sandbox</span>
                </div>
                <p style={{ color: COLORS.textMuted, fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>This embedded preview cannot reach api.hyperliquid.xyz due to browser sandbox restrictions. Two options:</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: COLORS.demo + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}><span style={{ color: COLORS.demo, fontWeight: 700, fontSize: 12 }}>1</span></div>
                    <div><span style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>Explore with demo data</span><p style={{ color: COLORS.textMuted, fontSize: 12, margin: "2px 0 0" }}>~700 realistic trades across 10 assets over 8 months. Full UI is functional.</p></div>
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <div style={{ width: 22, height: 22, borderRadius: 6, background: COLORS.accent + "15", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}><span style={{ color: COLORS.accent, fontWeight: 700, fontSize: 12 }}>2</span></div>
                    <div><span style={{ color: COLORS.text, fontSize: 13, fontWeight: 600 }}>Run locally with Vite</span><p style={{ color: COLORS.textMuted, fontSize: 12, margin: "2px 0 0" }}>Download this file, scaffold with <code style={{ color: COLORS.accent, background: COLORS.accent + "12", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>npm create vite@latest</code>, and the live API works perfectly.</p></div>
                  </div>
                </div>
                <button onClick={loadDemoData} style={{ width: "100%", background: COLORS.demo, border: "none", borderRadius: 10, color: "#000", padding: "12px", cursor: "pointer", fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <Play size={16} /> Load Demo Data Now
                </button>
              </div>
            </div>
          )}

          {error && error !== "NETWORK_BLOCKED" && (
            <div style={{ marginTop: 16, padding: "12px 16px", borderRadius: 10, background: COLORS.lossBg, border: "1px solid " + COLORS.loss + "30", color: COLORS.loss, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={16} /> {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // MAIN APP
  const { trades, dailyPnl, stats } = data;
  const ds = tfData.stats;
  const assetData = Object.entries(stats.byAsset).map(([coin, d]) => ({ coin, ...d })).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 12);
  const hourData = stats.byHour.map(h => ({ ...h, label: String(h.hour).padStart(2, "0") + ":00" }));
  const mfeMaeData = trades.map(t => ({ mfe: t.mfe, mae: t.mae, pnl: t.pnl, coin: t.coin, size: Math.abs(t.pnl) }));

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');*{box-sizing:border-box}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${COLORS.border};border-radius:3px}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {isDemo && (
        <div style={{ background: "linear-gradient(90deg, " + COLORS.demo + "18, " + COLORS.demo + "08)", borderBottom: "1px solid " + COLORS.demo + "30", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Database size={14} color={COLORS.demo} />
          <span style={{ fontSize: 12, color: COLORS.demo, fontWeight: 600 }}>Demo Mode — simulated data ({trades.length} trades, {Object.keys(stats.byAsset).length} assets)</span>
          <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 8 }}>Download & run locally for live data</span>
        </div>
      )}

      <div style={{ borderBottom: "1px solid " + COLORS.border, background: COLORS.card + "cc", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", padding: "12px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg, " + COLORS.accent + ", " + COLORS.accentMuted + ")", display: "flex", alignItems: "center", justifyContent: "center" }}><Activity size={16} color="white" /></div>
            <span style={{ fontSize: 15, fontWeight: 700 }}>HL Analytics</span>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 6, background: isDemo ? COLORS.demo + "15" : COLORS.profitBg, color: isDemo ? COLORS.demo : COLORS.profit, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{trades.length} trades</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>{isDemo ? "Demo Account" : address.slice(0, 6) + "..." + address.slice(-4)}</span>
            {!isDemo && <button onClick={() => { clearCachedFills(address); loadLiveData(address); }} disabled={loading} style={{ background: COLORS.bg, border: "1px solid " + COLORS.border, borderRadius: 8, color: COLORS.accent, padding: "6px 12px", cursor: loading ? "not-allowed" : "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, opacity: loading ? 0.5 : 1 }}><RefreshCw size={12} /> Refresh</button>}
            <button onClick={() => { setData(null); setAddress(""); setIsDemo(false); setError(null); setVerifyUrl(null); }} style={{ background: COLORS.bg, border: "1px solid " + COLORS.border, borderRadius: 8, color: COLORS.textMuted, padding: "6px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Disconnect</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 2, padding: "12px 24px", borderBottom: "1px solid " + COLORS.border, overflowX: "auto", maxWidth: 1400, margin: "0 auto" }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, background: activeTab === tab.id ? COLORS.accent + "20" : "transparent", color: activeTab === tab.id ? COLORS.accent : COLORS.textMuted, transition: "all 0.2s", whiteSpace: "nowrap" }}>
            <tab.icon size={15} /> {tab.label}
          </button>
        ))}
      </div>

      <div style={{ padding: 24, maxWidth: 1400, margin: "0 auto", animation: "fadeIn 0.4s ease" }}>

        {activeTab === "dashboard" && (<div>
          {/* Timeframe Selector */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: COLORS.textMuted, fontWeight: 500 }}>Timeframe</span>
              <div style={{ display: "flex", background: COLORS.card, borderRadius: 10, padding: 3, border: "1px solid " + COLORS.border }}>
                {TIMEFRAMES.map(tf => (
                  <button key={tf.id} onClick={() => setTimeframe(tf.id)} style={{
                    padding: "6px 14px", borderRadius: 7, border: "none", cursor: "pointer",
                    fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace",
                    background: timeframe === tf.id ? COLORS.accent : "transparent",
                    color: timeframe === tf.id ? "white" : COLORS.textMuted,
                    transition: "all 0.15s"
                  }}>{tf.label}</button>
                ))}
              </div>
            </div>
            {timeframe !== "all" && (
              <span style={{ fontSize: 12, color: COLORS.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
                {ds.totalTrades} of {stats.totalTrades} trades
              </span>
            )}
          </div>
          {/* Empty state for timeframe with no trades */}
          {ds.totalTrades === 0 && timeframe !== "all" && (
            <div style={{ background: COLORS.card, borderRadius: 14, padding: 40, border: "1px solid " + COLORS.border, textAlign: "center", marginBottom: 24 }}>
              <Clock size={32} color={COLORS.textMuted} style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.text, marginBottom: 6 }}>No trades in this period</div>
              <div style={{ fontSize: 13, color: COLORS.textMuted }}>Try a longer timeframe or select "All" to see your full history.</div>
            </div>
          )}
          {ds.totalTrades > 0 && (<>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 28 }}>
            <StatCard icon={DollarSign} label="NET PNL" value={fmt(ds.totalPnl)} color={pnlColor(ds.totalPnl)} subValue={"Fees: " + fmt(-ds.totalFees)} />
            <StatCard icon={Percent} label="WIN RATE" value={ds.winRate.toFixed(1) + "%"} color={ds.winRate >= 50 ? COLORS.profit : COLORS.loss} subValue={ds.wins + "W / " + ds.losses + "L"} />
            <StatCard icon={TrendingUp} label="AVG WIN" value={fmt(ds.avgWin)} color={COLORS.profit} subValue={"Best: " + fmt(ds.bestTrade)} />
            <StatCard icon={TrendingDown} label="AVG LOSS" value={fmt(-ds.avgLoss)} color={COLORS.loss} subValue={"Worst: " + fmt(ds.worstTrade)} />
            <StatCard icon={Zap} label="PROFIT FACTOR" value={ds.profitFactor === Infinity ? "∞" : ds.profitFactor.toFixed(2)} color={ds.profitFactor >= 1.5 ? COLORS.profit : ds.profitFactor >= 1 ? COLORS.yellow : COLORS.loss} subValue={"Avg: " + fmt(ds.avgTrade) + "/trade"} />
            <StatCard icon={Clock} label="AVG DURATION" value={fmtDuration(ds.avgDuration)} color={COLORS.accent} subValue={ds.totalTrades + " trades"} />
          </div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, marginBottom: 24 }}>
            <SectionHeader icon={TrendingUp} title="Equity Curve" subtitle="Cumulative realized PnL over time" />
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={ds.equityCurve}>
                <defs><linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={ds.totalPnl >= 0 ? COLORS.profit : COLORS.loss} stopOpacity={0.3} /><stop offset="100%" stopColor={ds.totalPnl >= 0 ? COLORS.profit : COLORS.loss} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickLine={false} axisLine={{ stroke: COLORS.border }} />
                <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickLine={false} axisLine={{ stroke: COLORS.border }} tickFormatter={v => fmt(v, 0)} />
                <RechartsTooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="pnl" stroke={ds.totalPnl >= 0 ? COLORS.profit : COLORS.loss} strokeWidth={2} fill="url(#eqGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 24 }}>
            <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border }}>
              <SectionHeader icon={BarChart3} title="PnL Distribution" />
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={tfData.pnlDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                  <XAxis dataKey="range" tick={{ fontSize: 9, fill: COLORS.textMuted }} tickFormatter={v => fmt(v, 0)} />
                  <YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} />
                  <RechartsTooltip content={<CustomTooltip />} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>{tfData.pnlDistribution.map((d, i) => <Cell key={i} fill={d.range >= 0 ? COLORS.profit : COLORS.loss} fillOpacity={0.75} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border }}>
              <SectionHeader icon={Target} title="Long vs Short" />
              <div style={{ display: "flex", justifyContent: "center", gap: 28, marginTop: 8 }}>
                {tfData.longShortData.map((d, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    <div style={{ width: 100, height: 100, borderRadius: "50%", border: "4px solid " + (i === 0 ? COLORS.profit : COLORS.loss), display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: i === 0 ? COLORS.profitBg : COLORS.lossBg, marginBottom: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: i === 0 ? COLORS.profit : COLORS.loss, fontFamily: "'JetBrains Mono', monospace" }}>{d.value}</div>
                      <div style={{ fontSize: 10, color: COLORS.textMuted }}>trades</div>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: COLORS.text, marginBottom: 4 }}>{d.name}</div>
                    <div style={{ color: pnlColor(d.pnl), fontSize: 14, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{fmt(d.pnl)}</div>
                    <div style={{ fontSize: 12, color: COLORS.textMuted }}>WR: {d.wr.toFixed(1)}%</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: (ds.longCount / Math.max(1, ds.totalTrades) * 100) + "%", background: COLORS.profit }} />
                  <div style={{ width: (ds.shortCount / Math.max(1, ds.totalTrades) * 100) + "%", background: COLORS.loss }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 11, color: COLORS.textMuted }}>
                  <span>{(ds.longCount / Math.max(1, ds.totalTrades) * 100).toFixed(0)}% Long</span>
                  <span>{(ds.shortCount / Math.max(1, ds.totalTrades) * 100).toFixed(0)}% Short</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <StatCard icon={TrendingUp} label="MAX WIN STREAK" value={ds.maxWinStreak + " trades"} color={COLORS.profit} />
            <StatCard icon={TrendingDown} label="MAX LOSS STREAK" value={ds.maxLossStreak + " trades"} color={COLORS.loss} />
          </div>
          </>)}
        </div>)}

        {activeTab === "calendar" && (<div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <SectionHeader icon={Calendar} title="PnL Calendar" subtitle="Click any day to view trade details" />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(() => {
                  const dates = Object.keys(dailyPnl).sort();
                  if (!dates.length) return null;
                  const minY = parseInt(dates[0].slice(0, 4));
                  const maxY = parseInt(dates[dates.length - 1].slice(0, 4));
                  const years = [];
                  for (let y = minY; y <= maxY; y++) years.push(y);
                  return years.map(y => (
                    <button key={y} onClick={() => setCalendarYear(y)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid " + COLORS.border, background: y === calendarYear ? COLORS.accent : "transparent", color: y === calendarYear ? "white" : COLORS.textMuted, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{y}</button>
                  ));
                })()}
              </div>
            </div>
            <PnlCalendar dailyPnl={dailyPnl} year={calendarYear} onDayClick={(date, data) => setSelectedDay({ date, data })} />
            <div style={{ display: "flex", gap: 16, marginTop: 16, justifyContent: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textMuted }}><div style={{ width: 12, height: 12, borderRadius: 2, background: "rgba(239,68,68,0.7)" }} /> Loss</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textMuted }}><div style={{ width: 12, height: 12, borderRadius: 2, background: COLORS.border + "40" }} /> No trades</div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textMuted }}><div style={{ width: 12, height: 12, borderRadius: 2, background: "rgba(34,197,94,0.7)" }} /> Profit</div>
            </div>
          </div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, marginTop: 20 }}>
            <SectionHeader icon={BarChart3} title="Monthly Performance" />
            {(() => {
              const mo = {}; Object.entries(dailyPnl).forEach(([d, v]) => { if (!d.startsWith(String(calendarYear))) return; const m = d.slice(0, 7); if (!mo[m]) mo[m] = { pnl: 0, trades: 0, wins: 0 }; mo[m].pnl += v.pnl; mo[m].trades += v.trades.length; mo[m].wins += v.wins; });
              const md = MONTHS.map((name, i) => ({ name, ...(mo[calendarYear + "-" + String(i + 1).padStart(2, "0")] || { pnl: 0, trades: 0, wins: 0 }) }));
              return (<ResponsiveContainer width="100%" height={240}><BarChart data={md}><CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} /><XAxis dataKey="name" tick={{ fontSize: 11, fill: COLORS.textMuted }} /><YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmt(v, 0)} /><RechartsTooltip content={<CustomTooltip />} /><Bar dataKey="pnl" radius={[4, 4, 0, 0]}>{md.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? COLORS.profit : COLORS.loss} fillOpacity={0.8} />)}</Bar></BarChart></ResponsiveContainer>);
            })()}
          </div>
        </div>)}

        {activeTab === "analytics" && (<div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, marginBottom: 20 }}>
            <SectionHeader icon={BarChart3} title="Performance by Asset" subtitle={"Top " + assetData.length + " assets by absolute PnL"} />
            <ResponsiveContainer width="100%" height={Math.max(200, assetData.length * 36)}>
              <BarChart data={assetData} layout="vertical"><CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} horizontal={false} /><XAxis type="number" tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmt(v, 0)} /><YAxis type="category" dataKey="coin" tick={{ fontSize: 12, fill: COLORS.text, fontWeight: 600 }} width={60} /><RechartsTooltip content={<CustomTooltip />} /><Bar dataKey="pnl" radius={[0, 4, 4, 0]}>{assetData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? COLORS.profit : COLORS.loss} fillOpacity={0.8} />)}</Bar></BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, marginBottom: 20, overflowX: "auto" }}>
            <SectionHeader icon={Activity} title="Asset Breakdown" />
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ borderBottom: "1px solid " + COLORS.border }}>{["Asset","Trades","Wins","Losses","Win Rate","PnL"].map(h => <th key={h} style={{ textAlign: h === "Asset" ? "left" : "right", padding: "10px 12px", color: COLORS.textMuted, fontWeight: 600, fontSize: 11, letterSpacing: 0.5 }}>{h}</th>)}</tr></thead>
              <tbody>{assetData.map((d, i) => (
                <tr key={i} style={{ borderBottom: "1px solid " + COLORS.border + "20" }} onMouseEnter={e => e.currentTarget.style.background = COLORS.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{d.coin}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{d.count}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: COLORS.profit, fontFamily: "'JetBrains Mono', monospace" }}>{d.wins}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: COLORS.loss, fontFamily: "'JetBrains Mono', monospace" }}>{d.losses}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{d.count > 0 ? ((d.wins / d.count) * 100).toFixed(1) : 0}%</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: pnlColor(d.pnl), fontFamily: "'JetBrains Mono', monospace" }}>{fmt(d.pnl)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border }}>
            <SectionHeader icon={Clock} title="Time-of-Day Profitability" subtitle="PnL by hour (UTC)" />
            <ResponsiveContainer width="100%" height={240}><BarChart data={hourData}><CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} /><XAxis dataKey="label" tick={{ fontSize: 9, fill: COLORS.textMuted }} interval={1} /><YAxis tick={{ fontSize: 10, fill: COLORS.textMuted }} tickFormatter={v => fmt(v, 0)} /><RechartsTooltip content={<CustomTooltip />} /><Bar dataKey="pnl" radius={[3, 3, 0, 0]}>{hourData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? COLORS.profit : COLORS.loss} fillOpacity={0.75} />)}</Bar></BarChart></ResponsiveContainer>
          </div>
        </div>)}

        {activeTab === "execution" && (<div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, marginBottom: 20 }}>
            <SectionHeader icon={Target} title="MFE vs MAE Scatter" subtitle="Maximum Favorable vs Adverse Excursion (% from entry)" />
            <ResponsiveContainer width="100%" height={400}>
              <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                <XAxis type="number" dataKey="mae" name="MAE" unit="%" tick={{ fontSize: 10, fill: COLORS.textMuted }} label={{ value: "MAE (%)", position: "bottom", offset: 0, style: { fill: COLORS.textMuted, fontSize: 11 } }} />
                <YAxis type="number" dataKey="mfe" name="MFE" unit="%" tick={{ fontSize: 10, fill: COLORS.textMuted }} label={{ value: "MFE (%)", angle: -90, position: "insideLeft", style: { fill: COLORS.textMuted, fontSize: 11 } }} />
                <ZAxis type="number" dataKey="size" range={[20, 200]} />
                <RechartsTooltip content={({ active, payload }) => { if (!active || !payload?.length) return null; const d = payload[0]?.payload; return (<div style={{ background: "#1a2332", border: "1px solid " + COLORS.border, borderRadius: 8, padding: "10px 14px" }}><div style={{ fontWeight: 700, color: COLORS.text, fontSize: 13, marginBottom: 4 }}>{d.coin}</div><div style={{ fontSize: 12, color: COLORS.textMuted }}>MFE: {d.mfe.toFixed(2)}%</div><div style={{ fontSize: 12, color: COLORS.textMuted }}>MAE: {d.mae.toFixed(2)}%</div><div style={{ fontSize: 12, color: pnlColor(d.pnl), fontWeight: 600 }}>PnL: {fmt(d.pnl)}</div></div>); }} />
                <Scatter data={mfeMaeData.filter(d => d.pnl >= 0)} fill={COLORS.profit} fillOpacity={0.6} name="Winners" />
                <Scatter data={mfeMaeData.filter(d => d.pnl < 0)} fill={COLORS.loss} fillOpacity={0.6} name="Losers" />
                <Legend />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 20 }}>
            <StatCard icon={TrendingUp} label="AVG MFE (WINS)" color={COLORS.profit} value={(trades.filter(t => t.pnl >= 0).reduce((s, t) => s + t.mfe, 0) / Math.max(1, trades.filter(t => t.pnl >= 0).length)).toFixed(2) + "%"} />
            <StatCard icon={TrendingDown} label="AVG MAE (WINS)" color={COLORS.yellow} value={(trades.filter(t => t.pnl >= 0).reduce((s, t) => s + t.mae, 0) / Math.max(1, trades.filter(t => t.pnl >= 0).length)).toFixed(2) + "%"} />
            <StatCard icon={TrendingUp} label="AVG MFE (LOSSES)" color={COLORS.textMuted} value={(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.mfe, 0) / Math.max(1, trades.filter(t => t.pnl < 0).length)).toFixed(2) + "%"} />
            <StatCard icon={TrendingDown} label="AVG MAE (LOSSES)" color={COLORS.loss} value={(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.mae, 0) / Math.max(1, trades.filter(t => t.pnl < 0).length)).toFixed(2) + "%"} />
          </div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 24, border: "1px solid " + COLORS.border, overflowX: "auto" }}>
            <SectionHeader icon={Activity} title="Recent Trades" subtitle={"Last " + Math.min(50, trades.length) + " trades"} />
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ borderBottom: "1px solid " + COLORS.border }}>{["Asset","Side","Entry","Exit","Size","PnL","MFE","MAE","Duration","Fills"].map(h => <th key={h} style={{ textAlign: h === "Asset" || h === "Side" ? "left" : "right", padding: "8px 10px", color: COLORS.textMuted, fontWeight: 600, fontSize: 10, letterSpacing: 0.5, whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
              <tbody>{trades.slice(-50).reverse().map((t, i) => (
                <tr key={i} style={{ borderBottom: "1px solid " + COLORS.border + "15" }} onMouseEnter={e => e.currentTarget.style.background = COLORS.bg} onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "8px 10px", fontWeight: 600 }}>{t.coin}</td>
                  <td style={{ padding: "8px 10px" }}><span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: t.side === "Long" ? COLORS.profitBg : COLORS.lossBg, color: t.side === "Long" ? COLORS.profit : COLORS.loss }}>{t.side.toUpperCase()}</span></td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>${t.entryPrice < 1 ? t.entryPrice.toFixed(5) : t.entryPrice.toFixed(2)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>${t.exitPrice < 1 ? t.exitPrice.toFixed(5) : t.exitPrice.toFixed(2)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{t.size < 1 ? t.size.toFixed(6) : t.size.toFixed(2)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: 700, color: pnlColor(t.pnl), fontFamily: "'JetBrains Mono', monospace" }}>{fmt(t.pnl)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: COLORS.profit, fontFamily: "'JetBrains Mono', monospace" }}>{t.mfe.toFixed(2)}%</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: COLORS.loss, fontFamily: "'JetBrains Mono', monospace" }}>{t.mae.toFixed(2)}%</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: COLORS.textMuted }}>{fmtDuration(t.duration)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: COLORS.textMuted }}>{t.fillCount}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>)}

        {activeTab === "verify" && (<div>
          <div style={{ background: COLORS.card, borderRadius: 14, padding: 32, border: "1px solid " + COLORS.border, textAlign: "center", maxWidth: 560, margin: "0 auto" }}>
            <div style={{ width: 64, height: 64, borderRadius: 16, margin: "0 auto 20px", background: COLORS.accent + "15", display: "flex", alignItems: "center", justifyContent: "center" }}><Shield size={28} color={COLORS.accent} /></div>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Verified PnL</h2>
            <p style={{ color: COLORS.textMuted, fontSize: 14, marginBottom: 28, lineHeight: 1.6 }}>Generate a unique verification URL showcasing on-chain performance.{isDemo && <><br /><span style={{ color: COLORS.demo, fontSize: 12 }}>Demo mode — generates a sample URL.</span></>}</p>
            <div style={{ background: COLORS.bg, borderRadius: 12, padding: 20, marginBottom: 20, border: "1px solid " + COLORS.border, textAlign: "left" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <div><div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>Address</div><div style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: COLORS.text }}>{isDemo ? "Demo Account" : address.slice(0, 10) + "..." + address.slice(-6)}</div></div>
                <div><div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>Total Trades</div><div style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace", color: COLORS.text }}>{stats.totalTrades}</div></div>
                <div><div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>Net PnL</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: pnlColor(stats.totalPnl) }}>{fmt(stats.totalPnl)}</div></div>
                <div><div style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 4 }}>Win Rate</div><div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: COLORS.text }}>{stats.winRate.toFixed(1)}%</div></div>
              </div>
              <ResponsiveContainer width="100%" height={100}><AreaChart data={stats.equityCurve}><defs><linearGradient id="vG" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.accent} stopOpacity={0.3} /><stop offset="100%" stopColor={COLORS.accent} stopOpacity={0} /></linearGradient></defs><Area type="monotone" dataKey="pnl" stroke={COLORS.accent} strokeWidth={2} fill="url(#vG)" /></AreaChart></ResponsiveContainer>
            </div>
            {!verifyUrl ? (
              <button onClick={generateVerifyUrl} style={{ background: "linear-gradient(135deg, " + COLORS.accent + ", " + COLORS.accentMuted + ")", border: "none", borderRadius: 12, color: "white", padding: "14px 32px", cursor: "pointer", fontWeight: 700, fontSize: 15, display: "inline-flex", alignItems: "center", gap: 8, boxShadow: "0 4px 16px rgba(99,102,241,0.3)" }}><Shield size={18} /> Generate Verification URL</button>
            ) : (
              <div style={{ background: COLORS.bg, borderRadius: 10, padding: "12px 16px", border: "1px solid " + COLORS.accent + "40", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 13, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace", overflow: "hidden", textOverflow: "ellipsis" }}>{verifyUrl}</span>
                <button onClick={() => copyToClipboard(verifyUrl)} style={{ background: COLORS.accent, border: "none", borderRadius: 6, color: "white", padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copied!" : "Copy"}</button>
              </div>
            )}
            <p style={{ color: COLORS.textMuted, fontSize: 11, marginTop: 16, fontStyle: "italic" }}>Verification based on on-chain data from Hyperliquid L1.</p>
          </div>
        </div>)}
      </div>
      {selectedDay && <DayDetail date={selectedDay.date} data={selectedDay.data} onClose={() => setSelectedDay(null)} />}
    </div>
  );
}