"""HTTP plumbing shared by the real data sources: a token bucket rate limiter and a JSON client with retries.

Everything that touches time or the network is injectable (clock, sleep, session) so the behaviour is unit tested
with mocked HTTP only. Secrets (API keys) are redacted from every error message and log line.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

import requests

log = logging.getLogger("scorer.http")

RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})


class HttpError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class RateLimiter:
    """Token bucket: `rate` requests per second with a burst of `burst`. acquire() blocks (via sleep) until a token exists."""

    def __init__(self, rate: float, burst: int = 1, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep):
        if rate <= 0:
            raise ValueError("rate must be positive")
        self.rate, self.burst = float(rate), float(max(1, burst))
        self._clock, self._sleep = clock, sleep
        self._tokens = self.burst
        self._last = clock()

    def acquire(self) -> float:
        """Take one token; returns the number of seconds waited."""
        waited = 0.0
        while True:
            now = self._clock()
            self._tokens = min(self.burst, self._tokens + (now - self._last) * self.rate)
            self._last = now
            if self._tokens >= 1.0 - 1e-12:
                self._tokens -= 1.0
                return waited
            need = (1.0 - self._tokens) / self.rate
            self._sleep(need)
            waited += need


def redact(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if s:
            text = text.replace(s, "***")
    return text


class JsonClient:
    """GET/POST JSON with a rate limiter, bounded retries on 429/5xx/network errors and Retry-After support."""

    def __init__(
        self,
        session: requests.Session | None = None,
        limiter: RateLimiter | None = None,
        max_retries: int = 5,
        backoff_base: float = 1.0,
        backoff_cap: float = 60.0,
        timeout: float = 30.0,
        sleep: Callable[[float], None] = time.sleep,
        secrets: list[str] | None = None,
        budget: int | None = None,
    ):
        self.session = session or requests.Session()
        self.limiter = limiter
        self.max_retries, self.backoff_base, self.backoff_cap, self.timeout = max_retries, backoff_base, backoff_cap, timeout
        self._sleep = sleep
        self.secrets = list(secrets or [])
        self.requests_made = 0
        self.budget = budget  # maximum number of HTTP requests this client may make (None: unlimited)

    def exhausted(self) -> bool:
        return self.budget is not None and self.requests_made >= self.budget

    def _delay(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(float(retry_after), self.backoff_cap)
            except ValueError:
                pass
        return min(self.backoff_base * (2 ** attempt), self.backoff_cap)

    def request(self, method: str, url: str, *, params: dict | None = None, json_body: Any = None, headers: dict | None = None) -> Any:
        last: str = ""
        for attempt in range(self.max_retries + 1):
            if self.exhausted():
                raise HttpError("request budget exhausted", None)
            if self.limiter is not None:
                self.limiter.acquire()
            self.requests_made += 1
            try:
                resp = self.session.request(method, url, params=params, json=json_body, headers=headers, timeout=self.timeout)
            except (requests.ConnectionError, requests.Timeout) as e:
                last = redact(f"network error: {type(e).__name__}", self.secrets)
                if attempt >= self.max_retries:
                    break
                self._sleep(self._delay(attempt, None))
                continue
            if resp.status_code in RETRY_STATUS:
                last = f"HTTP {resp.status_code}"
                if attempt >= self.max_retries:
                    raise HttpError(f"{last} after {attempt + 1} attempts", resp.status_code)
                self._sleep(self._delay(attempt, resp.headers.get("Retry-After")))
                continue
            if resp.status_code >= 400:
                raise HttpError(redact(f"HTTP {resp.status_code}: {resp.text[:200]}", self.secrets), resp.status_code)
            try:
                return resp.json()
            except ValueError as e:
                raise HttpError(f"invalid JSON in response: {e}", resp.status_code) from e
        raise HttpError(f"{last} after {self.max_retries + 1} attempts")

    def get_json(self, url: str, params: dict | None = None, headers: dict | None = None) -> Any:
        return self.request("GET", url, params=params, headers=headers)

    def post_json(self, url: str, body: Any, params: dict | None = None, headers: dict | None = None) -> Any:
        return self.request("POST", url, params=params, json_body=body, headers=headers)
