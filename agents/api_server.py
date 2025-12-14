"""HTTP bridge for VCAA agents."""

from __future__ import annotations

import ipaddress
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import ssl
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn

from agents.interpreter_agent import build_action_plan_from_transcript
from agents.navigator_agent import build_execution_plan
from agents.shared.asi_client import ASIClient
from agents.shared.auth import verify_api_key
from agents.shared.google_stt import TranscriptionError, transcribe_audio_base64
from agents.shared.schemas import (
    ExecutionFeedback,
    NavigationRequest,
    TranscriptMessage,
)


logger = logging.getLogger("api")
logging.basicConfig(level=logging.INFO)


@dataclass
class ServerSecurityConfig:
    host: str
    port: int
    env_mode: str
    allow_remote: bool
    tls_enabled: bool
    ssl_keyfile: Optional[str]
    ssl_certfile: Optional[str]
    cert_expiration: Optional[datetime]
    is_localhost: bool
    listens_globally: bool


def load_allowed_origins() -> List[str]:
    raw = os.getenv("VCAA_ALLOWED_ORIGINS", "")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if origins:
        logger.info("Allowing explicit origins: %s", origins)
    else:
        logger.info("No explicit VCAA_ALLOWED_ORIGINS configured.")
    return origins


ALLOWED_ORIGINS = load_allowed_origins()
CHROME_EXTENSION_REGEX = r"^chrome-extension://.*$"


def is_origin_allowed(origin: str | None) -> bool:
    if not origin:
        return True
    normalized = origin.strip()
    if not normalized:
        return True
    if normalized.startswith("chrome-extension://"):
        return True
    return normalized in ALLOWED_ORIGINS


class OriginValidatorMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        origin = request.headers.get("origin")
        if origin and not is_origin_allowed(origin):
            logger.warning("Blocked request from disallowed origin: %s", origin)
            return JSONResponse(status_code=403, content={"detail": "Origin not allowed"})
        return await call_next(request)


app = FastAPI(title="VCAA Agents API", version="0.1.0")
app.add_middleware(OriginValidatorMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=CHROME_EXTENSION_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-API-Key"],
)


asi_client = ASIClient()


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {"status": "ok"}


@app.post("/api/stt/transcribe", dependencies=[Depends(verify_api_key)])
async def transcribe_audio(payload: Dict[str, Any]):
    """Decode base64 audio and run Google Cloud Speech-to-Text."""
    audio_base64 = payload.get("audio_base64")
    if not audio_base64:
        raise HTTPException(status_code=400, detail="audio_base64 is required")
    language_code = payload.get("language_code", "en-US")
    sample_rate = int(payload.get("sample_rate_hertz", 16000))
    encoding = payload.get("encoding")
    try:
        transcript = transcribe_audio_base64(
            audio_base64,
            sample_rate_hertz=sample_rate,
            language_code=language_code,
            encoding=encoding,
        )
    except TranscriptionError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {
        "schema_version": "stt_v1",
        "id": payload.get("id", "transcribe-result"),
        "trace_id": payload.get("trace_id"),
        "transcript": transcript,
        "language_code": language_code,
    }


@app.post("/api/interpreter/actionplan", dependencies=[Depends(verify_api_key)])
async def interpreter_endpoint(body: TranscriptMessage):
    plan = await build_action_plan_from_transcript(body, asi_client)
    return jsonable_encoder(plan)


@app.post("/api/navigator/executionplan", dependencies=[Depends(verify_api_key)])
async def navigator_endpoint(body: NavigationRequest):
    result = await build_execution_plan(body)
    return jsonable_encoder(result)


@app.post("/api/execution/result", dependencies=[Depends(verify_api_key)])
async def execution_feedback(feedback: ExecutionFeedback):
    logger.info("Execution feedback: %s", feedback.json())
    return {"status": "received", "trace_id": feedback.trace_id}


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _normalize_host(host: str | None) -> str:
    if not host:
        return "127.0.0.1"
    normalized = host.strip()
    return normalized or "127.0.0.1"


def _host_is_local(host: str) -> bool:
    normalized = host.strip().lower().strip("[]")
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    try:
        ip_value = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    return ip_value.is_loopback


def _host_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host.strip().lower().strip("[]"))
    except ValueError:
        return None


