# Network Security Implementation Plan

## Overview

This document outlines the plan to fix two critical network security vulnerabilities in Vocal Web:

1. **No HTTPS/TLS enforcement** - All traffic transmitted in plaintext
2. **Server binds to 0.0.0.0** - API accessible from any network interface

---

## Part 1: No HTTPS/TLS Enforcement

### Why This Is Critical

#### Current Vulnerability

The API server communicates over unencrypted HTTP:

```python
# api_server.py line 133
uvicorn.run("agents.api_server:app", host="0.0.0.0", port=port, reload=False)
# No SSL configuration
```

```javascript
// background.js line 1
const DEFAULT_API_BASE = "http://localhost:8081";  // HTTP, not HTTPS
```

#### What Gets Transmitted in Plaintext

| Data Type | Sensitivity | Example |
|-----------|-------------|---------|
| Voice transcripts | High | User's spoken commands, potentially containing personal info |
| API keys | Critical | `X-API-Key` header sent with every request |
| DOMMap content | High | Page content including form values, hidden fields |
| Execution plans | Medium | Actions to perform on user's browser |
| Page URLs | Medium | User's browsing history exposed |

#### Attack Scenarios

**1. Network Sniffing (Same Network)**

An attacker on the same WiFi network (coffee shop, office, hotel) can:

```bash
# Attacker captures traffic with tcpdump/Wireshark
tcpdump -i en0 port 8081 -A
```

Result: Full visibility into voice commands, API keys, page content.

**2. Man-in-the-Middle (MITM) Attack**

An attacker intercepts and modifies traffic:

```
User Extension  →  [Attacker]  →  API Server
                      ↓
              Injects malicious
              ExecutionPlan steps
```

The attacker could:
- Redirect navigation to phishing sites
- Inject form data into banking pages
- Capture credentials before they're typed

**3. API Key Theft**

Every request includes the API key in a header:

```http
POST /api/interpreter/actionplan HTTP/1.1
X-API-Key: a1b2c3d4e5f6...  ← Visible in plaintext
```

Once stolen, the attacker can impersonate the user.

**4. Corporate/ISP Surveillance**

Network administrators or ISPs can log all voice commands and browsing activity.

#### Risk Rating

| Factor | Assessment |
|--------|------------|
| **CVSS Score** | 7.5 (High) |
| **Attack Complexity** | Low - passive sniffing requires no interaction |
| **Confidentiality Impact** | High - complete data exposure |
| **Integrity Impact** | High - MITM can modify requests/responses |

---

### Solution Options Analysis

#### Option A: Direct TLS in Uvicorn

**How it works:** Configure uvicorn to use SSL certificates directly.

```python
uvicorn.run(
    "agents.api_server:app",
    host="127.0.0.1",
    port=8081,
    ssl_keyfile="/path/to/key.pem",
    ssl_certfile="/path/to/cert.pem",
)
```

| Pros | Cons |
|------|------|
| Simple, single-process setup | Certificate management burden on user |
| No additional dependencies | Self-signed certs cause browser warnings |
| Works for local development | No automatic renewal |
| Low latency (no proxy) | Must restart server to update certs |

**Best for:** Local development, single-user deployments

---

#### Option B: Reverse Proxy (nginx/Caddy)

**How it works:** Place a reverse proxy in front of the API that handles TLS termination.

```
Client → [nginx:443 (TLS)] → [uvicorn:8081 (HTTP)]
```

| Pros | Cons |
|------|------|
| Industry standard approach | Additional process to manage |
| Automatic cert renewal (Caddy) | More complex setup |
| Better performance at scale | Overkill for local-only use |
| Can add caching, compression | Requires domain name for Let's Encrypt |

**Best for:** Production deployments, multi-user systems

---

#### Option C: mkcert for Local Development

**How it works:** Use mkcert to create locally-trusted certificates for development.

```bash
mkcert -install
mkcert localhost 127.0.0.1 ::1
# Creates localhost.pem and localhost-key.pem
```

| Pros | Cons |
|------|------|
| Browsers trust the certs (no warnings) | Requires mkcert installation |
| Perfect for local development | Not for production |
| Simple one-time setup | Certs don't work on other machines |
| Works with localhost | |

**Best for:** Local development with full browser trust

---

#### Option D: Optional TLS with Fallback

