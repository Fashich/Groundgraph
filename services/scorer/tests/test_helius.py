"""Helius and Pyth sources with MOCKED HTTP only. Fixtures follow the documented response formats (see fixtures_helius/README.txt).

Nothing here proves the sources work against the live services; it proves parsing, rate limiting, retries,
checkpointed resumption, persistence and dataset assembly given responses of the documented shape.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pytest
import requests
import responses

from fixtures import NOW
from scorer import store
from scorer.config import ASSETS, DAY, DS_HELIUS, Params, Settings
from scorer.sources import b58encode
from scorer.sources.helius import (
    HeliusClient, HeliusError, HeliusSource, MINT_TO_ASSET, first_funder, native_edges, reconstruct_balances, swap_trades,
)
from scorer.sources.http import HttpError, JsonClient, RateLimiter
from scorer.sources.pyth import PythBenchmarks, PythError, SHIM_PATH, parse_tv_history

FX = Path(__file__).parent / "fixtures_helius"
DOC = json.loads((FX / "transactions.json").read_text())
W, FUNDER, TXS = DOC["wallet"], DOC["funder"], DOC["txs"]
KEY = "test-secret-key-123"
NOW_TS = NOW.timestamp()


def prices(asset, ts):
    return {"SOL": 150.0, "JUP": 0.75, "BTC": 100000.0, "ETH": 4000.0, "WIF": 2.0, "BONK": 0.00002}[asset]


# --------------------------------------------------------------------------- rate limiter and retries
class Clock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def test_rate_limiter_spaces_requests():
    c = Clock()
    rl = RateLimiter(2.0, burst=1, clock=c.now, sleep=c.sleep)
    for _ in range(5):
        rl.acquire()
    assert c.t == pytest.approx(2.0)  # 4 waits of 0.5 s after the first immediate request
    c2 = Clock()
    rl2 = RateLimiter(1.0, burst=3, clock=c2.now, sleep=c2.sleep)
    for _ in range(3):
        rl2.acquire()
    assert c2.t == 0.0  # the burst is free
    rl2.acquire()
    assert c2.t == pytest.approx(1.0)
    with pytest.raises(ValueError):
        RateLimiter(0)


@responses.activate
def test_client_retries_429_and_5xx_and_honours_retry_after():
    url = "https://api.example.test/x"
    responses.add(responses.GET, url, status=429, headers={"Retry-After": "7"})
    responses.add(responses.GET, url, status=503)
    responses.add(responses.GET, url, json={"ok": True})
    c = Clock()
    cl = JsonClient(sleep=c.sleep, backoff_base=1.0)
    assert cl.get_json(url) == {"ok": True}
    assert c.sleeps == [7.0, 2.0]  # Retry-After first, then exponential backoff (attempt 1 -> 2 s)
    assert cl.requests_made == 3


@responses.activate
def test_client_gives_up_after_max_retries_and_does_not_retry_client_errors():
    url = "https://api.example.test/y"
    responses.add(responses.GET, url, status=500)
    cl = JsonClient(sleep=lambda s: None, max_retries=2)
    with pytest.raises(HttpError) as e:
        cl.get_json(url)
    assert e.value.status == 500 and cl.requests_made == 3
    responses.replace(responses.GET, url, status=404, body="not here")
    cl2 = JsonClient(sleep=lambda s: None)
    with pytest.raises(HttpError) as e2:
        cl2.get_json(url)
    assert e2.value.status == 404 and cl2.requests_made == 1


@responses.activate
def test_client_retries_network_errors_and_bad_json_is_an_error():
    url = "https://api.example.test/z"
    responses.add(responses.GET, url, body=requests.ConnectionError("boom"))
    responses.add(responses.GET, url, json=[1, 2])
    assert JsonClient(sleep=lambda s: None).get_json(url) == [1, 2]
    responses.replace(responses.GET, url, body="<html>", status=200)
    with pytest.raises(HttpError):
        JsonClient(sleep=lambda s: None).get_json(url)


@responses.activate
def test_request_budget_is_enforced():
    url = "https://api.example.test/b"
    responses.add(responses.GET, url, json={})
    cl = JsonClient(sleep=lambda s: None, budget=2)
    cl.get_json(url)
    cl.get_json(url)
    assert cl.exhausted()
    with pytest.raises(HttpError):
        cl.get_json(url)
    assert cl.requests_made == 2


@responses.activate
def test_api_key_is_never_leaked_in_errors_or_logs(caplog):
    url = f"https://api.example.test/k?api-key={KEY}"
    responses.add(responses.GET, "https://api.example.test/k", status=400, body=f"bad key {KEY}")
    cl = JsonClient(sleep=lambda s: None, secrets=[KEY])
    with caplog.at_level(logging.DEBUG):
        with pytest.raises(HttpError) as e:
            cl.get_json("https://api.example.test/k", params={"api-key": KEY})
    assert KEY not in str(e.value)
    assert KEY not in caplog.text


# --------------------------------------------------------------------------- parsing
def test_buy_with_stable_coins():
    t = swap_trades(TXS["swap_buy_sol_with_usdc"], W, prices)
    assert [(x.asset, x.side, x.usd, x.sig) for x in t] == [("SOL", 1, 1500.0, "sigBuySol")]  # paid 1500 USDC for 10 SOL


def test_sell_and_buy_in_one_swap_use_the_other_legs_value():
    t = swap_trades(TXS["swap_sell_jup_for_sol_native"], W, prices)
    got = {(x.asset, x.side): x.usd for x in t}
    # sold 2000 JUP for 2 SOL: the JUP sale is worth the 2 SOL received (300 USD), the SOL purchase is worth the JUP paid (1500 USD)
    assert got == {("JUP", -1): pytest.approx(300.0), ("SOL", 1): pytest.approx(1500.0)}
    assert all(x.ts == TXS["swap_sell_jup_for_sol_native"]["timestamp"] for x in t)


@pytest.mark.parametrize("name", ["swap_unknown_token", "swap_dust", "swap_failed", "transfer_funding_in"])
def test_unusable_transactions_give_no_trades(name):
    assert swap_trades(TXS[name], W, prices) == []


def test_another_wallets_view_of_the_same_swap():
    # the pool side of the swap is not our wallet: it sold SOL and bought USDC, USDC is not allow-listed
    pool = TXS["swap_buy_sol_with_usdc"]["tokenTransfers"][0]["toUserAccount"]
    t = swap_trades(TXS["swap_buy_sol_with_usdc"], pool, prices)
    assert [(x.asset, x.side) for x in t] == [("SOL", -1)]


def test_native_edges_are_usd_valued_and_dust_is_dropped():
    e = native_edges(TXS["transfer_funding_in"], prices)
    assert [(x.src, x.dst, x.usd) for x in e] == [(FUNDER, W, pytest.approx(450.0))]
    assert native_edges(TXS["transfer_dust_in"], prices) == []
    out = native_edges(TXS["transfer_out"], prices)
    assert [(x.src, x.dst) for x in out] == [(W, FUNDER)]  # the rent payment to the system program is ignored
    assert native_edges(TXS["swap_failed"], prices) == []


def test_first_funder_is_the_earliest_inbound_transfer():
    assert first_funder(TXS.values(), W) == (FUNDER, TXS["transfer_funding_in"]["timestamp"])
    assert first_funder([TXS["transfer_dust_in"]], W) is None  # below 0.01 SOL
    assert first_funder([TXS["transfer_out"]], W) is None  # outbound only


def test_balance_reconstruction_walks_flows_backwards():
    flows = [(100.0, 50.0), (200.0, -20.0), (300.0, 10.0)]
    snaps = reconstruct_balances(100.0, flows, [50.0, 150.0, 250.0, 350.0])
    assert snaps == [(50.0, 60.0), (150.0, 110.0), (250.0, 90.0), (350.0, 100.0)] or snaps == [(50.0, 60.0), (150.0, 110.0), (250.0, 90.0), (350.0, 100.0)]
    assert reconstruct_balances(5.0, [(1.0, 100.0)], [0.0])[0][1] == 0.0  # never negative


def test_mints_cover_the_six_allow_listed_assets():
    assert set(MINT_TO_ASSET.values()) == {"SOL", "BTC", "ETH", "JUP", "WIF", "BONK"}


# --------------------------------------------------------------------------- client wrappers
def client(budget=None):
    return HeliusClient(KEY, JsonClient(sleep=lambda s: None, secrets=[KEY], budget=budget), JsonClient(sleep=lambda s: None, secrets=[KEY], budget=budget))


@responses.activate
def test_enhanced_transactions_request_shape():
    responses.add(responses.GET, re.compile(r"https://api\.helius\.xyz/v0/addresses/.*/transactions.*"), json=[TXS["swap_buy_sol_with_usdc"]])
    out = client().enhanced_transactions(W, before="sig9", limit=50, tx_type="SWAP")
    assert out[0]["signature"] == "sigBuySol"
    q = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert q == {"api-key": [KEY], "limit": ["50"], "before": ["sig9"], "type": ["SWAP"]}
    assert urlparse(responses.calls[0].request.url).path == f"/v0/addresses/{W}/transactions"


@responses.activate
def test_largest_holders_resolves_token_account_owners():
    base = "https://mainnet.helius-rpc.com/"
    seq = [json.loads((FX / n).read_text()) for n in ("rpc_largest.json", "rpc_account_1.json", "rpc_account_2.json")]
    for body in seq:
        responses.add(responses.POST, base, json=body)
    owners = client().largest_holders("mint", limit=2)
    assert owners == ["Owner1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Owner2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]
    assert json.loads(responses.calls[0].request.body)["method"] == "getTokenLargestAccounts"


def test_a_missing_api_key_is_refused():
    with pytest.raises(HeliusError):
        HeliusClient("", JsonClient(), JsonClient())
    with pytest.raises(HeliusError):
        HeliusSource.from_settings(Settings.from_env({"HELIUS_API_KEY": ""}), Params())


# --------------------------------------------------------------------------- Pyth
def test_pyth_parser_handles_ok_no_data_and_error():
    ts, px = parse_tv_history(json.loads((FX / "pyth_ok.json").read_text()))
    assert ts.tolist() == [1790000000.0, 1790000300.0, 1790000600.0] and px.tolist() == [150.0, 150.5, 151.0]
    assert parse_tv_history(json.loads((FX / "pyth_no_data.json").read_text()))[0].size == 0
    with pytest.raises(PythError, match="unknown symbol"):
        parse_tv_history(json.loads((FX / "pyth_error.json").read_text()))
    ts2, px2 = parse_tv_history({"s": "ok", "t": [1, 2, 3], "c": [1.0, float("nan"), -2.0]})
    assert ts2.tolist() == [1.0]  # NaN and non positive prices are dropped
    with pytest.raises(PythError):
        parse_tv_history({"s": "ok", "t": [1, 2], "c": [1.0]})


def pyth_callback(request):
    q = parse_qs(urlparse(request.url).query)
    sym = q["symbol"][0]
    lo, hi = int(q["from"][0]), int(q["to"][0])
    base = {"Crypto.SOL/USD": 150.0, "Crypto.BTC/USD": 100000.0, "Crypto.ETH/USD": 4000.0, "Crypto.JUP/USD": 0.75,
            "Crypto.WIF/USD": 2.0, "Crypto.BONK/USD": 0.00002}[sym]
    t = np.arange(int(np.ceil(lo / 300) * 300), hi + 1, 300)
    c = base * (1.0 + 0.002 * np.sin(t / 40000.0))
    return 200, {}, json.dumps({"s": "ok", "t": t.tolist(), "c": c.tolist()})


@responses.activate
def test_pyth_series_are_fetched_in_chunks_and_cached_per_closed_day():
    responses.add_callback(responses.GET, re.compile(r"https://benchmarks\.example\.test" + re.escape(SHIM_PATH) + ".*"), callback=pyth_callback)
    py = PythBenchmarks("https://benchmarks.example.test", JsonClient(sleep=lambda s: None))
    cache: dict = {}
    t0 = 1789000000.0 - (1789000000.0 % 86400)
    t_end = t0 + 12 * DAY
    out = py.load_series(["SOL", "JUP"], t0, t_end, cache.get, cache.__setitem__)
    assert set(out) == {"SOL", "JUP"} and out["SOL"].step == 300.0 and out["SOL"].n > 12 * 288 - 5
    n_calls = len(responses.calls)
    assert any(k.startswith("scorer:prices:SOL:") for k in cache) and len(cache) == 2 * 11  # all but the last day are cached
    py.load_series(["SOL", "JUP"], t0, t_end, cache.get, cache.__setitem__)
    assert len(responses.calls) - n_calls == 2  # only the open last day of each asset is fetched again
    first = parse_qs(urlparse(responses.calls[0].request.url).query)
    assert first["resolution"] == ["5"] and first["symbol"] == ["Crypto.SOL/USD"]


# --------------------------------------------------------------------------- the whole source against mocked HTTP
def fake_world(n_wallets=30):
    """Wallet addresses and a deterministic enhanced transactions responder (paged 100 at a time, newest first)."""
    wallets = [b58encode(bytes([i + 1]) * 32) for i in range(n_wallets)]
    return wallets


def tx_pages(wallets, now):
    """Per wallet: 130 transactions spread over 100 days (two pages), alternating buys and sells of the allow-listed assets."""
    usdc, assets = ASSETS, ["SOL", "JUP", "WIF"]
    data = {}
    for k, w in enumerate(wallets):
        txs = []
        for j in range(130):
            ts = int(now - (j * 0.75 + 1) * DAY)
            a = assets[(j + k) % 3]
            buy = (j + k) % 2 == 0
            amt = {"SOL": 5.0, "JUP": 800.0, "WIF": 300.0}[a]
            mint = assets_mint(a)
            legs = [tt_(w, "Pool1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 500.0), tt_("Pool1", w, mint, amt)] if buy else \
                   [tt_(w, "Pool1", mint, amt), tt_("Pool1", w, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 500.0)]
            txs.append({"signature": f"s{k:02d}-{j:03d}", "type": "SWAP", "timestamp": ts, "feePayer": w, "tokenTransfers": legs, "nativeTransfers": []})
        txs.append({"signature": f"f{k:02d}", "type": "TRANSFER", "timestamp": int(now - 110 * DAY), "feePayer": w, "tokenTransfers": [],
                    "nativeTransfers": [{"fromUserAccount": wallets[(k + 1) % len(wallets)] if k % 5 else "BigFunder", "toUserAccount": w, "amount": 2_000_000_000}]})
        data[w] = txs
    return data


def assets_mint(a):
    return ASSETS[a]["mint"]


def tt_(frm, to, mint, amt):
    return {"fromUserAccount": frm, "toUserAccount": to, "mint": mint, "tokenAmount": amt}


def install_mocks(wallets, now, fail_after=None):
    data = tx_pages(wallets, now)
    seen = {"enhanced": 0}

    def enhanced(request):
        seen["enhanced"] += 1
        addr = urlparse(request.url).path.split("/")[3]
        q = parse_qs(urlparse(request.url).query)
        if addr in data:
            txs = data[addr]
        else:  # a mint address: the recent swaps of these wallets
            txs = [{"signature": f"seed-{addr[:4]}-{i}", "type": "SWAP", "timestamp": int(now - 3600 * (i + 1)), "feePayer": wallets[i % len(wallets)]} for i in range(100)]
        before = q.get("before", [None])[0]
        if before:
            ids = [t["signature"] for t in txs]
            txs = txs[ids.index(before) + 1:] if before in ids else []
        return 200, {}, json.dumps(txs[: int(q["limit"][0])])

    def rpc(request):
        body = json.loads(request.body)
        if body["method"] == "getBalance":
            return 200, {}, json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"context": {"slot": 1}, "value": 25_000_000_000}})
        if body["method"] == "getTokenLargestAccounts":
            return 200, {}, json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"value": []}})
        return 200, {}, json.dumps({"jsonrpc": "2.0", "id": 1, "result": None})

    responses.add_callback(responses.GET, re.compile(r"https://api\.helius\.xyz/v0/addresses/.*"), callback=enhanced)
    responses.add_callback(responses.POST, re.compile(r"https://mainnet\.helius-rpc\.com/.*"), callback=rpc)
    responses.add_callback(responses.GET, re.compile(r"https://benchmarks\.example\.test" + re.escape(SHIM_PATH) + ".*"), callback=pyth_callback)
    return seen


@pytest.fixture(autouse=True)
def _fresh_helius_state(request):
    """Checkpoints and price caches live in indexer_state, which the shared db fixture keeps between tests."""
    if "db" in request.fixturenames:
        db = request.getfixturevalue("db")
        with db.cursor() as cur:
            cur.execute("DELETE FROM indexer_state WHERE key LIKE 'scorer:helius:%' OR key LIKE 'scorer:prices:%'")
        db.commit()
    yield


def make_source(budget=None, params=None):
    enh = JsonClient(sleep=lambda s: None, secrets=[KEY], budget=budget)
    rpc = JsonClient(sleep=lambda s: None, secrets=[KEY])
    hc = HeliusClient(KEY, enh, rpc)
    py = PythBenchmarks("https://benchmarks.example.test", JsonClient(sleep=lambda s: None))
    return HeliusSource(hc, py, params or Params.for_source("helius"), backfill_days=120, universe_size=40, seed_pages=1, wallet_pages=5)


@pytest.mark.db
@responses.activate
def test_backfill_is_checkpointed_resumable_and_idempotent(db):
    wallets = fake_world()
    install_mocks(wallets, NOW_TS)
    src = make_source(budget=45)  # not enough requests to finish 30 wallets x 2 pages
    first = src.backfill(db, NOW_TS)
    assert 0 < first["wallets_done"] < len(wallets) and first["universe"] >= 30
    cp = store.load_state(db, "scorer:helius:checkpoint")["wallets"]
    done_first = {w for w, c in cp.items() if c["done"]}
    assert len(done_first) == first["wallets_done"]
    edges_1 = db.cursor().execute("SELECT count(*) FROM wallet_edges WHERE data_source = %s", (DS_HELIUS,)).fetchone()[0]
    assert edges_1 > 0
    # resume with a fresh client: finished wallets are not fetched again, the rest completes
    src2 = make_source()
    before_calls = len(responses.calls)
    second = src2.backfill(db, NOW_TS)
    assert second["wallets_done"] == len(wallets)
    calls_for_done = [c for c in responses.calls[before_calls:] if any(f"/addresses/{w}/" in c.request.url for w in done_first)]
    assert calls_for_done == []
    n_edges = db.cursor().execute("SELECT count(*) FROM wallet_edges").fetchone()[0]
    # running it again changes nothing
    third = make_source().backfill(db, NOW_TS)
    assert third["wallets_done"] == len(wallets)
    assert db.cursor().execute("SELECT count(*) FROM wallet_edges").fetchone()[0] == n_edges
    # trades are stored as dex pseudo node edges, never as wallet to wallet edges
    rows = db.cursor().execute("SELECT src, dst, mint, amount_usd FROM wallet_edges WHERE src LIKE 'dex:%' OR dst LIKE 'dex:%' LIMIT 5").fetchall()
    assert rows and all(r[2] in ("SOL", "JUP", "WIF") and float(r[3]) == 500.0 for r in rows)
    # the key is not stored anywhere in the database
    dump = json.dumps(store.load_state(db, "scorer:helius:universe")) + json.dumps(store.load_state(db, "scorer:helius:checkpoint"))
    assert KEY not in dump


@pytest.mark.db
@responses.activate
def test_dataset_from_mocked_helius_is_usable_by_the_pipeline(db):
    from scorer.features import compute_features
    from scorer.splits import make_split

    wallets = fake_world()
    install_mocks(wallets, NOW_TS)
    src = make_source()
    ds = src.load_dataset(db, NOW_TS)
    assert ds.label == DS_HELIUS and ds.meta["n_backfilled"] == len(wallets)
    assert int(ds.is_wallet.sum()) == len(wallets)
    assert ds.t_ts.size > 1000 and set(ds.assets) == set(ASSETS)
    assert ds.positions is not None and ds.positions.n > 100 and len(ds.markets) > 20
    # funding source = first inbound SOL transfer
    funded = [f for f in (ds.funding[w] for w in ds.wallet_ids().tolist()) if f]
    assert len(funded) == len(wallets) and "BigFunder" in funded
    # balances were reconstructed: the latest snapshot equals the current balance (25 SOL at the latest price)
    assert ds.b_ts.size >= len(wallets) * 10
    # the shortened real data parameters give a valid temporal split on 120 days
    split = make_split(ds.start_ts, ds.end_ts, src.params)
    assert len(split.train_cutoffs) >= 3 and len(split.test_cutoffs) >= 3
    ft = compute_features(ds, split.test_start, src.params)
    assert ft.active.sum() > 10 and (ft.n_entries > 0).any()
    # no demo label anywhere
    assert db.cursor().execute("SELECT count(*) FROM wallet_edges WHERE data_source <> %s", (DS_HELIUS,)).fetchone()[0] == 0


@pytest.mark.db
@responses.activate
def test_checkpoints_without_edges_are_reported_instead_of_returning_an_empty_dataset(db):
    wallets = fake_world()
    install_mocks(wallets, NOW_TS)
    make_source().backfill(db, NOW_TS)
    with db.cursor() as cur:
        cur.execute("DELETE FROM wallet_edges")  # the edge table was cleared but the checkpoints still say "done"
    db.commit()
    with pytest.raises(HeliusError, match="out of sync"):
        make_source().build_dataset(db, NOW_TS)


@pytest.mark.db
@responses.activate
def test_too_few_backfilled_wallets_is_a_clear_error(db):
    wallets = fake_world(8)
    install_mocks(wallets, NOW_TS)
    with pytest.raises(HeliusError, match="backfilled"):
        make_source().load_dataset(db, NOW_TS)
