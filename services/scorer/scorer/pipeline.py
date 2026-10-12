"""Pipeline orchestration: composes the pure steps and writes the results to PostgreSQL."""

from __future__ import annotations

import hashlib
import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import psycopg

from . import store
from .clusters import community_stats, louvain_communities, merge_small, name_communities, stabilize_ids, sybil_assignments
from .config import DAY, HOUR, SOURCE_LABEL, TRACK_LABEL, Params, Settings
from .dataset import Dataset
from .features import compute_bridged
from .head import ROW_LABELS, reasons_for
from .layout import layout_wallets
from .model import HEAD_KEYS, build_snapshot
from .radar import Calibrator, RadarPos, finalize, identity_calibrator, radar_raw
from .timeutil import floor_to, iso
from .track_record import SnapshotCache, TrackRecordResult, run_backtest
from .training import ModelBundle, TrainResult, cold_start_bundle, score_snapshot, train_model
from .types import OpenMarket

log = logging.getLogger("scorer")

RADAR_FORMULA = "radar-v1"
CONTRIB_KEYS = ("whale_overlap", "entry_timing", "hit_rate", "centrality", "lead_time")  # == HEAD_KEYS


def model_card_path() -> Path:
    env = os.environ.get("MODEL_CARD_PATH")
    return Path(env) if env else Path(__file__).resolve().parents[1] / "MODEL_CARD.md"


# --------------------------------------------------------------------------- artifacts
def load_bundle(conn: psycopg.Connection, label: str) -> ModelBundle | None:
    d = store.load_state(conn, f"scorer:model:{label}")
    conn.commit()
    return ModelBundle.from_json(d) if d else None


def save_bundle(conn: psycopg.Connection, bundle: ModelBundle) -> None:
    store.save_state(conn, f"scorer:model:{bundle.source_label}", bundle.to_json())


def load_calibrator(conn: psycopg.Connection, label: str) -> Calibrator:
    d = store.load_state(conn, f"scorer:calibrator:{label}")
    conn.commit()
    return Calibrator.from_json(d)


def load_meta(conn: psycopg.Connection, label: str) -> dict:
    d = store.load_state(conn, f"scorer:meta:{label}") or {}
    conn.commit()
    return d


def update_meta(conn: psycopg.Connection, label: str, **kv) -> None:
    d = store.load_state(conn, f"scorer:meta:{label}") or {}
    d.update(kv)
    store.save_state(conn, f"scorer:meta:{label}", d)


# --------------------------------------------------------------------------- datasets
def get_dataset(conn: psycopg.Connection, settings: Settings, params: Params, source: str, now: float) -> Dataset:
    if source == "synthetic":
        from .sources.synthetic import SyntheticSource

        return SyntheticSource(params=params).build_dataset(now)
    if source == "helius":
        from .sources.helius import HeliusSource

        return HeliusSource.from_settings(settings, params).load_dataset(conn, now)
    raise ValueError(f"source {source!r} has no wallet dataset")


# --------------------------------------------------------------------------- training + backtest
@dataclass
class TrainOutcome:
    train: TrainResult
    track: TrackRecordResult
    run_id: int | None


def train_and_backtest(conn: psycopg.Connection, ds: Dataset, params: Params, source: str, now: float, write: bool = True) -> TrainOutcome:
    from .modelcard import render_model_card

    label = SOURCE_LABEL[source]
    tr = train_model(ds, params, label, now)
    cache = SnapshotCache(ds, tr.bundle, params, preload={c: s for c, s in tr.test_snaps.items()})
    track = run_backtest(ds, tr.bundle, params, tr.split.test_start, cache)
    run_id = None
    if write:
        save_bundle(conn, tr.bundle)
        store.save_state(conn, f"scorer:calibrator:{label}", track.calibrator.to_json())
        update_meta(conn, label, last_train_ts=now, model_version=tr.bundle.version, calibrator=track.calibrator.ident())
        run_id = store.write_track_record(conn, track, TRACK_LABEL[source], tr.bundle.version, now)
        update_meta(conn, label, last_track_ts=now)
        conn.commit()
        card = render_model_card(ds, params, tr, track, source, now)
        try:
            model_card_path().write_text(card, encoding="utf-8")
        except OSError as e:  # read only file system in some deployments
            log.warning("could not write MODEL_CARD.md: %s", e)
        store.save_state(conn, f"scorer:model_card:{label}", {"markdown": card, "generated": iso(now)})
        conn.commit()
    return TrainOutcome(tr, track, run_id)


def track_record_only(conn: psycopg.Connection, settings: Settings, params: Params, source: str, now: float,
                      ds: Dataset | None = None) -> TrackRecordResult:
    """Nightly job: re-run the backtest with the stored model (no retraining) and refit the isotonic calibrator."""
    label = SOURCE_LABEL[source]
    ds = ds if ds is not None else get_dataset(conn, settings, params, source, now)
    bundle = load_bundle(conn, label)
    if bundle is None:
        out = train_and_backtest(conn, ds, params, source, now)
        return out.track
    from .splits import make_split

    split = make_split(ds.start_ts, ds.end_ts, params)
    res = run_backtest(ds, bundle, params, split.test_start)
    store.save_state(conn, f"scorer:calibrator:{label}", res.calibrator.to_json())
    store.write_track_record(conn, res, TRACK_LABEL[source], bundle.version, now)
    update_meta(conn, label, last_track_ts=now, calibrator=res.calibrator.ident())
    conn.commit()
    return res


