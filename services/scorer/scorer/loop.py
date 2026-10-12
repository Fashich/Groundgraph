"""Long running scheduler (docker entrypoint): radar every minute, full run hourly, retrain weekly, track record nightly."""

from __future__ import annotations

import logging
import signal
import time
from typing import Callable

import psycopg

from . import pipeline, store
from .config import SOURCE_LABEL, Params, Settings

log = logging.getLogger("scorer.loop")


def run_loop(
    settings: Settings,
    params: Params,
    source: str,
    *,
    connect: Callable[[str], psycopg.Connection] = store.connect,
    now_fn: Callable[[], float] = time.time,
    sleep_fn: Callable[[float], None] = time.sleep,
    should_stop: Callable[[], bool] = lambda: False,
    max_ticks: int | None = None,
) -> list[str]:
    """Run the schedule until should_stop() or max_ticks. Returns the list of jobs executed (used by tests).

    Persisted timestamps (indexer_state, key scorer:meta:<label>) make restarts cheap: a container restart does not
    retrain or re-run the hourly batch unless it is actually due.
    """
    label = SOURCE_LABEL[source]
    executed: list[str] = []
    conn: psycopg.Connection | None = None
    next_radar = 0.0
    ticks = 0
    while not should_stop() and (max_ticks is None or ticks < max_ticks):
        ticks += 1
        now = now_fn()
        try:
            if conn is None or conn.closed:
                conn = connect(settings.database_url)
            meta = pipeline.load_meta(conn, label)
            have_model = pipeline.load_bundle(conn, label) is not None
            train_due = (not have_model) or now - float(meta.get("last_train_ts", 0.0)) >= settings.retrain_interval_s
            full_due = now - float(meta.get("last_full_run_ts", 0.0)) >= settings.full_run_interval_s
            track_due = now - float(meta.get("last_track_ts", 0.0)) >= settings.track_record_interval_s
            if source != "onchain" and (train_due or full_due):
                with store.advisory_lock(conn, f"full:{label}") as got:
                    if got:
                        summary = pipeline.run_full(conn, settings, params, source, now, force_train=train_due, with_track=track_due)
                        executed.append("train+full" if train_due else "full")
                        log.info("full run: %s", summary)
            elif source != "onchain" and track_due:
                with store.advisory_lock(conn, f"track:{label}") as got:
                    if got:
                        res = pipeline.track_record_only(conn, settings, params, source, now)
                        executed.append("track")
                        log.info("track record: %d markets", res.n_markets)
            if now >= next_radar:
                with store.advisory_lock(conn, f"radar:{label}") as got:
                    if got:
                        rows = pipeline.radar_refresh(conn, settings, params, now)
                        executed.append("radar")
                        log.debug("radar: %d markets", len(rows))
                next_radar = now + settings.radar_interval_s
        except Exception:  # keep the service alive, the next tick retries
            log.exception("scorer tick failed")
            executed.append("error")
            try:
                if conn is not None:
                    conn.rollback()
            except Exception:
                conn = None
        if should_stop() or (max_ticks is not None and ticks >= max_ticks):
            break
        wait = next_radar - now_fn()
        sleep_fn(min(settings.radar_interval_s, max(1.0, wait)))
    if conn is not None and not conn.closed:
        conn.close()
    return executed


def install_signal_handlers(flag: dict) -> None:
    def handler(signum, frame):  # noqa: ARG001
        flag["stop"] = True

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)
