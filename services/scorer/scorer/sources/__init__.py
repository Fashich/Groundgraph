"""Data sources. Each source produces a Dataset (see scorer.dataset) for the pipeline."""

from __future__ import annotations

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(raw: bytes) -> str:
    """Base58 (Bitcoin alphabet) encoding, as used by Solana addresses."""
    n = int.from_bytes(raw, "big")
    out = []
    while n > 0:
        n, r = divmod(n, 58)
        out.append(B58[r])
    pad = len(raw) - len(raw.lstrip(b"\x00"))
    return B58[0] * pad + "".join(reversed(out))


def b58decode(text: str) -> bytes:
    n = 0
    for ch in text:
        n = n * 58 + B58.index(ch)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(text) - len(text.lstrip(B58[0]))
    return b"\x00" * pad + body
