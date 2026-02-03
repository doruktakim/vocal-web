"""Authentication helpers for API endpoints."""

from __future__ import annotations

import logging
import os
import re
import secrets
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import Header, HTTPException, Request


AUTH_HEADER = "X-API-Key"
API_KEY_ENV_VAR = "VOCAL_API_KEY"
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,}$")
FAILED_LIMIT = 10
FAILED_WINDOW_SECONDS = 60
BLOCK_DURATION_SECONDS = 300
GENERIC_ERROR = HTTPException(status_code=401, detail="Invalid or missing API key")

logger = logging.getLogger("auth")


class AuthSettings:
    """Holds the expected API key loaded from the environment."""

    def __init__(self) -> None:
        self._expected_key: str | None = None
        self.reload()

    @property
    def expected_key(self) -> str:
        if not self._expected_key:
            raise RuntimeError(
                f"{API_KEY_ENV_VAR} must be configured before handling requests."
            )
        return self._expected_key

    def reload(self) -> None:
        raw = os.getenv(API_KEY_ENV_VAR, "").strip()
        if not raw:
            raise RuntimeError(f"{API_KEY_ENV_VAR} environment variable is not set.")
        if not KEY_PATTERN.fullmatch(raw):
            raise RuntimeError(
                f"{API_KEY_ENV_VAR} must be at least 32 characters and contain only "
                "letters, numbers, hyphens, or underscores."
            )
        self._expected_key = raw
        logger.info("API authentication initialized.")


auth_settings = AuthSettings()
FAILED_ATTEMPTS: Dict[str, Deque[float]] = defaultdict(deque)
BLOCKED_IPS: Dict[str, float] = {}


def _prune_attempts(ip: str, now: float) -> None:
    attempts = FAILED_ATTEMPTS.get(ip)
    if not attempts:
        return
    window_start = now - FAILED_WINDOW_SECONDS
    while attempts and attempts[0] < window_start:
        attempts.popleft()
    if not attempts:
        FAILED_ATTEMPTS.pop(ip, None)


def _register_failure(ip: str, now: float) -> None:
    if not ip:
        ip = "unknown"
    _prune_attempts(ip, now)
    attempts = FAILED_ATTEMPTS.setdefault(ip, deque())
    attempts.append(now)
    if len(attempts) >= FAILED_LIMIT:
        BLOCKED_IPS[ip] = now + BLOCK_DURATION_SECONDS
        FAILED_ATTEMPTS.pop(ip, None)
        logger.warning("Blocked IP %s after repeated authentication failures.", ip)


def _clear_failures(ip: str) -> None:
    FAILED_ATTEMPTS.pop(ip, None)
    BLOCKED_IPS.pop(ip, None)


def _is_blocked(ip: str, now: float) -> bool:
    if not ip:
        ip = "unknown"
    expires = BLOCKED_IPS.get(ip)
    if not expires:
        return False
    if expires < now:
        BLOCKED_IPS.pop(ip, None)
        return False
    return True


def verify_api_key(request: Request, x_api_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency that validates the provided API key."""
    now = time.time()
    client_ip = request.client.host if request.client else "unknown"

    if _is_blocked(client_ip, now):
        logger.warning("Rejected blocked IP %s.", client_ip)
        raise GENERIC_ERROR

    provided = (x_api_key or "").strip()
    if not provided:
        logger.warning("Missing API key from %s.", client_ip)
        _register_failure(client_ip, now)
        raise GENERIC_ERROR
    if not KEY_PATTERN.fullmatch(provided):
        logger.warning("Malformed API key from %s.", client_ip)
        _register_failure(client_ip, now)
        raise GENERIC_ERROR

    expected = auth_settings.expected_key
    if not secrets.compare_digest(provided, expected):
        logger.warning("Invalid API key attempt from %s.", client_ip)
        _register_failure(client_ip, now)
        raise GENERIC_ERROR

    _clear_failures(client_ip)


def reset_auth_state() -> None:
    """Utility hook for tests to reset in-memory rate limiting counters."""
    FAILED_ATTEMPTS.clear()
    BLOCKED_IPS.clear()

