"""Small UTC time helpers. Internally the pipeline works in float epoch seconds."""

from __future__ import annotations

import math
from datetime import datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def to_ts(dt: datetime) -> float:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def to_dt(ts: float) -> datetime:
    return datetime.fromtimestamp(float(ts), tz=timezone.utc)


def floor_to(ts: float, seconds: float) -> float:
    return math.floor(ts / seconds) * seconds


def iso(ts: float) -> str:
    return to_dt(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