**How it works:** Support both HTTP and HTTPS, enable TLS when certificates are provided.

```python
ssl_keyfile = os.getenv("SSL_KEYFILE")
ssl_certfile = os.getenv("SSL_CERTFILE")

if ssl_keyfile and ssl_certfile:
    # Run with TLS
else:
    # Run without TLS (development mode)
    logger.warning("Running without TLS - not recommended for production")
```

| Pros | Cons |
|------|------|
| Backward compatible | Users may ignore warnings |
| Easy upgrade path | Two code paths to maintain |
| Doesn't break existing setups | Could give false sense of security |
| Clear warning when insecure | |

**Best for:** MVP with gradual security adoption

---

### Recommended Solution: Option D (Optional TLS) + Option C (mkcert for dev)

**Rationale:**

1. **Doesn't break existing workflows** - Current users can keep running without changes
2. **Clear upgrade path** - Add certificates when ready for production
3. **Developer-friendly** - mkcert provides friction-free local HTTPS
4. **Warning system** - Logs make it clear when running insecurely
5. **Production-ready option** - Same code works with real certificates

---

## Part 2: Server Binds to 0.0.0.0

### Why This Is Critical

#### Current Vulnerability

```python
# api_server.py line 133
uvicorn.run("agents.api_server:app", host="0.0.0.0", port=port, reload=False)
```

`0.0.0.0` means "listen on all network interfaces":
- `127.0.0.1` (localhost)
- `192.168.x.x` (LAN)
- `10.x.x.x` (VPN/corporate network)
- Public IP (if directly connected)

#### Attack Scenarios

**1. LAN-Based Attack**

Any device on the same local network can access the API:

```bash
# Attacker on same WiFi scans for open ports
nmap -p 8081 192.168.1.0/24

# Finds the victim's machine
# Attacker's browser/script can now call the API
curl http://192.168.1.105:8081/api/interpreter/actionplan \
  -H "X-API-Key: <brute-force or stolen>" \
  -d '{"transcript": "navigate to evil.com"}'
```

**2. Firewall Misconfiguration**

If the user's firewall has port 8081 open (or UPnP enabled):
- The API becomes accessible from the internet
- Shodan/Censys can discover it
- Automated scanners will find and probe it

**3. Shared Computer Risk**

On a multi-user system (university lab, shared workstation):
- Other users can call the API
- Combined with API key brute-forcing, full access possible

**4. Container/VM Escape Path**

In containerized environments, `0.0.0.0` may expose the service to:
- Other containers on the same network
- The host machine
- Adjacent VMs

#### Risk Rating

| Factor | Assessment |
|--------|------------|
| **CVSS Score** | 6.5 (Medium-High) |
| **Attack Complexity** | Low - just need network access |
| **Prerequisites** | Must be on same network (reduces scope) |
| **Impact** | High if combined with auth bypass |

---

### Solution Options Analysis

#### Option A: Bind to localhost Only

**How it works:** Change default bind address to `127.0.0.1`.

```python
host = os.getenv("VCAA_API_HOST", "127.0.0.1")
uvicorn.run("agents.api_server:app", host=host, port=port)
```

| Pros | Cons |
|------|------|
| Most restrictive by default | Breaks remote access use cases |
| Zero configuration needed | Can't run server on different machine |
| Defense in depth | Docker/container networking needs adjustment |
| Simple change | |

**Best for:** Single-machine deployments (the common case)

---

#### Option B: Environment Variable Control

**How it works:** Let users choose bind address, but default to localhost.

```python
host = os.getenv("VCAA_API_HOST", "127.0.0.1")  # Safe default
# User can override: export VCAA_API_HOST="0.0.0.0" if needed
```

| Pros | Cons |
|------|------|
| Secure by default | Users might blindly set 0.0.0.0 |
| Flexible for advanced users | Requires documentation |
| Backward compatible with override | |
| Explicit opt-in to less secure mode | |

**Best for:** Balance of security and flexibility

---

#### Option C: Network Interface Selection

**How it works:** Allow binding to specific interfaces by name.

```python
# Bind to specific interface
VCAA_API_INTERFACE=en0  # or eth0, wlan0, etc.
```

| Pros | Cons |
|------|------|
| Fine-grained control | Complex to implement |
| Can bind to VPN interface only | Interface names vary by OS |
| | Overkill for this use case |

**Best for:** Enterprise deployments (not applicable here)

