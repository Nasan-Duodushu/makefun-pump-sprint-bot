// Selective dip-buyer for the pump.fun replay sprint (agent-fun/replay/v2).
//
// Why this shape: on the dev window almost every coin bleeds to zero, so
// momentum-chasing buys tops and the curve fee plus per-tx fees punish
// churn. The house momentum and reversion pilots both finish underwater on
// the calibration window while holding cash finishes at zero, so this bot's
// first job is not losing. It trades rarely and only into coins that have
// already been punished — down roughly a third to a half from a recent high
// on a curve with real depth — and only once the tape says the dip is being
// bought (most of the last handful of trades are buys, the latest one
// included, net flow non-negative) and the price has stopped falling.
// Positions are small and exits are mechanical; a per-coin cooldown stops
// re-entering a falling knife, and if equity ever falls a quarter from its
// peak the bot stops opening new risk entirely.
//
// Deterministic: decisions depend only on slots, reserves and trade events
// in the batches the harness sends — no clock, no randomness, no I/O — so
// the two graded executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);

/** Marginal price in SOL per token from post-trade reserves. */
function quotePrice(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens === 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

interface CoinTape {
  /** [slot, price] samples, oldest first. */
  prices: Array<[number, number]>;
  /** [isBuy, sol] for recent trades, oldest first. */
  flow: Array<[boolean, number]>;
  firstSlot: number;
  /** Ignore this coin until this slot after an exit. */
  ignoreUntil: number;
}

interface OpenTrade {
  entry: number;
  enteredSlot: number;
  best: number;
}

export interface DipParams {
  /** A coin must be at least this old (slots since first seen) to trade. */
  minAge: number;
  /** Real SOL depth band a curve must sit in at decision time. */
  depthLo: number;
  depthHi: number;
  /** Minimum TradeEvents seen on the curve. */
  minTrades: number;
  /** Lookback (slots) for the recent high the drawdown is measured from. */
  highLookback: number;
  /** Enter only this far below the recent high (fraction). */
  dipLo: number;
  dipHi: number;
  /** Price must have moved within this band over the stabilisation window. */
  calmWindow: number;
  calmLo: number;
  calmHi: number;
  /** Tape window (trades) and the buys required inside it. */
  tapeTrades: number;
  tapeBuys: number;
  /** Fraction of free cash risked per entry. */
  riskFrac: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuyLamports: bigint;
  /** Exit: take profit / stop loss as price move from entry. */
  takeProfit: number;
  stopLoss: number;
  /** Trailing exit once up this far, giving back this much from the best. */
  trailArm: number;
  trailGiveback: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** Ignore a coin this long after an exit. */
  cooldownSlots: number;
  /** Stop opening new positions once equity falls below this share of peak. */
  equityFloor: number;
  /** Slippage tolerance on every order (bps). */
  slippageBps: number;
}

export const PARAMS: DipParams = {
  minAge: 300,
  depthLo: 5,
  depthHi: 100,
  minTrades: 40,
  highLookback: 1500,
  dipLo: 0.4,
  dipHi: 0.55,
  calmWindow: 60,
  calmLo: -0.02,
  calmHi: 0.05,
  tapeTrades: 10,
  tapeBuys: 8,
  riskFrac: 0.04,
  minBuyLamports: 30_000_000n,
  takeProfit: 0.15,
  stopLoss: -0.08,
  trailArm: 0.12,
  trailGiveback: 0.08,
  maxHoldSlots: 500,
  cooldownSlots: 900,
  equityFloor: 0.75,
  slippageBps: 900,
};

export function createStrategy(p: DipParams = PARAMS) {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenTrade>();
  const awaiting = new Map<string, Pubkey>();
  let buySeq = 0;
  let equityPeak = 0;

  function tapeFor(mint: Pubkey, slot: number): CoinTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { prices: [], flow: [], firstSlot: slot, ignoreUntil: -1 };
      tapes.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;

    // Fold fills in first: a buy that filled opens a trade, a sell that
    // filled (including the harness's own closes) ends one and cools the coin.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && awaiting.has(fill.client_id)) {
        const mint = awaiting.get(fill.client_id)!;
        awaiting.delete(fill.client_id);
        if (fill.status !== 'filled') continue;
        const tokens = Number(fill.token_amount);
        if (tokens > 0) {
          const entry = Number(fill.quote_lamports) / tokens;
          open.set(mint, { entry, enteredSlot: slot, best: entry });
        }
      } else if (fill.side === 'sell' && fill.status === 'filled') {
        open.delete(fill.mint);
        const t = tapes.get(fill.mint);
        if (t !== undefined) t.ignoreUntil = slot + p.cooldownSlots;
      }
    }

    // Record this batch's trades on their tapes.
    for (const ev of batch.events) {
      if (ev.event !== 'TradeEvent') continue;
      const t = tapeFor(ev.mint, slot);
      t.flow.push([ev.is_buy, Number(ev.sol_amount) / SOL]);
      if (t.flow.length > 32) t.flow.splice(0, t.flow.length - 32);
      const price = quotePrice(BigInt(ev.virtual_quote_reserves), BigInt(ev.virtual_token_reserves));
      if (price > 0) {
        t.prices.push([slot, price]);
        if (t.prices.length > 500) t.prices.splice(0, t.prices.length - 500);
      }
    }

    // Equity estimate (cash + positions at latest curve prices) for the halt.
    let equity = Number(state.cash);
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve !== undefined) {
        equity += Number(pos.token_amount) * quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      }
    }
    if (equity > equityPeak) equityPeak = equity;
    const halted = equityPeak > 0 && equity < equityPeak * p.equityFloor;

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const inFlightSell = (mint: Pubkey): boolean => {
      for (const o of state.pending.values()) {
        if (o.order.side === 'sell' && o.order.mint === mint) return true;
      }
      return false;
    };

    // Exits first: take profit, stop loss, trailing giveback, or stale.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      const trade = open.get(mint);
      if (curve === undefined || trade === undefined || curve.complete) continue;
      const price = quotePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price <= 0) continue;
      if (price > trade.best) trade.best = price;
      const move = price / trade.entry - 1;
      const stale = slot - trade.enteredSlot > p.maxHoldSlots;
      const trailing = move > p.trailArm && price < trade.best * (1 - p.trailGiveback);
      if (move <= p.stopLoss || move >= p.takeProfit || trailing || stale) {
        if (!inFlightSell(mint)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.slippageBps });
        }
        if (orders.length >= maxOrders) return orders;
      }
    }

    // Entries: punished, stabilising, and being bought — best dip first.
    if (!halted && state.committedPositionCount() < state.hello.caps.max_open_positions) {
      const candidates: Array<{ mint: Pubkey; merit: number }> = [];
      for (const [mint, curve] of state.curves) {
        if (curve.complete || state.positions.has(mint)) continue;
        let buyPending = false;
        for (const o of state.pending.values()) {
          if (o.order.side === 'buy' && o.order.mint === mint) {
            buyPending = true;
            break;
          }
        }
        if (buyPending) continue;
        const t = tapes.get(mint);
        if (t === undefined || slot < t.ignoreUntil) continue;
        if (slot - t.firstSlot < p.minAge) continue;
        const depth = Number(curve.real_quote_reserves) / SOL;
        if (depth < p.depthLo || depth > p.depthHi) continue;
        if (curve.trades < p.minTrades) continue;
        if (t.prices.length < 12 || t.flow.length < p.tapeTrades) continue;

        const now = t.prices[t.prices.length - 1]![1];
        let high = 0;
        let earlier: number | null = null;
        for (let i = t.prices.length - 1; i >= 0; i--) {
          const [s, px] = t.prices[i]!;
          if (slot - s > p.highLookback) break;
          if (px > high) high = px;
          // The calm reference must be a real sample near the window edge,
          // not a stale one from a coin that barely trades.
          if (earlier === null && slot - s >= p.calmWindow && slot - s <= p.calmWindow + 120) earlier = px;
        }
        if (high <= 0 || earlier === null) continue;
        const dip = 1 - now / high;
        if (dip < p.dipLo || dip > p.dipHi) continue;
        const calm = now / earlier - 1;
        if (calm < p.calmLo || calm > p.calmHi) continue;

        const recent = t.flow.slice(-p.tapeTrades);
        if (!recent[recent.length - 1]![0]) continue;
        let buys = 0;
        let net = 0;
        for (const [isBuy, sol] of recent) {
          if (isBuy) {
            buys += 1;
            net += sol;
          } else {
            net -= sol;
          }
        }
        if (buys < p.tapeBuys || net < 0) continue;
        candidates.push({ mint, merit: dip * Math.log(1 + depth) });
      }
      candidates.sort((a, b) => b.merit - a.merit || (a.mint < b.mint ? -1 : 1));
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const c of candidates) {
        if (room <= 0 || orders.length >= maxOrders) break;
        const cap = state.maxBuyLamports(c.mint);
        const want = BigInt(Math.floor(Number(state.freeCashLamports()) * p.riskFrac));
        const amount = want < cap ? want : cap;
        if (amount < p.minBuyLamports) continue;
        buySeq += 1;
        const id = `d${buySeq}`;
        awaiting.set(id, c.mint);
        orders.push({ side: 'buy', client_id: id, mint: c.mint, quote_lamports: amount, max_slippage_bps: p.slippageBps });
        room -= 1;
      }
    }
    return orders;
  }

  return { onBatch };
}
