import os
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if PROJECT_ROOT not in map(Path, sys.path):
    sys.path.insert(0, str(PROJECT_ROOT))

TEST_API_KEY = "test_key_abcdefghijklmnopqrstuvwxyz1234"
os.environ["VOCAL_API_KEY"] = TEST_API_KEY
os.environ["VOCAL_ALLOWED_ORIGINS"] = ""

from agents.shared import auth

auth.auth_settings.reload()


@pytest.fixture(autouse=True)
def reset_auth_state():
    auth.reset_auth_state()
    yield
    auth.reset_auth_state()
