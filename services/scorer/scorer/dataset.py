"""In-memory dataset the whole pipeline works on, plus virtual market and position derivation.

Design notes
------------
* Wallet behaviour is represented as spot swap TRADES of allow-listed assets (buy = bullish, sell = bearish).
  Both the synthetic world and the Helius mainnet backfill produce this same shape.
* Trades are mapped to VIRTUAL close markets ("asset above or below strike at settle") that are built purely
  from the price history. A trade becomes a POSITION on the ABOVE side (buy) or BELOW side (sell).
* Everything a feature needs about the future of a position (did the market price move 5 cents in my favour
  within the next 24h, which side won) is stored per position together with the timestamps at which that
  information becomes known. Feature code only reads it once as_of has passed those timestamps. The leakage
  test truncates the dataset at as_of, rebuilds everything and checks the features are unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .config import DAY, HOUR, YEAR_SECONDS, Params
from .fairvalue import digital_close_prob
from .prices import PriceSeries

SIDE_ABOVE = 1
SIDE_BELOW = -1


@dataclass
class HistMarket:
    id: str
    asset: str
    strike: float
    open_ts: float
    settle_ts: float
    outcome: int  # +1 settled ABOVE, -1 settled BELOW, 0 not resolved (yet)


@dataclass
class Positions:
    wallet: np.ndarray  # node index
    market: np.ndarray  # index into Dataset.markets
    side: np.ndarray  # +1 ABOVE, -1 BELOW
    usd: np.ndarray  # total USD put into this (wallet, market, side)
    first_ts: np.ndarray
    entry_price: np.ndarray  # virtual market ABOVE price at the first trade
    settle_ts: np.ndarray
    outcome: np.ndarray  # market outcome, 0 if unresolved
    win: np.ndarray  # +1 correct side, -1 wrong side, 0 unresolved
    pnl: np.ndarray  # realised PnL in USD if resolved else 0
    fav_ts: np.ndarray  # first time the price moved >= move_size in the position's favour within the horizon, inf if never
    ptr: np.ndarray  # CSR pointers by wallet (positions sorted by wallet then first_ts)
    trade_pos: np.ndarray  # position index of every dataset trade, -1 if unassigned

    @property
    def n(self) -> int:
        return int(self.wallet.size)

    def of_wallet(self, w: int) -> slice:
        return slice(int(self.ptr[w]), int(self.ptr[w + 1]))


def _empty_positions(n_nodes: int, n_trades: int) -> Positions:
    z = np.zeros(0)
    return Positions(
        z.astype(np.int32), z.astype(np.int32), z.astype(np.int8), z.copy(), z.copy(), z.copy(), z.copy(),
        z.astype(np.int8), z.astype(np.int8), z.copy(), z.copy(), np.zeros(n_nodes + 1, dtype=np.int64),
        np.full(n_trades, -1, dtype=np.int32),
    )


@dataclass
class Dataset:
    label: str
    start_ts: float
    end_ts: float
    nodes: list[str]
    is_wallet: np.ndarray
    first_seen: np.ndarray
    funding: list
    e_src: np.ndarray
    e_dst: np.ndarray
    e_usd: np.ndarray
    e_ts: np.ndarray
    b_node: np.ndarray
    b_ts: np.ndarray
    b_usd: np.ndarray
    assets: list[str]
    t_wallet: np.ndarray
    t_asset: np.ndarray
    t_side: np.ndarray
    t_usd: np.ndarray
    t_ts: np.ndarray
    prices: dict[str, PriceSeries]
    markets: list[HistMarket] = field(default_factory=list)
    positions: Positions | None = None
    meta: dict = field(default_factory=dict)
    _index: dict | None = field(default=None, repr=False)

    # ------------------------------------------------------------------ helpers
    @property
    def n_nodes(self) -> int:
        return len(self.nodes)

    @property
    def index(self) -> dict[str, int]:
        if self._index is None:
            self._index = {a: i for i, a in enumerate(self.nodes)}
        return self._index

    def wallet_ids(self) -> np.ndarray:
        return np.nonzero(self.is_wallet)[0]

    def finalize(self, params: Params) -> "Dataset":
        """Sort arrays by time, build virtual markets and derive positions."""
        for name in ("e", "t", "b"):
            ts = getattr(self, f"{name}_ts")
            order = np.argsort(ts, kind="stable")
            for suffix in {"e": ("src", "dst", "usd", "ts"), "t": ("wallet", "asset", "side", "usd", "ts"), "b": ("node", "ts", "usd")}[name]:
                attr = f"{name}_{suffix}"
                setattr(self, attr, getattr(self, attr)[order])
        self.markets = build_virtual_markets(self.prices, params)
        self.positions = derive_positions(self, params)
        return self

    def truncate(self, as_of: float, params: Params) -> "Dataset":
        """Return the dataset as it was known at as_of (everything later is removed, nothing is peeked)."""
        em = self.e_ts <= as_of
        tm = self.t_ts <= as_of
        bm = self.b_ts <= as_of
        fs = np.where(self.first_seen <= as_of, self.first_seen, np.nan)
        funding = [f if (not np.isnan(fs[i])) else None for i, f in enumerate(self.funding)]
        prices = {a: p.truncate(as_of) for a, p in self.prices.items() if p.t0 <= as_of}
        ds = Dataset(
            label=self.label, start_ts=self.start_ts, end_ts=min(self.end_ts, as_of), nodes=self.nodes,
            is_wallet=self.is_wallet, first_seen=fs, funding=funding,
            e_src=self.e_src[em], e_dst=self.e_dst[em], e_usd=self.e_usd[em], e_ts=self.e_ts[em],
            b_node=self.b_node[bm], b_ts=self.b_ts[bm], b_usd=self.b_usd[bm],
            assets=self.assets, t_wallet=self.t_wallet[tm], t_asset=self.t_asset[tm], t_side=self.t_side[tm],
            t_usd=self.t_usd[tm], t_ts=self.t_ts[tm], prices=prices, meta=self.meta,
        )
        return ds.finalize(params)


class DatasetBuilder:
    """Convenience builder (tests, small fixtures, DB loaders)."""

    def __init__(self, label: str, start_ts: float, end_ts: float):
        self.label, self.start_ts, self.end_ts = label, start_ts, end_ts
        self._nodes: dict[str, dict] = {}
        self._edges: list[tuple[str, str, float, float]] = []
        self._bal: list[tuple[str, float, float]] = []
        self._trades: list[tuple[str, str, int, float, float]] = []
        self.prices: dict[str, PriceSeries] = {}
        self.meta: dict = {}

    def node(self, addr: str, first_seen: float | None = None, funding: str | None = None, wallet: bool | None = None) -> None:
        d = self._nodes.setdefault(addr, {"fs": None, "fund": None, "wallet": False})
        if first_seen is not None:
            d["fs"] = first_seen if d["fs"] is None else min(d["fs"], first_seen)
        if funding is not None:
            d["fund"] = funding
        if wallet is not None:
            d["wallet"] = bool(wallet) or d["wallet"]

    def wallet(self, addr: str, first_seen: float | None = None, funding: str | None = None) -> None:
        self.node(addr, first_seen, funding, True)

    def edge(self, src: str, dst: str, usd: float, ts: float) -> None:
        self.node(src)
        self.node(dst)
        self._edges.append((src, dst, float(usd), float(ts)))

    def balance(self, addr: str, ts: float, usd: float) -> None:
        self.node(addr)
        self._bal.append((addr, float(ts), float(usd)))

    def trade(self, wallet: str, asset: str, side: int, usd: float, ts: float) -> None:
        self.wallet(wallet)
        self._trades.append((wallet, asset, int(side), float(usd), float(ts)))

    def build(self, params: Params) -> Dataset:
        # funders must exist as nodes so two hop chains can be followed
        for addr in list(self._nodes):
            f = self._nodes[addr]["fund"]
            if f is not None:
                self.node(f)
        nodes = sorted(self._nodes)
        idx = {a: i for i, a in enumerate(nodes)}
        n = len(nodes)
        fs = np.full(n, np.nan)
        funding: list = [None] * n
        iw = np.zeros(n, dtype=bool)
        for a, d in self._nodes.items():
            i = idx[a]
            if d["fs"] is not None:
                fs[i] = d["fs"]
            funding[i] = d["fund"]
            iw[i] = d["wallet"]
        # first_seen defaults to the earliest edge or trade the node takes part in
        for s, t, _, ts in self._edges:
            for a in (s, t):
                i = idx[a]
                if np.isnan(fs[i]) or ts < fs[i]:
                    fs[i] = ts
        for w, _, _, _, ts in self._trades:
            i = idx[w]
            if np.isnan(fs[i]) or ts < fs[i]:
                fs[i] = ts
        assets = sorted(self.prices)
        aidx = {a: i for i, a in enumerate(assets)}
        ds = Dataset(
            label=self.label, start_ts=self.start_ts, end_ts=self.end_ts, nodes=nodes, is_wallet=iw, first_seen=fs,
            funding=funding,
            e_src=np.array([idx[e[0]] for e in self._edges], dtype=np.int32),
            e_dst=np.array([idx[e[1]] for e in self._edges], dtype=np.int32),
            e_usd=np.array([e[2] for e in self._edges], dtype=np.float64),
            e_ts=np.array([e[3] for e in self._edges], dtype=np.float64),
            b_node=np.array([idx[b[0]] for b in self._bal], dtype=np.int32),
            b_ts=np.array([b[1] for b in self._bal], dtype=np.float64),
            b_usd=np.array([b[2] for b in self._bal], dtype=np.float64),
            assets=assets,
            t_wallet=np.array([idx[t[0]] for t in self._trades], dtype=np.int32),
            t_asset=np.array([aidx[t[1]] for t in self._trades], dtype=np.int8),
            t_side=np.array([t[2] for t in self._trades], dtype=np.int8),
            t_usd=np.array([t[3] for t in self._trades], dtype=np.float64),
            t_ts=np.array([t[4] for t in self._trades], dtype=np.float64),
            prices=self.prices, meta=self.meta,
        )
        return ds.finalize(params)


# --------------------------------------------------------------------------- virtual markets
_OFFSETS = (-0.06, -0.03, -0.01, 0.0, 0.01, 0.03, 0.06)


def _nice(x: float) -> float:
    """Round a price to 3 significant digits (strike levels look like real round targets)."""
    if x <= 0:
        return x
    mag = 10 ** (np.floor(np.log10(x)) - 2)
    return float(np.round(x / mag) * mag)


def build_virtual_markets(prices: dict[str, PriceSeries], params: Params) -> list[HistMarket]:
    """Deterministic virtual close markets: one new market per asset every market_open_every_h hours.

    The strike depends only on the spot price at the open time and the event counter, so the market set of a
    truncated price history is a prefix of the full one (needed for the leakage test).
    """
    horizons = list(params.market_horizons_days)
    out: list[HistMarket] = []
    every = params.market_open_every_h * HOUR
    for asset in sorted(prices):
        ps = prices[asset]
        # skip the first 2 days so the trailing volatility has some data behind it
        t = ps.t0 + 2 * DAY
        k = 0
        while t <= ps.end_ts + 1e-9:
            horizon = horizons[k % len(horizons)] * DAY
            offset = _OFFSETS[k % len(_OFFSETS)]
            spot = float(ps.at(t))
            strike = _nice(spot * (1.0 + offset))
            settle = t + horizon
            outcome = 0
            if settle <= ps.end_ts + 1e-9:
                outcome = 1 if float(ps.at(settle)) > strike else -1
            out.append(HistMarket(f"vm:{asset}:{int(t)}", asset, strike, t, settle, outcome))
            t += every
            k += 1
    return out


def market_price(ps: PriceSeries, m: HistMarket, ts, params: Params):
    """Virtual market ABOVE price (fair value digital option, trailing volatility) at ts."""
    i = ps.idx(ts)
    t = np.asarray(ts, dtype=np.float64)
    T = np.maximum(m.settle_ts - t, 0.0) / YEAR_SECONDS
    return digital_close_prob(ps.px[i], m.strike, T, ps.vol_idx(i), params.p_floor)


# --------------------------------------------------------------------------- positions
def derive_positions(ds: Dataset, params: Params) -> Positions:
    nt = int(ds.t_ts.size)
    if nt == 0 or not ds.markets:
        return _empty_positions(ds.n_nodes, nt)

    markets = ds.markets
    m_open = np.array([m.open_ts for m in markets])
    m_settle = np.array([m.settle_ts for m in markets])
    m_strike = np.array([m.strike for m in markets])
    m_out = np.array([m.outcome for m in markets], dtype=np.int8)
    m_asset = np.array([ds.assets.index(m.asset) if m.asset in ds.assets else -1 for m in markets])
    min_rem = params.min_remaining_h * HOUR

    # 1. map every trade to ONE virtual market: the active market (>= min_remaining left) closest to the money
    t_market = np.full(nt, -1, dtype=np.int64)
    for ai, asset in enumerate(ds.assets):
        sel = np.nonzero(ds.t_asset == ai)[0]
        cand_m = np.nonzero(m_asset == ai)[0]
        if sel.size == 0 or cand_m.size == 0:
            continue
        ps = ds.prices[asset]
        for lo in range(0, sel.size, 4096):
            chunk = sel[lo:lo + 4096]
            ts = ds.t_ts[chunk]
            spot = ps.at(ts)
            ok = (m_open[cand_m][None, :] <= ts[:, None]) & ((m_settle[cand_m][None, :] - ts[:, None]) >= min_rem)
            with np.errstate(divide="ignore"):
                dist = np.abs(np.log(spot[:, None] / m_strike[cand_m][None, :]))
            dist = np.where(ok, dist, np.inf)
            j = np.argmin(dist, axis=1)
            good = np.isfinite(dist[np.arange(chunk.size), j])
            t_market[chunk[good]] = cand_m[j[good]]

    assigned = np.nonzero(t_market >= 0)[0]
    if assigned.size == 0:
        return _empty_positions(ds.n_nodes, nt)

    # 2. group trades into positions (wallet, market, side)
    w = ds.t_wallet[assigned].astype(np.int64)
    mk = t_market[assigned]
    sd = ds.t_side[assigned].astype(np.int64)
    ts = ds.t_ts[assigned]
    usd = ds.t_usd[assigned]
    order = np.lexsort((ts, sd, mk, w))
    w_s, mk_s, sd_s, ts_s, usd_s = w[order], mk[order], sd[order], ts[order], usd[order]
    new_grp = np.ones(order.size, dtype=bool)
    new_grp[1:] = (w_s[1:] != w_s[:-1]) | (mk_s[1:] != mk_s[:-1]) | (sd_s[1:] != sd_s[:-1])
    starts = np.nonzero(new_grp)[0]
    grp_of_sorted = np.cumsum(new_grp) - 1
    g_w, g_m, g_s = w_s[starts], mk_s[starts], sd_s[starts]
    g_first = ts_s[starts]
    g_usd = np.add.reduceat(usd_s, starts)
    ng = starts.size

    # 3. entry price = virtual market ABOVE price at the FIRST trade only (later trades must not change features)
    g_entry = np.zeros(ng)
    g_asset = m_asset[g_m]
    for ai, asset in enumerate(ds.assets):
        gi = np.nonzero(g_asset == ai)[0]
        if gi.size == 0:
            continue
        ps = ds.prices[asset]
        i0 = ps.idx(g_first[gi])
        T = np.maximum(m_settle[g_m[gi]] - g_first[gi], 0.0) / YEAR_SECONDS
        g_entry[gi] = digital_close_prob(ps.px[i0], m_strike[g_m[gi]], T, ps.vol_idx(i0), params.p_floor)

    # 4. future price path: first time the price moves >= move_size in the position's favour within the horizon
    H = params.move_horizon_h * HOUR
    g_fav = np.full(ng, np.inf)
    vol_cache: dict[str, np.ndarray] = {}
    for gi in range(ng):
        asset = ds.assets[int(g_asset[gi])]
        ps = ds.prices[asset]
        if asset not in vol_cache:
            vol_cache[asset] = ps.vol_idx(np.arange(ps.n))
        i0 = int(ps.idx(g_first[gi]))
        steps = int(H // ps.step)
        hi = min(ps.n - 1, i0 + steps)
        if hi <= i0:
            continue
        sl = slice(i0 + 1, hi + 1)
        t_path = ps.t0 + ps.step * np.arange(sl.start, sl.stop)
        T = np.maximum(m_settle[g_m[gi]] - t_path, 0.0) / YEAR_SECONDS
        p_path = digital_close_prob(ps.px[sl], m_strike[g_m[gi]], T, vol_cache[asset][sl], params.p_floor)
        hit = np.nonzero(g_s[gi] * (p_path - g_entry[gi]) >= params.move_size - 1e-12)[0]
        if hit.size:
            g_fav[gi] = t_path[hit[0]]

    # 5. resolution and realised PnL
    g_out = m_out[g_m]
    g_win = np.where(g_out == 0, 0, np.where(g_s * g_out > 0, 1, -1)).astype(np.int8)
    price_side = np.where(g_s > 0, g_entry, 1.0 - g_entry)
    price_side = np.maximum(price_side, params.p_floor)
    g_pnl = np.where(g_win > 0, g_usd * (1.0 / price_side - 1.0), np.where(g_win < 0, -g_usd, 0.0))

    # 6. final order: by wallet then first_ts (CSR by wallet)
    final = np.lexsort((g_first, g_w))
    inv = np.empty(ng, dtype=np.int64)
    inv[final] = np.arange(ng)
    pw = g_w[final]
    ptr = np.zeros(ds.n_nodes + 1, dtype=np.int64)
    np.add.at(ptr, pw + 1, 1)
    ptr = np.cumsum(ptr)
    trade_pos = np.full(nt, -1, dtype=np.int32)
    trade_pos[assigned[order]] = inv[grp_of_sorted].astype(np.int32)

    return Positions(
        wallet=pw.astype(np.int32), market=g_m[final].astype(np.int32), side=g_s[final].astype(np.int8),
        usd=g_usd[final], first_ts=g_first[final], entry_price=g_entry[final], settle_ts=m_settle[g_m[final]],
        outcome=g_out[final], win=g_win[final], pnl=g_pnl[final], fav_ts=g_fav[final], ptr=ptr, trade_pos=trade_pos,
    )


def usd_by_position_asof(ds: Dataset, as_of: float) -> np.ndarray:
    """Total USD of every position counting only trades up to as_of (positions with no trade yet get 0)."""
    pos = ds.positions
    out = np.zeros(pos.n)
    if pos.n == 0:
        return out
    m = (ds.t_ts <= as_of) & (pos.trade_pos >= 0)
    np.add.at(out, pos.trade_pos[m], ds.t_usd[m])
    return out