def _validate_pem_file(path_value: str, label: str) -> str:
    candidate = Path(path_value).expanduser()
    if not candidate.exists() or not candidate.is_file():
        raise RuntimeError(f"{label} file '{candidate}' does not exist or is not a file.")
    try:
        with candidate.open("r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                if not stripped.startswith("-----BEGIN"):
                    raise RuntimeError(
                        f"{label} file '{candidate}' does not appear to be PEM-encoded."
                    )
                break
    except UnicodeDecodeError as exc:
        raise RuntimeError(f"{label} file '{candidate}' is not UTF-8 encoded.") from exc
    return str(candidate)


def _check_certificate_expiration(cert_path: str) -> Optional[datetime]:
    try:
        details = ssl._ssl._test_decode_cert(cert_path)
    except Exception as exc:  # pragma: no cover - defensive logging only
        logger.warning("Unable to decode TLS certificate %s: %s", cert_path, exc)
        return None
    not_after = details.get("notAfter")
    if not not_after:
        return None
    try:
        expires = datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    except ValueError:
        logger.warning("Unable to parse TLS certificate expiry for %s: %s", cert_path, not_after)
        return None
    remaining = expires - datetime.now(timezone.utc)
    if remaining <= timedelta(0):
        raise RuntimeError(f"TLS certificate {cert_path} expired on {expires.isoformat()}.")
    if remaining <= timedelta(days=30):
        days = max(1, remaining.days)
        logger.warning(
            "TLS certificate %s expires in %d day(s) on %s.",
            cert_path,
            days,
            expires.date().isoformat(),
        )
    return expires


def _load_tls_configuration() -> tuple[Optional[str], Optional[str], Optional[datetime]]:
    keyfile_raw = os.getenv("SSL_KEYFILE", "").strip()
    certfile_raw = os.getenv("SSL_CERTFILE", "").strip()
    if not keyfile_raw and not certfile_raw:
        return None, None, None
    if bool(keyfile_raw) ^ bool(certfile_raw):
        raise RuntimeError("SSL_KEYFILE and SSL_CERTFILE must both be provided to enable TLS.")
    keyfile = _validate_pem_file(keyfile_raw, "TLS key")
    certfile = _validate_pem_file(certfile_raw, "TLS certificate")
    expiration = _check_certificate_expiration(certfile)
    return keyfile, certfile, expiration


def _build_server_config() -> ServerSecurityConfig:
    host = _normalize_host(os.getenv("VCAA_API_HOST", "127.0.0.1"))
    port = int(os.getenv("VCAA_API_PORT", "8081"))
    env_mode = os.getenv("VCAA_ENV", "development").strip().lower() or "development"
    allow_remote = _env_flag("VCAA_ALLOW_REMOTE", False)
    ssl_keyfile, ssl_certfile, cert_expiration = _load_tls_configuration()
    is_localhost = _host_is_local(host)
    host_ip = _host_ip(host)
    listens_globally = bool(host_ip and host_ip.is_unspecified)

    if not is_localhost and not allow_remote:
        raise RuntimeError(
            "Refusing to bind the API server to a non-localhost address. "
            "Set VCAA_ALLOW_REMOTE=true to acknowledge the risk."
        )

    if listens_globally:
        logger.warning(
            "Host '%s' exposes the API on every network interface. Restrict access with a firewall.",
            host,
        )
    elif not is_localhost:
        logger.warning(
            "Binding to '%s'. Only enable this when you fully trust the surrounding network.",
            host,
        )

    tls_enabled = bool(ssl_keyfile and ssl_certfile)
    if env_mode == "production" and not tls_enabled:
        raise RuntimeError(
            "TLS is required when VCAA_ENV=production. Provide SSL_KEYFILE and SSL_CERTFILE."
        )

    if not tls_enabled:
        logger.warning(
            "TLS is disabled; the API will use HTTP and transmit data in plaintext. "
            "Configure SSL_KEYFILE/SSL_CERTFILE to enable HTTPS."
        )

    return ServerSecurityConfig(
        host=host,
        port=port,
        env_mode=env_mode,
        allow_remote=allow_remote,
        tls_enabled=tls_enabled,
        ssl_keyfile=ssl_keyfile,
        ssl_certfile=ssl_certfile,
        cert_expiration=cert_expiration,
        is_localhost=is_localhost,
        listens_globally=listens_globally,
    )


def _log_security_summary(config: ServerSecurityConfig) -> None:
    cert_info = "Not configured"
    if config.tls_enabled:
        if config.cert_expiration:
            cert_info = f"expires {config.cert_expiration.date().isoformat()}"
        else:
            cert_info = "expiration unknown"
    host_scope = "localhost only" if config.is_localhost else "remote exposure"
    remote_flag = "enabled" if config.allow_remote else "disabled"
    lines = [
        "============================================================",
        "Vocal Web API Security Status",
        "------------------------------------------------------------",
        f"Bind Address : {config.host} ({host_scope})",
        f"Port         : {config.port}",
        f"TLS Enabled  : {'Yes' if config.tls_enabled else 'No'}",
        f"Certificate  : {cert_info}",
        f"Environment  : {config.env_mode}",
        f"Remote Bind  : {remote_flag}",
        "API Auth     : Required (X-API-Key)",
        "============================================================",
    ]
    logger.info("\n%s", "\n".join(lines))


def run():
    config = _build_server_config()
    _log_security_summary(config)
    run_kwargs = {
        "host": config.host,
        "port": config.port,
        "reload": False,
    }
    if config.tls_enabled and config.ssl_keyfile and config.ssl_certfile:
        run_kwargs["ssl_keyfile"] = config.ssl_keyfile
        run_kwargs["ssl_certfile"] = config.ssl_certfile
    uvicorn.run("agents.api_server:app", **run_kwargs)


if __name__ == "__main__":
    run()