# --------------------------------------------------------------------------- radar refresh
def radar_model_version(wallet_model_version: str, cal: Calibrator) -> str:
    return f"{RADAR_FORMULA}/{wallet_model_version}/{cal.ident()}"


def compute_radar_rows(
    markets: list[OpenMarket], positions: list[dict], now: float, params: Params, calibrator: Calibrator, wallet_model_version: str,
) -> list[dict]:
    """Pure: radar rows for every open market from joined position/score records (see store.read_radar_positions)."""
    by_market: dict[str, list[dict]] = {}
    for r in positions:
        by_market.setdefault(r["market_id"], []).append(r)
    ts = dt_minute(now)
    out = []
    for m in markets:
        if m.p_market is None:
            continue
        rows = by_market.get(m.id, [])
        scored_rows = [r for r in rows if r["scored"]]
        net: dict[str, list] = {}
        for r in scored_rows:
            if r["smart"] and r["hit_rate"] is not None:
                e = net.setdefault(r["wallet"], [0.0, float(r["hit_rate"]), r["sybil_cluster_id"] is not None])
                e[0] += (1.0 if r["side"] == "above" else -1.0) * float(r["usdc"]) / 1e6
        rp = [RadarPos(abs(v[0]), 1 if v[0] > 0 else -1, v[1], v[2]) for w, v in sorted(net.items()) if abs(v[0]) > 1e-9]
        raw = radar_raw(m.p_market, rp, n_scored_trades=len(scored_rows), params=params)
        res = finalize(raw, calibrator, params)
        ready = res["state"] == "ready"
        has_demo = any(r["data_source"] == "demo-synthetic" for r in rows)
        out.append({
            "market_id": m.id, "ts": store.dt(ts),
            # while building, p_above carries the market price and ci/edge are 0: the API must show the Building state
            "p_above": round(res["p"], 6) if ready else round(res["p_market"], 6),
            "p_above_raw": round(res["p_raw"], 6) if ready else None,
            "ci_pts": int(res["ci_pts"]) if ready else 0,
            "n_flagged": int(res["n"]),
            "edge_cents": int(res["edge_cents"]) if ready else 0,
            "vol_above": round(res["vol_above"] * 1e6), "vol_below": round(res["vol_below"] * 1e6),
            "state": "ready" if ready else "building",
            "model_version": radar_model_version(wallet_model_version, calibrator),
            "data_source": "demo-synthetic" if has_demo else "onchain",
        })
    return out


def dt_minute(now: float) -> float:
    return math.floor(now / 60.0) * 60.0


def radar_refresh(conn: psycopg.Connection, settings: Settings, params: Params, now: float) -> list[dict]:
    """Per-minute job: mirror on-chain positions, then (re)compute the radar of every open market."""
    store.mirror_onchain_positions(conn)
    markets = store.read_open_markets(conn)
    if not markets:
        return []
    demo = settings.demo_mode
    pos_sources = ["demo-synthetic", "onchain"] if demo else ["onchain"]
    wallet_sources = ["demo-synthetic", "helius-mainnet", "onchain"] if demo else ["helius-mainnet", "onchain"]
    positions = store.read_radar_positions(conn, [m.id for m in markets], pos_sources, wallet_sources)
    label = "demo-synthetic" if demo else "helius-mainnet"
    cal = load_calibrator(conn, label)
    meta = load_meta(conn, label)
    rows = compute_radar_rows(markets, positions, now, params, cal, meta.get("model_version", "heuristic-v0"))
    store.write_radar(conn, rows)
    conn.commit()
    return rows


# --------------------------------------------------------------------------- full run
def _synthetic_edge_rows(ds: Dataset, since_ts: float) -> list[tuple]:
    out = []
    m = ds.e_ts >= since_ts
    for s, d, u, t in zip(ds.e_src[m].tolist(), ds.e_dst[m].tolist(), ds.e_usd[m].tolist(), ds.e_ts[m].tolist()):
        sig = hashlib.sha256(f"{ds.nodes[s]}|{ds.nodes[d]}|{t:.0f}|{u:.2f}".encode()).hexdigest()[:44]
        out.append((ds.nodes[s], ds.nodes[d], "SOL", round(u, 2), t, "demo" + sig))
    return out


