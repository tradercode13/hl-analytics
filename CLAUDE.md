# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server at http://localhost:5173 with HMR
npm run build     # Production build to dist/
npm run lint      # Run ESLint
npm run preview   # Preview production build locally
```

There is no test suite configured.

## Architecture

**hl-analytics** is a trading analytics dashboard for the [Hyperliquid](https://hyperliquid.xyz) DEX. It's a React + Vite SPA.

### Component structure

The app is almost entirely contained in a single large component:

```
src/main.jsx → src/App.jsx → src/hyperliquid-analytics.jsx  (~860 lines, all logic)
```

`App.jsx` is just a thin wrapper that imports and renders `HyperliquidAnalytics`.

### Data flow

Three data sources feed into the same processing pipeline:

1. **Live API** — POST to `https://api.hyperliquid.xyz/info` with `userFills` or `clearinghouseState` payloads. Pagination up to 50 pages × 2000 fills, 200ms delay between requests.
2. **Wallet connection** — MetaMask/Web3 address auto-populates the address field.
3. **Demo data** — `generateDemoFills()` uses a seeded Mulberry32 PRNG to produce ~700 reproducible synthetic trades across 10 assets over 8 months.

All paths funnel into `processHyperliquidFills()`, a position state machine that converts raw fills into closed trades with PnL, fees, MFE/MAE, streaks, and per-asset/hourly aggregates.

### UI tabs

The dashboard has 5 tabs rendered from state: Dashboard, PnL Calendar, Analytics, Execution, Verify. Timeframe filtering (1D/1W/1M/1Y/YTD/All) slices the processed trade array before computing displayed metrics.

### Styling

- Tailwind CSS v4 (via `@tailwindcss/vite` plugin) for utility classes
- Dark theme throughout; green `#22c55e` for profit, red `#ef4444` for loss, indigo `#6366f1` for accents
- Most component styling uses inline JS style objects, not Tailwind classes
- Charts: Recharts library
- Icons: Lucide React

### ESLint note

The flat config (`eslint.config.js`) ignores unused vars that start with an uppercase letter — this allows React component names and constants to be declared without triggering the rule.

## GitHub workflow

Always use the GitHub CLI (`gh`) for all GitHub operations — creating repos, PRs, issues, releases, etc. Never use the GitHub web UI or raw `git push` for operations that `gh` can handle.
