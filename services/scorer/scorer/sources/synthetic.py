"""Deterministic synthetic wallet universe. DEMO_MODE ONLY. Everything it produces is labelled 'demo-synthetic'.

What is planted (so the model has real, noisy signal to learn, and so the pipeline can be exercised end to end):

* six behaviour clusters (names are NOT stored, the pipeline derives names from observed behaviour)
* informed wallets that trade ahead of price jumps (lead time and direction accuracy differ per wallet, never perfect)
* herd wallets that chase jumps after the fact (good looking hit rate, no early entries)
* whales (very large balances) that informed wallets link to more often than crowd wallets
* funding sources: a few exchange like hubs with huge fan-out plus three sybil operators whose wallets copy one leader
* a year of price paths for six assets with random walk diffusion plus permanent jumps

The real world differs in many ways, see MODEL_CARD.md ("How demo-synthetic differs from real data").
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..config import DAY, DEFAULT_VOL, DS_SYNTHETIC, HOUR, YEAR_SECONDS, Params
from ..dataset import Dataset, DatasetBuilder
from ..prices import PriceSeries
from ..timeutil import floor_to
from ..types import OpenMarket, PositionRow
from . import b58encode

START_PRICES = {"SOL": 214.0, "BTC": 118000.0, "ETH": 4200.0, "JUP": 0.94, "WIF": 2.4, "BONK": 0.0000318}

# (weight, P(informed), trades/day, median trade USD, median lead minutes, links per wallet, P(whale link), P(bridge), P(chase a jump))
CLUSTER_SPECS = [
    # Early LP cohort
    dict(w=0.15, smart=0.50, tpd=0.25, size=6000.0, lead=90.0, deg=6, whale=0.30, bridge=0.15, chase=0.00),
    # Momentum desks
    dict(w=0.14, smart=0.42, tpd=0.90, size=2500.0, lead=40.0, deg=7, whale=0.15, bridge=0.20, chase=0.15),
    # MEV searchers
    dict(w=0.12, smart=0.30, tpd=2.00, size=400.0, lead=8.0, deg=9, whale=0.05, bridge=0.10, chase=0.02),
    # Treasury rotators
    dict(w=0.13, smart=0.40, tpd=0.12, size=20000.0, lead=120.0, deg=5, whale=0.60, bridge=0.45, chase=0.00),
    # Retail flow
    dict(w=0.26, smart=0.04, tpd=0.40, size=180.0, lead=60.0, deg=4, whale=0.04, bridge=0.05, chase=0.06),
    # Airdrop farmers
    dict(w=0.20, smart=0.03, tpd=0.70, size=40.0, lead=60.0, deg=5, whale=0.01, bridge=0.03, chase=0.04),
]


@dataclass(frozen=True)
class SyntheticConfig:
    seed: int = 20261012
    n_wallets: int = 320
    days: int = 365
    step_s: float = 300.0
    assets: tuple = ("SOL", "BTC", "ETH", "JUP", "WIF", "BONK")
    jumps_per_week: float = 2.0
    n_whales: int = 6
    n_hubs: int = 5
    sybil_groups: tuple = (5, 4, 6)  # sizes; first two live in the farmer cluster, the third among momentum desks


def _addr(rng: np.random.Generator) -> str:
    """A syntactically valid Solana address: base58 of 32 random bytes (always decodes to 32 bytes)."""
    raw = bytes(rng.integers(0, 256, size=32, dtype=np.uint8).tolist())
    return b58encode(raw)


class SyntheticSource:
    name = "synthetic"
    label = DS_SYNTHETIC

    def __init__(self, cfg: SyntheticConfig | None = None, params: Params | None = None):
        self.cfg = cfg or SyntheticConfig()
        self.params = params or Params()

    # ------------------------------------------------------------------ world
    def build_dataset(self, as_of: float) -> Dataset:
        cfg, params = self.cfg, self.params
        end = floor_to(as_of, DAY)
        start = end - cfg.days * DAY
        ss = np.random.SeedSequence(cfg.seed)
        r_price, r_wal, r_jump, r_trade, r_edge, r_bal, r_misc = [np.random.default_rng(s) for s in ss.spawn(7)]

        # ---- price paths and jump events
        n = int(cfg.days * DAY / cfg.step_s) + 1
        dt = cfg.step_s / YEAR_SECONDS
        prices: dict[str, PriceSeries] = {}
        jumps: list[tuple[float, int, int, float]] = []  # (ts, asset idx, dir, size)
        for ai, a in enumerate(cfg.assets):
            sig = DEFAULT_VOL[a]
            days_idx = (np.arange(n - 1) * cfg.step_s // DAY).astype(int)
            regime = np.exp(0.25 * np.convolve(r_price.standard_normal(cfg.days + 10), np.ones(5) / 5, mode="same"))[days_idx]
            sd_ = 0.7 * sig * regime  # diffusion share; jumps supply the rest of the realised volatility
            r = -0.5 * sd_ ** 2 * dt + sd_ * np.sqrt(dt) * r_price.standard_normal(n - 1)
            k = r_jump.poisson(cfg.jumps_per_week * cfg.days / 7.0)
            tj = np.sort(r_jump.uniform(3 * DAY, cfg.days * DAY - 2 * DAY, size=k))
            dj = np.where(r_jump.random(k) < 0.5, -1, 1)
            sj = np.clip(np.exp(r_jump.normal(np.log(0.05), 0.4, size=k)), 0.03, 0.12)
            bar = np.clip(np.round(tj / cfg.step_s).astype(int), 1, n - 1)
            np.add.at(r, bar - 1, np.log1p(dj * sj))  # signed jump: +s up, -s down (in price terms)
            logp = np.log(START_PRICES[a]) + np.concatenate([[0.0], np.cumsum(r)])
            prices[a] = PriceSeries(a, start, cfg.step_s, np.exp(logp), DEFAULT_VOL[a])
            for t_, d_, s_ in zip(bar.tolist(), dj.tolist(), sj.tolist()):
                jumps.append((start + t_ * cfg.step_s, ai, int(d_), float(s_)))
        jumps.sort()
        jumps_per_day = max(len(jumps) / cfg.days, 1e-9)

        # ---- wallets
        nW = cfg.n_wallets
        weights = np.array([c["w"] for c in CLUSTER_SPECS])
        cl = r_wal.choice(len(CLUSTER_SPECS), size=nW, p=weights / weights.sum())
        smart_p = np.array([CLUSTER_SPECS[c]["smart"] for c in cl])
        informed = r_wal.random(nW) < smart_p
        acc = r_wal.uniform(0.68, 0.90, size=nW)
        acc_view = r_wal.uniform(0.62, 0.82, size=nW)
        early = r_wal.random(nW) < 0.75
        fs = np.where(early, r_wal.uniform(0, 0.40, nW), r_wal.uniform(0.40, 0.95, nW)) * cfg.days * DAY + start
        rate = np.array([CLUSTER_SPECS[c]["tpd"] for c in cl]) * np.exp(r_wal.normal(0, 0.4, nW))
        addrs = []
        seen = set()
        while len(addrs) < nW + cfg.n_whales + cfg.n_hubs + len(cfg.sybil_groups):
            a = _addr(r_wal)
            if a not in seen:
                seen.add(a)
                addrs.append(a)
        wal = addrs[:nW]
        whales = addrs[nW:nW + cfg.n_whales]
        hubs = addrs[nW + cfg.n_whales:nW + cfg.n_whales + cfg.n_hubs]
        operators = addrs[nW + cfg.n_whales + cfg.n_hubs:]

        # sybil groups: members copy the leader (first member). Farmers = cluster 5, momentum = cluster 1
        group = np.full(nW, -1)
        leader_of = np.full(nW, -1)
        pools = {5: np.nonzero((cl == 5) & ~informed)[0].tolist(), 1: np.nonzero((cl == 1) & ~informed)[0].tolist()}
        for g, size in enumerate(cfg.sybil_groups):
            c = 1 if g == len(cfg.sybil_groups) - 1 else 5
            members, pools[c] = pools[c][:size], pools[c][size:]
            if len(members) < size:  # tiny universes: take what is available
                pass
            for m in members:
                group[m] = g
                leader_of[m] = members[0]
            if members:
                informed[members[0]] = True
                acc[members[0]] = 0.86
                rate[members[0]] = max(rate[members[0]], 0.8)

        b = DatasetBuilder(DS_SYNTHETIC, start, end)
        b.prices = prices

        # funding: hubs fund most wallets, sybil members are funded by their operator, hubs fund operators
        funding: list[str] = []
        for i in range(nW):
            if group[i] >= 0:
                funding.append(operators[group[i]])
            elif r_wal.random() < 0.8:
                funding.append(hubs[r_wal.integers(0, len(hubs))])
            else:
                j = int(r_wal.integers(0, nW))
                funding.append(wal[j] if j != i and fs[j] < fs[i] else hubs[r_wal.integers(0, len(hubs))])
        for i in range(nW):
            b.wallet(wal[i], float(fs[i]), funding[i])
        op_hub = [hubs[int(r_misc.integers(0, len(hubs)))] for _ in operators]
        for o, oh in zip(operators, op_hub):
            b.node(o, start + 1 * DAY, oh)
        for h in hubs:
            b.node(h, start)
        for wh in whales:
            b.wallet(wh, start + float(r_misc.uniform(0, 5)) * DAY, hubs[int(r_misc.integers(0, len(hubs)))])
        for i in range(nW):  # funding transfers (hub or operator or friend -> wallet)
            b.edge(funding[i], wal[i], float(np.exp(r_edge.normal(np.log(1500), 0.8))), float(fs[i] - HOUR))
        for o, oh in zip(operators, op_hub):
            b.edge(oh, o, 25000.0, start + 1 * DAY - HOUR)

        # ---- trades
        def size_of(i: int, informed_trade: bool, k: int) -> np.ndarray:
            med = CLUSTER_SPECS[cl[i]]["size"] * (3.0 if informed_trade else 1.0)
            return np.clip(np.exp(r_trade.normal(np.log(med), 0.9 if not informed_trade else 0.7, size=k)), 5.0, 5e5)

        asset_p = np.ones(len(cfg.assets)) / len(cfg.assets)
        leader_trades: dict[int, list[tuple[float, str, int, float]]] = {}
        for i in range(nW):
            span = max(end - fs[i], DAY)
            noise_rate = rate[i] * (0.4 if informed[i] else 1.0) * (0.25 if (group[i] >= 0 and leader_of[i] != i) else 1.0)
            k = r_trade.poisson(noise_rate * span / DAY)
            if k:
                ts = r_trade.uniform(fs[i], end - 21 * DAY if end - 21 * DAY > fs[i] + DAY else end, size=k)
                ai = r_trade.choice(len(cfg.assets), size=k, p=asset_p)
                sd = np.where(r_trade.random(k) < 0.5, -1, 1)
                if informed[i]:
                    # "view" trades: the wallet leans towards the 21 day ahead return with its own accuracy
                    for q_ in range(k):
                        ps_ = prices[cfg.assets[ai[q_]]]
                        fwd = float(ps_.at(min(ts[q_] + 21 * DAY, ps_.end_ts)) - ps_.at(ts[q_]))
                        true_dir = 1 if fwd > 0 else -1
                        sd[q_] = true_dir if r_trade.random() < acc_view[i] else -true_dir
                us = size_of(i, False, k)
                for t_, a_, s_, u_ in zip(ts.tolist(), ai.tolist(), sd.tolist(), us.tolist()):
                    b.trade(wal[i], cfg.assets[a_], s_, u_, t_)
                    if group[i] >= 0 and leader_of[i] == i:
                        leader_trades.setdefault(i, []).append((t_, cfg.assets[a_], int(s_), u_))

        informed_idx = np.nonzero(informed & (group < 0) | (leader_of == np.arange(nW)))[0]
        pi = np.minimum(0.85, 0.8 * rate / jumps_per_day)
        chase_p = np.array([CLUSTER_SPECS[c]["chase"] for c in cl])
        for (tau, ai, d, sz) in jumps:
            a = cfg.assets[ai]
            alive = fs < tau - DAY
            # informed wallets trade ahead of the jump, in its direction with probability acc
            part = informed_idx[(alive[informed_idx]) & (r_trade.random(informed_idx.size) < pi[informed_idx])]
            for i in part.tolist():
                lead_min = float(np.clip(np.exp(r_trade.normal(np.log(CLUSTER_SPECS[cl[i]]["lead"]), 0.5)), 2.0, 240.0))
                side = d if r_trade.random() < acc[i] else -d
                t_ = tau - lead_min * 60.0
                u_ = float(size_of(i, True, 1)[0])
                b.trade(wal[i], a, side, u_, t_)
                if leader_of[i] == i and group[i] >= 0:
                    leader_trades.setdefault(i, []).append((t_, a, side, u_))
            # herd wallets chase after the fact
            ch = np.nonzero(alive & (~informed) & (r_trade.random(nW) < chase_p))[0]
            for i in ch.tolist():
                b.trade(wal[i], a, d, float(size_of(i, False, 1)[0]), tau + float(r_trade.uniform(10, 300)) * 60.0)
        # sybil clones copy their leader a few minutes later, with smaller size
        for m in range(nW):
            ld = leader_of[m]
            if ld >= 0 and ld != m:
                for (t_, a, side, u_) in leader_trades.get(int(ld), []):
                    if r_trade.random() < 0.9 and t_ + 120 > fs[m]:
                        b.trade(wal[m], a, side, u_ * 0.5, t_ + float(r_trade.normal(0.0, 120.0)))

        # ---- transfer edges between wallets
        by_cluster = {c: np.nonzero(cl == c)[0] for c in range(len(CLUSTER_SPECS))}
        links: set[tuple[str, str]] = set()
        link_list: list[tuple[str, str]] = []

        def add_link(x: str, y: str) -> None:
            if x == y:
                return
            key = (x, y) if x < y else (y, x)
            if key not in links:
                links.add(key)
                link_list.append(key)

        for i in range(nW):
            spec = CLUSTER_SPECS[cl[i]]
            peers = by_cluster[int(cl[i])]
            kdeg = max(1, int(r_edge.poisson(spec["deg"] / 2.0)))
            for j in r_edge.choice(peers, size=min(kdeg, peers.size), replace=False).tolist():
                add_link(wal[i], wal[j])
            if group[i] >= 0:  # sybil members transact with each other
                for j in np.nonzero(group == group[i])[0].tolist():
                    add_link(wal[i], wal[j])
            wl_p = spec["whale"] * (2.0 if informed[i] else 1.0)
            if cfg.n_whales and r_edge.random() < min(wl_p, 0.95):
                for wh in r_edge.choice(whales, size=int(r_edge.integers(1, 4)), replace=False).tolist():
                    add_link(wal[i], wh)
            if r_edge.random() < spec["bridge"]:
                for _ in range(int(r_edge.integers(1, 3))):
                    oc = int(r_edge.integers(0, len(CLUSTER_SPECS)))
                    if oc != cl[i] and by_cluster[oc].size:
                        add_link(wal[i], wal[int(r_edge.choice(by_cluster[oc]))])
        idx_of = {a: k for k, a in enumerate(wal)}
        for x, y in link_list:
            ix, iy = idx_of.get(x), idx_of.get(y)
            lo = max(fs[ix] if ix is not None else start, fs[iy] if iy is not None else start)
            m_ = r_edge.poisson(max(2.0, (end - lo) / DAY / 12.0))
            if m_ == 0:
                continue
            ts = r_edge.uniform(lo, end, size=m_)
            med = np.sqrt(CLUSTER_SPECS[cl[ix if ix is not None else iy]]["size"] * 400.0)
            us = np.exp(r_edge.normal(np.log(med), 0.9, size=m_))
            fwd = r_edge.random(m_) < 0.5
            for t_, u_, f_ in zip(ts.tolist(), us.tolist(), fwd.tolist()):
                b.edge(x if f_ else y, y if f_ else x, u_, t_)

        # ---- balances: weekly snapshots, whales are by far the largest tracked holders
        weeks = np.arange(start, end + 1, 7 * DAY)
        for i in range(nW):
            base = CLUSTER_SPECS[cl[i]]["size"] * float(np.exp(r_bal.normal(1.5, 0.7)))
            walk = np.exp(np.cumsum(r_bal.normal(0, 0.05, weeks.size)))
            for t_, v_ in zip(weeks.tolist(), (base * walk).tolist()):
                b.balance(wal[i], t_, v_)
        for wh in whales:
            base = float(np.exp(r_bal.uniform(np.log(5e6), np.log(5e7))))
            walk = np.exp(np.cumsum(r_bal.normal(0, 0.03, weeks.size)))
            for t_, v_ in zip(weeks.tolist(), (base * walk).tolist()):
                b.balance(wh, t_, v_)

        b.meta = {
            "latent": {
                wal[i]: {"cluster": int(cl[i]), "informed": bool(informed[i]), "accuracy": float(acc[i]), "sybil_group": int(group[i])}
                for i in range(nW)
            },
            "whales": list(whales),
            "hubs": list(hubs),
            "operators": list(operators),
            "n_jumps": len(jumps),
        }
        return b.build(params)

    # ------------------------------------------------------------------ current open markets
    def current_positions(self, ds: Dataset, markets: list[OpenMarket], now: float) -> list[PositionRow]:
        """Positions of the synthetic wallets in the CURRENT open markets (deterministic per market id).

        Each market gets a hidden 'latent outcome' drawn from its own price. Informed wallets lean towards it
        (accuracy differs per wallet), crowd wallets are random. How many informed wallets take part varies by
        market, so some markets have a strong radar signal and some stay in the Building state.
        """
        out: list[PositionRow] = []
        latent = ds.meta.get("latent", {})
        wallets = sorted(latent)
        for m in sorted(markets, key=lambda x: x.id):
            if m.p_market is None:
                continue
            rng = np.random.default_rng(np.random.SeedSequence([self.cfg.seed, hash_str(m.id)]))
            p = float(np.clip(m.p_market, 0.03, 0.97))
            truth = 1 if rng.random() < p else -1
            attention = float(rng.uniform(0.03, 0.40))
            liq = m.liquidity_usd if m.liquidity_usd > 0 else 500.0
            horizon_end = max(min(now, m.trading_end_ts), m.open_ts + 60.0)
            leader_pos: dict[int, tuple[int, float, float]] = {}
            for w in wallets:
                info = latent[w]
                take = rng.random() < (attention if info["informed"] else 0.04)
                if not take:
                    continue
                g = info["sybil_group"]
                if info["informed"]:
                    side = truth if rng.random() < info["accuracy"] else -truth
                    frac = float(np.exp(rng.normal(np.log(0.06), 0.5)))
                    u = (rng.beta(1.3, 3.0))
                else:
                    side = 1 if rng.random() < 0.5 else -1
                    frac = float(np.exp(rng.normal(np.log(0.015), 0.8)))
                    u = rng.random()
                usd = float(np.clip(frac * liq, 1.0, 0.25 * liq))
                ts = m.open_ts + u * (horizon_end - m.open_ts)
                price = float(np.clip(p + rng.normal(0.0, 0.03) - 0.02 * side * (1 if info["informed"] else 0), 0.02, 0.98))
                out.append(PositionRow(m.id, w, "above" if side > 0 else "below", round(usd * 1e6), price, float(ts), DS_SYNTHETIC))
        return out


def hash_str(s: str) -> int:
    """Stable (process independent) string hash."""
    import zlib

    return zlib.crc32(s.encode())