---

#### Option D: Localhost + SSH Tunnel Documentation

**How it works:** Bind to localhost, document SSH tunneling for remote access.

```bash
# On remote machine, tunnel port 8081
ssh -L 8081:localhost:8081 user@server
```

| Pros | Cons |
|------|------|
| Maximum security | Extra step for remote users |
| Encrypted tunnel for free | Requires SSH access |
| No code changes for remote support | Not Windows-friendly |

**Best for:** Security-conscious remote deployments

---

### Recommended Solution: Option B (Environment Variable with Safe Default)

**Rationale:**

1. **Secure by default** - New users automatically get localhost binding
2. **Explicit opt-in** - Advanced users can override with `VCAA_API_HOST=0.0.0.0`
3. **Clear documentation** - README explains risks of non-localhost binding
4. **Backward compatible** - Existing scripts can add the env var if needed
5. **Warning on dangerous config** - Log warning when binding to 0.0.0.0

---

## Combined Implementation Plan

### Phase 1: Localhost Binding (Immediate)

#### Step 1.1: Update default host binding

Modify `agents/api_server.py`:

- Change default host from `"0.0.0.0"` to `"127.0.0.1"`
- Read `VCAA_API_HOST` environment variable
- Add warning log if host is `0.0.0.0` or public IP

#### Step 1.2: Add host validation

- Detect if host is not localhost
- Log security warning at startup
- Require explicit confirmation via `VCAA_ALLOW_REMOTE=true` for non-localhost

#### Step 1.3: Update .env.example

Add host configuration:

```bash
# API server bind address (default: 127.0.0.1)
# WARNING: Setting to 0.0.0.0 exposes the API to your entire network
VCAA_API_HOST=127.0.0.1
```

### Phase 2: TLS Support (Priority)

#### Step 2.1: Add TLS configuration options

Modify `agents/api_server.py`:

- Add `SSL_KEYFILE` environment variable support
- Add `SSL_CERTFILE` environment variable support
- Configure uvicorn with SSL when both are provided
- Log warning when running without TLS

#### Step 2.2: Certificate path validation

- Check if certificate files exist and are readable
- Validate certificate format (PEM)
- Provide clear error messages for common issues
- Check certificate expiration and warn if < 30 days

#### Step 2.3: Update .env.example

Add TLS configuration:

```bash
# TLS Configuration (recommended for production)
# Generate development certs: mkcert localhost 127.0.0.1
SSL_KEYFILE=
SSL_CERTFILE=
```

### Phase 3: Extension Updates

#### Step 3.1: Update default API base

Modify `extension/background.js`:

- Keep `http://localhost:8081` as default for development compatibility
- Add logic to detect HTTPS availability
- Store protocol preference in `chrome.storage`

#### Step 3.2: Add connection security indicator

Modify `extension/popup.html` and `extension/popup.js`:

- Show padlock icon when connected via HTTPS
- Show warning icon when using HTTP
- Add tooltip explaining security implications

#### Step 3.3: HTTPS preference option

Modify extension popup:

- Add checkbox: "Require HTTPS connection"
- When enabled, reject HTTP connections with clear error
- Default: unchecked (for development compatibility)

### Phase 4: Documentation

#### Step 4.1: Update README.md

Add "Secure Deployment" section:

- How to generate certificates with mkcert (development)
- How to use Let's Encrypt certificates (production)
- Explanation of host binding options
- Security implications of each configuration

#### Step 4.2: Add certificate generation guide

Create `docs/security/tls-setup.md`:

- mkcert installation and usage
- Self-signed certificate generation with OpenSSL
- Let's Encrypt with Caddy/nginx
- Troubleshooting common certificate issues

#### Step 4.3: Update Security Notice

Update README.md security table:

- Change "HTTPS/TLS enforcement" from "Pending" to "Implemented"
- Change "Bind to localhost instead of 0.0.0.0" from "Pending" to "Implemented"

### Phase 5: Startup Validation

#### Step 5.1: Security configuration check

Add startup validation in `api_server.py`:

- Check if running with TLS
- Check bind address
- Print security summary at startup:

```
╔══════════════════════════════════════════════════════════╗
║                  VCAA Security Status                     ║
╠══════════════════════════════════════════════════════════╣
║  Bind Address: 127.0.0.1 (localhost only)          ✓     ║
║  TLS Enabled:  Yes (cert expires: 2025-12-01)      ✓     ║
║  API Auth:     Required                            ✓     ║
╚══════════════════════════════════════════════════════════╝
```

