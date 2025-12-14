# TLS Setup Guide

Vocal Web supports HTTPS natively. Configure the following environment variables before starting `python -m agents.api_server`:

- `SSL_KEYFILE` – path to the PEM-encoded private key.
- `SSL_CERTFILE` – path to the PEM-encoded certificate (full chain).
- `VCAA_ENV=production` – optional but recommended for real deployments; it enforces HTTPS and safe host bindings.

When both PEM paths are valid the API server automatically enables TLS. The extension detects HTTPS support and switches to `https://` without any additional changes.

## Local development with mkcert

[`mkcert`](https://github.com/FiloSottile/mkcert) generates locally trusted certificates so Chrome accepts HTTPS without warnings.

1. Install mkcert and trust its local CA:
   ```bash
   brew install mkcert nss  # macOS, replace with your package manager on Linux/Windows
   mkcert -install
   ```
2. Issue certificates for localhost loopbacks:
   ```bash
   mkcert localhost 127.0.0.1 ::1
   # Creates localhost.pem (cert) and localhost-key.pem (private key)
   ```
3. Export the paths before launching the server:
   ```bash
   export SSL_CERTFILE="$PWD/localhost.pem"
   export SSL_KEYFILE="$PWD/localhost-key.pem"
   python3 -m agents.api_server
   ```
4. The extension’s popup will show a padlock once `/health` succeeds over HTTPS.

## Self-signed fallback with OpenSSL

For test environments where mkcert is unavailable:

```bash
openssl req -x509 -nodes -days 7 \
  -subj "/CN=localhost" \
  -newkey rsa:4096 \
  -keyout vcaa-dev.key \
  -out vcaa-dev.crt
export SSL_KEYFILE="$PWD/vcaa-dev.key"
export SSL_CERTFILE="$PWD/vcaa-dev.crt"
python -m agents.api_server
```

Browsers will warn about the untrusted certificate unless you manually trust it. Prefer mkcert for daily development.

## Production certificates (Let’s Encrypt / reverse proxy)

For internet-facing deployments place a reverse proxy such as nginx or Caddy in front of the Uvicorn process:

```
Client → [nginx or Caddy:443] → [uvicorn:8081]
```

Benefits:
- Automated Let’s Encrypt renewals.
- HTTP/2, compression and rate limiting support.
- Easier to terminate TLS once while reusing the same cert for multiple services.

Example Caddyfile:

```
vcaa.example.com {
    reverse_proxy localhost:8081
    encode gzip
}
```

Point the DNS `A/AAAA` record at the box, run `caddy run`, and Caddy will fetch/renew the certificate automatically.

## Troubleshooting

- **“TLS certificate expired” on startup** – renew the certificate; the server refuses to run with expired PEMs to avoid silent MITM exposure.
- **“HTTPS required” errors in the extension** – enable TLS or uncheck “Require HTTPS connection” in the popup for local testing.
- **`ERR_CERT_AUTHORITY_INVALID` in Chrome** – your certificate isn’t trusted. Install mkcert’s root CA or use a publicly trusted cert.
- **Health probe keeps failing** – ensure the certificate includes the host you configured in `VCAA_API_HOST` (`localhost`, `127.0.0.1`, etc.) and that the port is accessible.
