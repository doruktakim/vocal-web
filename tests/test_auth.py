import os
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from agents.shared import auth

VALID_KEY = os.environ["VCAA_API_KEY"]


def make_request(ip: str = "127.0.0.1") -> Request:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [],
        "client": (ip, 1234),
    }
    return Request(scope)


def test_verify_api_key_accepts_valid_key():
    request = make_request()
    auth.verify_api_key(request, x_api_key=VALID_KEY)


def test_verify_api_key_rejects_wrong_key():
    request = make_request()
    with pytest.raises(HTTPException):
        auth.verify_api_key(request, x_api_key="wrong_key_value_1234567890")


def test_verify_api_key_requires_header():
    request = make_request()
    with pytest.raises(HTTPException):
        auth.verify_api_key(request, x_api_key=None)


def test_verify_api_key_rejects_malformed_key():
    request = make_request()
    with pytest.raises(HTTPException):
        auth.verify_api_key(request, x_api_key="short")


def test_verify_api_key_uses_constant_time_compare():
    request = make_request()
    with patch("agents.shared.auth.secrets.compare_digest", return_value=True) as mock_compare:
        auth.verify_api_key(request, x_api_key=VALID_KEY)
        mock_compare.assert_called_once_with(VALID_KEY, auth.auth_settings.expected_key)


def test_rate_limiter_blocks_after_repeated_failures():
    request = make_request(ip="10.1.2.3")
    for _ in range(auth.FAILED_LIMIT):
        with pytest.raises(HTTPException):
            auth.verify_api_key(request, x_api_key="invalid_key_value_1234567890")
    with pytest.raises(HTTPException):
        auth.verify_api_key(request, x_api_key=VALID_KEY)