def run_full(conn: psycopg.Connection, settings: Settings, params: Params, source: str, now: float, force_train: bool = False,
             with_track: bool = True) -> dict:
    """Hourly batch: load data, (train if needed), features -> scores -> clusters -> sybil -> layout -> radar."""
    label = SOURCE_LABEL[source]
    settings.check_source(source)
    if source == "onchain":
        rows = radar_refresh(conn, settings, params, now)
        return {"source": source, "radar_rows": len(rows)}

    ds = get_dataset(conn, settings, params, source, now)
    as_of = ds.end_ts
    summary: dict = {"source": source, "as_of": iso(as_of), "wallets": int(ds.is_wallet.sum())}

    bundle = load_bundle(conn, label)
    if bundle is None or force_train:
        out = train_and_backtest(conn, ds, params, source, now)
        bundle = out.train.bundle
        summary["trained"] = bundle.version
    bundle = bundle or cold_start_bundle(label, now)

    snap = build_snapshot(ds, as_of, params, with_labels=False)
    ft = snap.ft
    sc = score_snapshot(bundle, snap, params)
    n = ft.wallets.size

    # ---- communities, names, stable ids
    comm = louvain_communities(ft, params, params.seed)
    comm = merge_small(comm, ft, max(3, int(0.02 * n)))
    nodes_comm = np.full(ds.n_nodes, -1, dtype=np.int64)
    nodes_comm[ft.wallets] = comm
    ft.bridged = compute_bridged(ft, nodes_comm)
    stats, uni = community_stats(ds, ft, comm, params)
    sizes = {int(c): int((comm == c).sum()) for c in np.unique(comm)}
    names = name_communities(stats, uni, sizes)
    addr = [ds.nodes[int(w)] for w in ft.wallets.tolist()]
    members = {int(c): [addr[i] for i in np.nonzero(comm == c)[0].tolist()] for c in np.unique(comm)}
    prev = store.read_prev_clusters(conn, label)
    id_map = stabilize_ids(members, prev)
    cluster_id = np.array([id_map[int(c)] for c in comm])
    cluster_name = [names[int(c)] for c in comm]

    # ---- sybil clusters (flagged wallets that share a funding source within 2 hops)
    syb = sybil_assignments(ds, ft, sc.smart, params)

    # ---- reasons, contributions
    act = np.nonzero(ft.active)[0]
    score_rows, feat_rows, wallet_rows = [], [], []
    for i in act.tolist():
        pts = {k: int(v) for k, v in zip(CONTRIB_KEYS, sc.points[i].tolist())}
        reasons = reasons_for(sc.points[i], ft, i, float(sc.g[i]), float(sc.gnn_points[i]), params)
        score_rows.append((addr[i], int(sc.score[i]), bool(sc.smart[i]), bool(sc.top[i]), pts, reasons))
        feat_rows.append((addr[i], float(ft.whale_overlap[i]), float(ft.entry_timing[i]), float(ft.hit_rate[i]),
                          float(ft.centrality[i]), float(ft.lead_time_min[i]), int(ft.n_markets[i])))
        w = int(ft.wallets[i])
        fs = ds.first_seen[w]
        wallet_rows.append((addr[i], None if np.isnan(fs) else float(fs), ds.funding[w], int(cluster_id[i]), cluster_name[i],
                            syb.get(i), label))

    # ---- layout (wallets that opted out of labels never appear as nodes)
    hidden = store.read_hidden_wallets(conn)
    smart_arr = sc.smart[act]
    pos3 = layout_wallets([addr[i] for i in act.tolist()], cluster_id[act], smart_arr, ft.graph.A[ft.wallets[act]][:, ft.wallets[act]].tocsr())
    layout_rows = [(addr[i], *pos3[k]) for k, i in enumerate(act.tolist()) if addr[i] not in hidden]

    # ---- single transaction for everything this run owns
    store.upsert_wallets(conn, wallet_rows)
    store.upsert_features(conn, as_of, feat_rows)
    store.upsert_scores(conn, as_of, score_rows, bundle.version, label)
    store.upsert_layout(conn, as_of, layout_rows, label)
    store.delete_layout(conn, [a for a in (addr[i] for i in act.tolist()) if a in hidden])
    if source == "synthetic":
        from .sources.synthetic import SyntheticSource

        store.replace_edges(conn, label, _synthetic_edge_rows(ds, as_of - params.window_days * DAY))
        open_markets = store.read_open_markets(conn)
        rows = SyntheticSource(params=params).current_positions(ds, open_markets, now)
        store.replace_scored_positions(conn, label, [m.id for m in open_markets], rows)
        summary["demo_positions"] = len(rows)
    store.prune_history(conn, now)
    update_meta(conn, label, last_full_run_ts=now, model_version=bundle.version)
    conn.commit()

    radar_rows = radar_refresh(conn, settings, params, now)
    store.prune_radar(conn, now)
    conn.commit()
    summary.update(
        model_version=bundle.version, scored=len(score_rows), flagged=int(sc.smart.sum()), top=int(sc.top.sum()),
        clusters=len(set(cluster_id.tolist())), sybil_wallets=len(syb), sybil_clusters=len(set(syb.values())),
        layout=len(layout_rows), radar_rows=len(radar_rows),
    )

    if with_track:
        meta = load_meta(conn, label)
        if now - float(meta.get("last_track_ts", 0.0)) >= settings.track_record_interval_s - 60:
            res = track_record_only(conn, settings, params, source, now, ds)
            summary["track_record_markets"] = res.n_markets
    return summary
