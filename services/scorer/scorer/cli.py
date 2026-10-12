"""Command line interface: python -m scorer <command>."""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone

from . import pipeline, store
from .config import SOURCE_LABEL, SOURCES, Params, Settings
from .loop import install_signal_handlers, run_loop

log = logging.getLogger("scorer")


def _now(arg: str | None) -> float:
    if not arg:
        return time.time()
    return datetime.fromisoformat(arg.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m scorer", description="Groundgraph smart money scorer")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--source", choices=SOURCES, default=None, help="synthetic (DEMO_MODE only) | helius | onchain; default $SCORER_SOURCE")
        sp.add_argument("--now", default=None, help="override the current time (ISO 8601), for reproducible runs")

    r = sub.add_parser("run", help="full pipeline: data -> features -> scores -> clusters -> layout -> radar")
    add_common(r)
    r.add_argument("--once", action="store_true", help="run once and exit (default: keep running like `loop`)")
    r.add_argument("--train", action="store_true", help="force a retrain before scoring")
    r.add_argument("--no-track", action="store_true", help="skip the nightly track record step")
    ro = sub.add_parser("run-once", help="same as `run --once`: one full pass, then exit")
    add_common(ro)
    ro.add_argument("--train", action="store_true", help="force a retrain before scoring")
    ro.add_argument("--no-track", action="store_true", help="skip the nightly track record step")
    t = sub.add_parser("train", help="train GraphSAGE + head, backtest, write model, track record and MODEL_CARD.md")
    add_common(t)
    rd = sub.add_parser("radar", help="refresh the radar of every open market (the per-minute job)")
    add_common(rd)
    tr = sub.add_parser("track-record", help="nightly backtest with the stored model")
    add_common(tr)
    lp = sub.add_parser("loop", help="docker entrypoint: radar every minute, hourly run, weekly retrain, nightly track record")
    add_common(lp)
    return p


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.cmd == "run-once":
        args.cmd, args.once = "run", True
    settings = Settings.from_env(env)
    logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        source = settings.check_source(args.source)
    except PermissionError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 2
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    params = Params.for_source(source, settings.seed)
    now = _now(args.now)
    conn = store.connect(settings.database_url)
    try:
        if args.cmd == "run":
            if args.once:
                summary = pipeline.run_full(conn, settings, params, source, now, force_train=args.train, with_track=not args.no_track)
                print(json.dumps(summary, indent=2, default=str))
                return 0
            conn.close()
            return _loop(settings, params, source)
        if args.cmd == "train":
            ds = pipeline.get_dataset(conn, settings, params, source, now)
            out = pipeline.train_and_backtest(conn, ds, params, source, now)
            print(json.dumps({"model_version": out.train.bundle.version, "metrics": out.train.bundle.metrics,
                              "track_markets": out.track.n_markets, "brier_radar": out.track.brier_radar,
                              "brier_market": out.track.brier_market}, indent=2, default=str))
            return 0
        if args.cmd == "radar":
            rows = pipeline.radar_refresh(conn, settings, params, now)
            print(json.dumps([{k: (str(v) if k == "ts" else v) for k, v in r.items()} for r in rows], indent=2, default=str))
            return 0
        if args.cmd == "track-record":
            res = pipeline.track_record_only(conn, settings, params, source, now)
            print(json.dumps({"n_markets": res.n_markets, "brier_radar": res.brier_radar, "brier_market": res.brier_market}, indent=2))
            return 0
        if args.cmd == "loop":
            conn.close()
            return _loop(settings, params, source)
    finally:
        if not conn.closed:
            conn.close()
    return 0


def _loop(settings: Settings, params: Params, source: str) -> int:
    flag = {"stop": False}
    install_signal_handlers(flag)
    log.info("scorer loop starting: source=%s label=%s demo=%s", source, SOURCE_LABEL[source], settings.demo_mode)
    run_loop(settings, params, source, should_stop=lambda: flag["stop"])
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
