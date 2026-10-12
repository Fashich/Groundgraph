"""Real data source: Solana mainnet spot swaps and SOL transfers through the Helius enhanced transactions API.

STATUS: written against the documented Helius response shapes and unit tested with MOCKED HTTP only (see
tests/test_helius.py and tests/fixtures/helius/*.json, which are hand written to match the documented format).
It has NOT been run against the live API in this repository's build environment (no API key, no network).

What it does
  1. seed_universe   wallets that swapped the allow-listed assets recently (plus the largest holders of each mint)
  2. backfill        120 days of enhanced transactions per wallet, resumable (checkpoints in indexer_state), rate limited
  3. storage         swaps as pseudo-node edges (dex:<ASSET> <-> wallet) and SOL transfers as wallet edges in wallet_edges
  4. load_dataset    prices from Pyth Benchmarks, virtual markets, positions, balances reconstructed from SOL flows

A swap becomes a trade of one of six assets (SOL, BTC, ETH, JUP, WIF, BONK): buying the asset is a bullish (ABOVE)
position, selling it a bearish (BELOW) one, in the virtual close markets built from the price history.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
import psycopg

from .. import store
from ..config import ASSETS, DAY, DS_HELIUS, USDC_MINT, USDT_MINT, WSOL_MINT, Params, Settings
from ..dataset import Dataset, DatasetBuilder
from ..prices import PriceSeries
from .http import HttpError, JsonClient, RateLimiter
from .pyth import PythBenchmarks

log = logging.getLogger("scorer.helius")

API_BASE = "https://api.helius.xyz"
RPC_BASE = "https://mainnet.helius-rpc.com"
LAMPORTS = 1e9
SYSTEM_PROGRAM = "11111111111111111111111111111111"
STABLE_MINTS = {USDC_MINT, USDT_MINT}
MIN_TRADE_USD = 10.0  # ignore dust swaps
MIN_NATIVE_LEG_SOL = 0.05  # a native SOL leg smaller than this is a fee or tip, not part of a swap
MIN_EDGE_USD = 1.0  # smaller SOL transfers are ignored (dust, rent)
STATE_UNIVERSE = "scorer:helius:universe"
STATE_CHECKPOINT = "scorer:helius:checkpoint"
STATE_BALANCES = "scorer:helius:balances"

MINT_TO_ASSET = {v["mint"]: k for k, v in ASSETS.items()}  # includes the wrapped SOL mint
DEX = "dex:"


class HeliusError(RuntimeError):
    pass


def dex_node(asset: str) -> str:
    return DEX + asset


# --------------------------------------------------------------------------- client
class HeliusClient:
    """Thin wrapper over the enhanced transactions REST API and the JSON-RPC endpoint (rate limited, with retries)."""

    def __init__(self, api_key: str, enhanced: JsonClient, rpc: JsonClient, api_base: str = API_BASE, rpc_base: str = RPC_BASE):
        if not api_key:
            raise HeliusError("HELIUS_API_KEY is not set")
        self.key = api_key
        self.enhanced, self.rpc_client = enhanced, rpc
        self.api_base, self.rpc_base = api_base.rstrip("/"), rpc_base.rstrip("/")

    @classmethod
    def from_settings(cls, s: Settings, budget: int | None = None) -> "HeliusClient":
        enh = JsonClient(limiter=RateLimiter(s.helius_enhanced_rps), secrets=[s.helius_api_key], budget=budget)
        rpc = JsonClient(limiter=RateLimiter(s.helius_rpc_rps), secrets=[s.helius_api_key], budget=budget)
        return cls(s.helius_api_key, enh, rpc)

    @property
    def requests_made(self) -> int:
        return self.enhanced.requests_made + self.rpc_client.requests_made

    def enhanced_transactions(self, address: str, before: str | None = None, limit: int = 100, tx_type: str | None = None) -> list[dict]:
        params: dict = {"api-key": self.key, "limit": limit}
        if before:
            params["before"] = before
        if tx_type:
            params["type"] = tx_type
        out = self.enhanced.get_json(f"{self.api_base}/v0/addresses/{address}/transactions", params=params)
        if not isinstance(out, list):
            raise HeliusError("unexpected enhanced transactions response")
        return out

    def rpc(self, method: str, params: list) -> object:
        doc = self.rpc_client.post_json(self.rpc_base + "/", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, params={"api-key": self.key})
        if isinstance(doc, dict) and doc.get("error"):
            raise HeliusError(f"rpc {method} failed: {str(doc['error'])[:200]}")
        return doc.get("result") if isinstance(doc, dict) else None

    def largest_holders(self, mint: str, limit: int = 20) -> list[str]:
        """Owners of the largest token accounts of a mint (the whales of that asset)."""
        res = self.rpc("getTokenLargestAccounts", [mint]) or {}
        owners: list[str] = []
        for acc in (res.get("value") or [])[:limit]:
            info = self.rpc("getAccountInfo", [acc["address"], {"encoding": "jsonParsed"}]) or {}
            owner = (((info.get("value") or {}).get("data") or {}).get("parsed") or {}).get("info", {}).get("owner")
            if owner and owner not in owners:
                owners.append(owner)
        return owners

    def balance_lamports(self, address: str) -> int | None:
        res = self.rpc("getBalance", [address])
        if isinstance(res, dict) and "value" in res:
            return int(res["value"])
        return None


# --------------------------------------------------------------------------- parsing (pure)
PriceAt = Callable[[str, float], float | None]


@dataclass(frozen=True)
class SwapTrade:
    asset: str
    side: int  # +1 bought the asset, -1 sold it
    usd: float
    ts: float
    sig: str


def _legs(tx: dict, wallet: str) -> tuple[dict[str, float], dict[str, float]]:
    """Amounts (UI units) the wallet received and sent in the transaction, keyed by mint (native SOL under the wSOL mint)."""
    got: dict[str, float] = {}
    sent: dict[str, float] = {}
    for t in tx.get("tokenTransfers") or []:
        mint, amt = t.get("mint"), t.get("tokenAmount")
        if not mint or amt is None:
            continue
        a = float(amt)
        if t.get("toUserAccount") == wallet and t.get("fromUserAccount") != wallet:
            got[mint] = got.get(mint, 0.0) + a
        elif t.get("fromUserAccount") == wallet and t.get("toUserAccount") != wallet:
            sent[mint] = sent.get(mint, 0.0) + a
    nat_in = nat_out = 0.0
    for n in tx.get("nativeTransfers") or []:
        amt = float(n.get("amount", 0)) / LAMPORTS
        if n.get("toUserAccount") == wallet and n.get("fromUserAccount") != wallet:
            nat_in += amt
        elif n.get("fromUserAccount") == wallet and n.get("toUserAccount") != wallet:
            nat_out += amt
    if nat_in >= MIN_NATIVE_LEG_SOL:
        got[WSOL_MINT] = got.get(WSOL_MINT, 0.0) + nat_in
    if nat_out >= MIN_NATIVE_LEG_SOL:
        sent[WSOL_MINT] = sent.get(WSOL_MINT, 0.0) + nat_out
    return got, sent


def _usd(mint: str, amount: float, ts: float, price_at: PriceAt) -> float | None:
    if mint in STABLE_MINTS:
        return amount
    asset = MINT_TO_ASSET.get(mint)
    if asset is None:
        return None
    p = price_at(asset, ts)
    return None if p is None else amount * p


def swap_trades(tx: dict, wallet: str, price_at: PriceAt) -> list[SwapTrade]:
    """Trades of allow-listed assets made by `wallet` in one enhanced SWAP transaction.

    Every allow-listed asset the wallet received is a buy, every allow-listed asset it sent is a sell. The USD size is
    the value of what the wallet paid (or received) on the other side of the swap, from stable coins at face value and
    from the Pyth price for other allow-listed assets. Dust and swaps that cannot be valued are dropped.
    """
    if tx.get("type") != "SWAP" or tx.get("transactionError") or tx.get("transaction_error"):
        return []
    ts = float(tx.get("timestamp") or 0)
    sig = str(tx.get("signature") or "")
    if ts <= 0 or not sig:
        return []
    got, sent = _legs(tx, wallet)
    out: list[SwapTrade] = []
    for side, mine, other in ((1, got, sent), (-1, sent, got)):
        for mint, amt in sorted(mine.items()):
            asset = MINT_TO_ASSET.get(mint)
            if asset is None or amt <= 0:
                continue
            counter = [v for m, a in other.items() if m != mint for v in [_usd(m, a, ts, price_at)] if v is not None]
            usd = sum(counter) if counter else _usd(mint, amt, ts, price_at)
            if usd is None or usd < MIN_TRADE_USD:
                continue
            out.append(SwapTrade(asset, side, float(usd), ts, sig))
    return out


@dataclass(frozen=True)
class NativeEdge:
    src: str
    dst: str
    usd: float
    ts: float
    sig: str


def native_edges(tx: dict, price_at: PriceAt) -> list[NativeEdge]:
    """SOL transfers between two accounts, valued in USD at the transaction time (dust and system program flows dropped)."""
    ts = float(tx.get("timestamp") or 0)
    sig = str(tx.get("signature") or "")
    if ts <= 0 or not sig or tx.get("transactionError"):
        return []
    p = price_at("SOL", ts)
    if p is None:
        return []
    out: dict[tuple[str, str], float] = {}
    for n in tx.get("nativeTransfers") or []:
        a, b = n.get("fromUserAccount"), n.get("toUserAccount")
        if not a or not b or a == b or SYSTEM_PROGRAM in (a, b):
            continue
        out[(a, b)] = out.get((a, b), 0.0) + float(n.get("amount", 0)) / LAMPORTS * p
    return [NativeEdge(a, b, usd, ts, sig) for (a, b), usd in sorted(out.items()) if usd >= MIN_EDGE_USD]


def first_funder(txs: Iterable[dict], wallet: str, min_sol: float = 0.01) -> tuple[str, float] | None:
    """(funder, timestamp) of the earliest inbound SOL transfer of at least min_sol into the wallet, or None."""
    best: tuple[float, str, str] | None = None
    for tx in txs:
        ts = float(tx.get("timestamp") or 0)
        if ts <= 0 or tx.get("transactionError"):
            continue
        for n in tx.get("nativeTransfers") or []:
            if n.get("toUserAccount") == wallet and n.get("fromUserAccount") not in (None, wallet, SYSTEM_PROGRAM) and float(n.get("amount", 0)) / LAMPORTS >= min_sol:
                cand = (ts, str(tx.get("signature") or ""), n["fromUserAccount"])
                if best is None or cand < best:
                    best = cand
    return None if best is None else (best[2], best[0])


def reconstruct_balances(current_usd: float, flows: list[tuple[float, float]], snapshot_ts: Iterable[float]) -> list[tuple[float, float]]:
    """Weekly balance proxy by walking SOL flows backwards from the current balance.

    flows are (ts, signed USD) with +amount received and -amount sent. balance(t) = current - sum of flows after t,
    floored at zero. Only SOL movements are known, so token holdings are not part of this proxy.
    """
    fl = sorted(flows)
    out = []
    for t in sorted(snapshot_ts):
        after = sum(v for ts, v in fl if ts > t)
        out.append((float(t), max(0.0, current_usd - after)))
    return out


# --------------------------------------------------------------------------- source
class HeliusSource:
    name = "helius"
    label = DS_HELIUS

    def __init__(self, client: HeliusClient, pyth: PythBenchmarks, params: Params, backfill_days: int = 120, universe_size: int = 300,
                 holders_per_mint: int = 10, seed_pages: int = 5, wallet_pages: int = 20):
        self.client, self.pyth, self.params = client, pyth, params
        self.backfill_days, self.universe_size = backfill_days, universe_size
        self.holders_per_mint, self.seed_pages, self.wallet_pages = holders_per_mint, seed_pages, wallet_pages

    @classmethod
    def from_settings(cls, settings: Settings, params: Params) -> "HeliusSource":
        import os

        budget = int(os.environ.get("HELIUS_MAX_REQUESTS_PER_RUN", "3000"))
        client = HeliusClient.from_settings(settings, budget=budget)
        key = os.environ.get("PYTH_API_KEY", "")
        pyth = PythBenchmarks(settings.pyth_benchmarks_url, JsonClient(limiter=RateLimiter(5.0), secrets=[key, settings.helius_api_key]), api_key=key)
        return cls(client, pyth, params, backfill_days=settings.helius_backfill_days)

    # ---- seeding
    def seed_universe(self, now: float) -> list[str]:
        """Wallets that swapped the allow-listed assets recently, most active first, plus the largest holders of each mint."""
        counts: dict[str, int] = {}
        lo = now - 14 * DAY
        for asset, meta in sorted(ASSETS.items()):
            before = None
            for _ in range(self.seed_pages):
                try:
                    txs = self.client.enhanced_transactions(meta["mint"], before=before, limit=100, tx_type="SWAP")
                except HttpError as e:
                    log.warning("seeding %s stopped: %s", asset, e)
                    break
                if not txs:
                    break
                for tx in txs:
                    if float(tx.get("timestamp") or 0) >= lo and tx.get("feePayer"):
                        counts[tx["feePayer"]] = counts.get(tx["feePayer"], 0) + 1
                before = txs[-1].get("signature")
                if float(txs[-1].get("timestamp") or 0) < lo or len(txs) < 100:
                    break
        ranked = [w for w, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])) if c >= 2][: self.universe_size]
        holders: list[str] = []
        for asset, meta in sorted(ASSETS.items()):
            try:
                holders += self.client.largest_holders(meta["mint"], self.holders_per_mint)
            except (HttpError, HeliusError) as e:
                log.warning("holders of %s skipped: %s", asset, e)
        seen = set(ranked)
        return ranked + [h for h in holders if not (h in seen or seen.add(h))]

    # ---- backfill
    def backfill_wallet(self, conn: psycopg.Connection, wallet: str, now: float, cp: dict, price_at: PriceAt) -> dict:
        """Page one wallet's history backwards until the window start. Writes edges and returns the updated checkpoint."""
        horizon = now - self.backfill_days * DAY
        before = cp.get("before")
        funder = cp.get("funder")
        done = False
        pages = 0
        while pages < self.wallet_pages and not self.client.enhanced.exhausted():
            txs = self.client.enhanced_transactions(wallet, before=before, limit=100)
            pages += 1
            rows: list[tuple] = []
            for tx in txs:
                ts = float(tx.get("timestamp") or 0)
                if ts < horizon:
                    continue
                for t in swap_trades(tx, wallet, price_at):
                    a, b = (dex_node(t.asset), wallet) if t.side > 0 else (wallet, dex_node(t.asset))
                    rows.append((a, b, t.asset, t.usd, t.ts, t.sig))
                if tx.get("type") != "SWAP":  # SOL legs of a swap are pool flows, not wallet to wallet relationships
                    for e in native_edges(tx, price_at):
                        if wallet in (e.src, e.dst):
                            rows.append((e.src, e.dst, "SOL", e.usd, e.ts, e.sig))
                f = first_funder([tx], wallet)
                if f and (funder is None or f[1] < funder[1]):
                    funder = list(f)
            if rows:
                store.insert_edges(conn, rows, DS_HELIUS)
            if txs:
                before = txs[-1].get("signature")
            oldest = float(txs[-1].get("timestamp") or 0) if txs else 0.0
            if len(txs) < 100 or oldest < horizon:
                done = True
                break
        return {"before": before, "done": done, "funder": funder, "pages": cp.get("pages", 0) + pages}

    def backfill(self, conn: psycopg.Connection, now: float, max_wallets: int | None = None) -> dict:
        """Seed (once) and continue the backfill. Safe to call repeatedly: checkpoints make it resumable and idempotent."""
        prices = self.pyth.load_series(
            sorted(ASSETS), now - (self.backfill_days + 2) * DAY, now,
            cache_get=lambda k: store.load_state(conn, k), cache_put=lambda k, v: store.save_state(conn, k, v),
        )
        conn.commit()

        def price_at(asset: str, ts: float) -> float | None:
            ps = prices.get(asset)
            return None if ps is None or ts < ps.t0 else float(ps.at(ts))

        uni = store.load_state(conn, STATE_UNIVERSE)
        if not uni or not uni.get("wallets"):
            uni = {"wallets": self.seed_universe(now), "seeded_at": now}
            store.save_state(conn, STATE_UNIVERSE, uni)
            conn.commit()
        cps = store.load_state(conn, STATE_CHECKPOINT) or {"wallets": {}}
        conn.commit()
        n_done = n_new = 0
        for w in uni["wallets"]:
            cp = cps["wallets"].get(w, {})
            if cp.get("done"):
                continue
            if self.client.enhanced.exhausted() or (max_wallets is not None and n_new >= max_wallets):
                break
            try:
                cps["wallets"][w] = self.backfill_wallet(conn, w, now, cp, price_at)
            except HttpError as e:
                log.warning("wallet %s skipped for this run: %s", w, e)
                continue
            n_new += 1
            store.save_state(conn, STATE_CHECKPOINT, cps)  # checkpoint after every wallet: a crash loses at most one
            conn.commit()
        n_done = sum(1 for c in cps["wallets"].values() if c.get("done"))
        bal = store.load_state(conn, STATE_BALANCES) or {}
        for w in uni["wallets"]:
            if w not in bal and cps["wallets"].get(w, {}).get("done") and not self.client.rpc_client.exhausted():
                try:
                    lam = self.client.balance_lamports(w)
                except (HttpError, HeliusError):
                    continue
                if lam is not None:
                    bal[w] = {"lamports": lam, "ts": now}
        store.save_state(conn, STATE_BALANCES, bal)
        conn.commit()
        return {"universe": len(uni["wallets"]), "wallets_done": n_done, "wallets_this_run": n_new, "requests": self.client.requests_made}

    # ---- dataset
    def load_dataset(self, conn: psycopg.Connection, now: float) -> Dataset:
        """Backfill what the request budget allows, then assemble the Dataset from wallet_edges and the price history."""
        summary = self.backfill(conn, now)
        log.info("helius backfill: %s", summary)
        return self.build_dataset(conn, now)

    def build_dataset(self, conn: psycopg.Connection, now: float) -> Dataset:
        from ..timeutil import floor_to

        end = floor_to(now, DAY)
        start = end - self.backfill_days * DAY
        prices = self.pyth.load_series(
            sorted(ASSETS), start - DAY, end, cache_get=lambda k: store.load_state(conn, k), cache_put=lambda k, v: store.save_state(conn, k, v)
        )
        conn.commit()
        uni = (store.load_state(conn, STATE_UNIVERSE) or {}).get("wallets", [])
        cps = (store.load_state(conn, STATE_CHECKPOINT) or {}).get("wallets", {})
        bal = store.load_state(conn, STATE_BALANCES) or {}
        conn.commit()
        wallets = [w for w in uni if cps.get(w, {}).get("done")]
        if len(wallets) < 20:
            raise HeliusError(f"only {len(wallets)} wallets are backfilled so far; the backfill continues on the next run")
        wset = set(wallets)
        with conn.cursor() as cur:
            cur.execute(
                "SELECT src, dst, mint, amount_usd, extract(epoch FROM ts) FROM wallet_edges WHERE data_source = %s AND ts >= to_timestamp(%s) AND ts < to_timestamp(%s)",
                (DS_HELIUS, start, end),
            )
            rows = cur.fetchall()
        conn.commit()
        b = DatasetBuilder(DS_HELIUS, start, end)
        b.prices = prices
        for w in wallets:
            f = (cps[w].get("funder") or [None])[0]
            b.wallet(w, None, f)
        flows: dict[str, list[tuple[float, float]]] = {}
        for src, dst, mint, usd, ts in rows:
            usd, ts = float(usd), float(ts)
            if src.startswith(DEX) or dst.startswith(DEX):
                wal, node = (dst, src) if src.startswith(DEX) else (src, dst)
                if wal in wset:
                    b.trade(wal, node[len(DEX):], 1 if src.startswith(DEX) else -1, usd, ts)
                continue
            if src not in wset and dst not in wset:
                continue
            b.edge(src, dst, usd, ts)
            if mint == "SOL":
                if dst in wset:
                    flows.setdefault(dst, []).append((ts, usd))
                if src in wset:
                    flows.setdefault(src, []).append((ts, -usd))
        if not b._trades:
            raise HeliusError("no swaps found in wallet_edges although wallets are marked as backfilled: the edge table and the "
                              "checkpoint are out of sync (delete the indexer_state key scorer:helius:checkpoint to backfill again)")
        sol_now = float(prices["SOL"].px[-1])
        weeks = np.arange(start, end + 1, 7 * DAY)
        for w in wallets:
            rec = bal.get(w)
            if not rec:
                continue
            cur_usd = rec["lamports"] / LAMPORTS * sol_now
            for t, v in reconstruct_balances(cur_usd, flows.get(w, []), weeks.tolist()):
                b.balance(w, t, v)
        ds = b.build(self.params)
        ds.meta = {"source": "helius-mainnet", "backfill_days": self.backfill_days, "n_universe": len(uni), "n_backfilled": len(wallets)}
        return ds
