"""Generate tests/radar_vectors.json: golden vectors for the radar formula, shared with the TypeScript SDK.

Run `PYTHONPATH=. python tests/gen_radar_vectors.py` after changing scorer.radar. The vectors pin the Python reference; the SDK
function `radarProbability` (packages/sdk/src/radar.ts) must reproduce them (see tests/radar_ts_check.mts and
tests/test_radar.py::test_vectors_match_sdk_typescript, which runs the real TypeScript through tsx when it is installed).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from scorer.config import Params
from scorer.radar import RadarPos, radar_raw

OUT = Path(__file__).with_name("radar_vectors.json")


def case(name: str, p_market: float, flagged: list[tuple[float, str, float, bool]]) -> dict:
    pos = [RadarPos(usd, 1 if side == "above" else -1, hit, sybil) for usd, side, hit, sybil in flagged]
    r = radar_raw(p_market, pos, None, Params())
    exp = {"state": r["state"], "n": r["n"], "p": r["p_raw"], "ci": r["ci_pts"], "edge": r["edge_cents"]}
    return {
        "name": name,
        "pMarket": p_market,
        "flagged": [{"positionUsd": u, "side": s, "hitRate": h, "sybil": y} for u, s, h, y in flagged],
        "expected": exp,
    }


def build() -> list[dict]:
    out: list[dict] = []
    rep = lambda k, side, hit, usd=10_000.0, sy=False: [(usd, side, hit, sy)] * k  # noqa: E731

    # building state
    out.append(case("empty", 0.5, []))
    out.append(case("one wallet", 0.4, rep(1, "above", 0.9)))
    out.append(case("two wallets", 0.4, rep(2, "above", 0.8)))
    out.append(case("three zero usd wallets", 0.4, rep(3, "above", 0.8, usd=0.0)))
    # hand computed known values
    out.append(case("four sharp above, p 0.5", 0.5, rep(4, "above", 0.7)))
    out.append(case("five sharp below, p 0.5", 0.5, rep(5, "below", 0.8)))
    out.append(case("hit rate one half gives no signal", 0.37, rep(6, "above", 0.5)))
    out.append(case("three wallets", 0.3, rep(3, "above", 0.6)))
    out.append(case("balanced sides", 0.55, rep(3, "above", 0.7) + rep(3, "below", 0.7)))
    out.append(case("sybil half weight", 0.5, rep(3, "above", 0.8, 10_000.0, True) + rep(3, "below", 0.8)))
    out.append(case("all sybil", 0.5, rep(4, "above", 0.8, 10_000.0, True)))
    out.append(case("sybil majority by count", 0.45, rep(5, "above", 0.9, 4_000.0, True) + rep(2, "below", 0.9, 4_000.0)))
    out.append(case("whale dominates", 0.5, [(1_000_000.0, "below", 0.9, False)] + rep(4, "above", 0.9, 100.0)))
    out.append(case("huge sizes", 0.5, rep(5, "above", 0.75, 1e12)))
    out.append(case("tiny sizes", 0.5, rep(5, "above", 0.75, 0.01)))
    out.append(case("hit rate zero", 0.5, rep(4, "above", 0.0)))
    out.append(case("hit rate one", 0.5, rep(4, "above", 1.0)))
    out.append(case("hit rate below one half (anti skill)", 0.5, rep(4, "above", 0.2)))
    out.append(case("hit rate out of range is clamped", 0.5, [(5000.0, "above", 1.3, False), (5000.0, "above", -0.2, False), (5000.0, "below", 0.6, False)]))
    out.append(case("negative usd is floored at zero", 0.5, [(-500.0, "above", 0.9, False)] + rep(3, "below", 0.7)))
    # market price clamp (logit only) and edge against the unclamped market price
    for pm in (0.0, 1.0, 1e-9, 1 - 1e-9, 1e-6, 1 - 1e-6, 1e-4, 0.9999):
        out.append(case(f"p_market {pm!r}", pm, rep(5, "above", 0.8)))
    out.append(case("p_market extreme with below", 0.0, rep(5, "below", 0.8)))
    # size of n: gain n/(n+6)
    for n in (3, 4, 6, 10, 20, 50, 200):
        out.append(case(f"n={n} all above", 0.5, rep(n, "above", 0.8)))
    # market price grid
    for pm in (0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98):
        out.append(case(f"p_market {pm} lean above", pm, rep(7, "above", 0.75, 2500.0)))
        out.append(case(f"p_market {pm} lean below", pm, rep(7, "below", 0.75, 2500.0)))
    # seeded random cases
    rng = np.random.default_rng(20261012)
    for k in range(24):
        n = int(rng.integers(3, 41))
        pm = float(np.round(rng.uniform(0.02, 0.98), 4))
        fl = []
        for _ in range(n):
            fl.append((float(np.round(np.exp(rng.normal(8.0, 1.5)), 2)), "above" if rng.random() < 0.55 else "below",
                       float(np.round(rng.uniform(0.2, 0.95), 3)), bool(rng.random() < 0.2)))
        out.append(case(f"random {k}", pm, fl))
    return out


def main() -> None:
    cases = build()
    doc = {
        "formula": "w=sqrt(usd)*(0.4+hit)*(sybil?0.5:1); sy=sum w[above]/sum w; hr=sum w*hit/sum w; sig=(2sy-1)(2hr-1); "
                   "logit p = logit(clamp(pm,1e-6)) + 1.4*(n/(n+6))*sig; ci=max(2,round(164*sqrt(p(1-p)/(4n+10)))); edge=round(100*(p-pm))",
        "note": "round() is round half up like JavaScript Math.round. Building when fewer than 3 wallets or total weight is zero.",
        "cases": cases,
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