#### Step 5.2: Fail-fast for insecure production config

Add `VCAA_ENV` environment variable:

- When `VCAA_ENV=production`:
  - Require TLS (fail startup without certs)
  - Require localhost binding (or explicit override)
  - Require API key to be set
- When `VCAA_ENV=development` (default):
  - Allow insecure configurations with warnings

### Phase 6: Testing

#### Step 6.1: Unit tests

Create tests for:

- TLS configuration loading
- Host binding validation
- Certificate validation logic
- Security warning generation

#### Step 6.2: Integration tests

- Test HTTPS connection from extension
- Test localhost-only binding rejects remote connections
- Test certificate expiration warnings

#### Step 6.3: Manual testing checklist

```
[ ] Generate mkcert certificates for localhost
[ ] Configure SSL_KEYFILE and SSL_CERTFILE
[ ] Start server - verify HTTPS works
[ ] Verify extension connects over HTTPS
[ ] Remove certs - verify HTTP fallback with warning
[ ] Set VCAA_API_HOST=0.0.0.0 - verify warning logged
[ ] Set VCAA_ENV=production without TLS - verify startup fails
[ ] Test from another machine - verify localhost binding blocks access
[ ] Check certificate expiration warning (use short-lived test cert)
```

---

## Files to Modify/Create

| File | Action | Description |
|------|--------|-------------|
| `agents/api_server.py` | Modify | Add TLS support, localhost default, security checks |
| `extension/background.js` | Modify | Update default handling, add HTTPS detection |
| `extension/popup.html` | Modify | Add security indicator |
| `extension/popup.js` | Modify | Add security indicator logic |
| `.env.example` | Modify | Add TLS and host configuration |
| `README.md` | Modify | Add secure deployment section, update security table |
| `docs/security/tls-setup.md` | Create | Certificate generation guide |

---

## Environment Variables Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `VCAA_API_HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` for network access) |
| `VCAA_API_PORT` | `8081` | API server port |
| `SSL_KEYFILE` | (none) | Path to TLS private key (PEM format) |
| `SSL_CERTFILE` | (none) | Path to TLS certificate (PEM format) |
| `VCAA_ENV` | `development` | Set to `production` to enforce secure defaults |
| `VCAA_ALLOW_REMOTE` | `false` | Set to `true` to allow non-localhost binding |

---

## Security Checklist (Post-Implementation)

- [ ] Default bind address is `127.0.0.1`
- [ ] TLS works when certificates are configured
- [ ] Warning logged when running without TLS
- [ ] Warning logged when binding to `0.0.0.0`
- [ ] Production mode rejects insecure configurations
- [ ] Extension shows connection security status
- [ ] Certificate expiration warnings work
- [ ] Documentation covers secure deployment
- [ ] .env.example includes all security options

---

## Quick Start for Developers

### Development (HTTP, localhost)

```bash
# No changes needed - secure by default
export VCAA_API_KEY=$(openssl rand -hex 32)
python -m agents.api_server
# Runs on http://127.0.0.1:8081
```

### Development (HTTPS, localhost)

```bash
# One-time setup
brew install mkcert  # or apt install mkcert
mkcert -install
mkcert localhost 127.0.0.1 ::1

# Start server with TLS
export VCAA_API_KEY=$(openssl rand -hex 32)
export SSL_KEYFILE=./localhost-key.pem
export SSL_CERTFILE=./localhost.pem
python -m agents.api_server
# Runs on https://127.0.0.1:8081
```

### Production

```bash
export VCAA_ENV=production
export VCAA_API_KEY=$(openssl rand -hex 32)
export SSL_KEYFILE=/etc/ssl/private/vcaa.key
export SSL_CERTFILE=/etc/ssl/certs/vcaa.crt
python -m agents.api_server
# Fails if certs missing or invalid
```

---

## References

- [OWASP Transport Layer Protection Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Protection_Cheat_Sheet.html)
- [mkcert - Local HTTPS Development](https://github.com/FiloSottile/mkcert)
- [Uvicorn SSL Configuration](https://www.uvicorn.org/settings/#https)
- [Let's Encrypt - Free TLS Certificates](https://letsencrypt.org/)
