"""Digital option fair value for a Close market (zero drift), matching the SDK fair value model.

P(above) = N(d2), d2 = (ln(S/K) - 0.5 sigma^2 T) / (sigma sqrt(T)).
"""

from __future__ import annotations

import numpy as np
from scipy.special import ndtr


def digital_close_prob(spot, strike, t_years, sigma, floor: float = 0.02):
    """Vectorised P(ABOVE) for a Close market, clamped to [floor, 1 - floor].

    Degenerate inputs (T <= 0 or sigma <= 0) collapse to the indicator of spot > strike.
    """
    s = np.asarray(spot, dtype=np.float64)
    k = np.asarray(strike, dtype=np.float64)
    t = np.asarray(t_years, dtype=np.float64)
    v = np.asarray(sigma, dtype=np.float64)
    s, k, t, v = np.broadcast_arrays(s, k, t, v)
    out = np.where(s > k, 1.0, 0.0)
    ok = (t > 1e-12) & (v > 1e-12) & (s > 0) & (k > 0)
    if np.any(ok):
        so, ko, to, vo = s[ok], k[ok], t[ok], v[ok]
        st = vo * np.sqrt(to)
        d2 = (np.log(so / ko) - 0.5 * vo * vo * to) / st
        out = out.astype(np.float64)
        out[ok] = ndtr(d2)
    return np.clip(out, floor, 1.0 - floor)
