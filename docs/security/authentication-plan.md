# Authentication Implementation Plan

## Overview

This document outlines the plan to implement API authentication for Vocal Web, addressing the critical security vulnerability of unauthenticated API access.

---

## Why This Is Critical

### Current Vulnerability

The Vocal Web API server currently has **no authentication**. Any application, website, or script can call the API endpoints:

```python
# Current state in api_server.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],         # Any origin allowed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### Attack Scenarios

**1. Malicious Website Hijacking**

A user visits `evil-site.com` while the Vocal Web extension is active. The malicious site can:

```javascript
// Attacker's code on evil-site.com
fetch("http://localhost:8081/api/interpreter/actionplan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        schema_version: "stt_v1",
        id: "attack-1",
        transcript: "Navigate to phishing-bank.com and enter my password",
        metadata: {}
    })
});
```

**2. Data Exfiltration**

The DOMMap endpoint captures all interactive elements on a page, including:
- Form field values (potentially passwords before submission)
- Hidden fields with tokens
- Page content and structure

An attacker can trigger DOMMap collection and exfiltrate sensitive page content.

**3. Unauthorized Browser Control**

Without authentication, any local application can:
- Navigate the user's browser to arbitrary URLs
- Fill forms with attacker-controlled data
- Click buttons and submit forms
- Scroll and interact with pages

**4. Voice Command Injection**

The STT endpoint accepts audio and returns transcripts. An attacker could:
- Submit fake audio to trigger malicious actions
- Bypass voice-based "authentication" if the user relies on it

### Risk Rating

| Factor | Assessment |
|--------|------------|
| **CVSS Score** | 9.8 (Critical) |
| **Attack Complexity** | Low - requires only HTTP requests |
| **Privileges Required** | None |
| **User Interaction** | None - attack works silently |
| **Impact** | High - full browser control, data theft |

---

## Solution: Hybrid Authentication (API Key + Origin Validation)

### Why This Approach?

We evaluated six authentication methods:

| Method | Simplicity | Security | Extension Support | MVP Fit |
|--------|------------|----------|-------------------|---------|
| Static API Key | High | Medium | Excellent | Good |
| JWT Tokens | Medium | High | Good | Overkill |
| Session/Cookie | Medium | Medium | Poor | Bad Fit |
| Extension Handshake | Medium | Medium | Good | Complex |
| **Hybrid (Key + Origin)** | **High** | **High** | **Excellent** | **Best** |
| mTLS | Low | Very High | Poor | Overkill |

**Hybrid approach wins because:**

1. **Defense in Depth** - Two independent checks (origin + key) must pass
2. **Simple Implementation** - No database, no token refresh logic
3. **Extension-Friendly** - Chrome storage handles key persistence
4. **Blocks Main Threat** - Malicious sites fail both origin and key checks
5. **Upgrade Path** - Can add JWT layer later without breaking changes

---

## Implementation Plan

### Phase 1: Backend API Key Authentication

#### Step 1.1: Create authentication module

Create `agents/shared/auth.py`:

- Define `verify_api_key()` dependency function
- Read `VCAA_API_KEY` from environment
- Use `secrets.compare_digest()` for timing-safe comparison
- Raise `HTTPException(401)` on failure
- Log authentication attempts (without logging the key itself)

#### Step 1.2: Apply to endpoints

Modify `agents/api_server.py`:

- Import `verify_api_key` from auth module
- Add `Depends(verify_api_key)` to:
  - `POST /api/stt/transcribe`
  - `POST /api/interpreter/actionplan`
  - `POST /api/navigator/executionplan`
  - `POST /api/execution/result`
- Keep `GET /health` unauthenticated for monitoring

#### Step 1.3: Key validation rules

- Minimum length: 32 characters
- Allowed characters: alphanumeric, hyphens, underscores
- Reject empty or whitespace-only keys

### Phase 2: CORS Origin Allowlist

#### Step 2.1: Configure allowed origins

Modify `agents/api_server.py`:

- Add `VCAA_ALLOWED_ORIGINS` environment variable
- Default: `chrome-extension://` prefix pattern
- Support comma-separated list for multiple origins

#### Step 2.2: Implement origin validator

- Create custom CORS origin validator function
- Allow all `chrome-extension://` origins (extension IDs vary per install)
- Allow explicitly configured origins
- Reject all other origins

#### Step 2.3: Tighten CORS settings

- Set `allow_credentials=False`
- Restrict `allow_methods` to `["GET", "POST", "OPTIONS"]`
- Restrict `allow_headers` to `["Content-Type", "X-API-Key"]`

### Phase 3: Extension Integration

#### Step 3.1: Update popup UI

Modify `extension/popup.html`:

- Add "API Key" input field (type="password")
- Add show/hide toggle button
- Position below existing "API Base" field
- Add visual indicator for key status (set/not set)

#### Step 3.2: Implement key storage

Modify `extension/popup.js`:

- Load API key from `chrome.storage.sync` on popup open
- Save API key to storage on user input
- Key stored as `vcaaApiKey`
- Validate key format before saving

#### Step 3.3: Add auth headers to API calls

Modify `extension/background.js`:

- Create `getApiKey()` async function
- Create `getAuthHeaders()` helper returning `{ "X-API-Key": key }`
- Update `fetchActionPlan()` to include auth header
- Update `fetchExecutionPlan()` to include auth header
- Update `sendExecutionResult()` to include auth header

#### Step 3.4: Handle authentication errors

Modify `extension/background.js`:

- Detect 401/403 responses from API
- Return user-friendly error message
- Prompt user to check API key configuration

### Phase 4: Local Access Page

#### Step 4.1: Mirror popup changes

Modify `extension/local-access.html`:

- Add API key input field matching popup design
- Consistent styling and layout

#### Step 4.2: Share authentication logic

Modify `extension/local-access.js`:

- Use same `chrome.storage.sync` key (`vcaaApiKey`)
- Implement same validation and error handling

### Phase 5: Security Hardening

#### Step 5.1: Rate limiting for auth failures

Modify `agents/shared/auth.py`:

- Track failed attempts by IP address (in-memory dict)
- Block IP after 10 failures in 60 seconds
- Auto-expire blocks after 5 minutes
- Log blocked attempts

#### Step 5.2: Secure error responses

Modify `agents/api_server.py`:

- Return generic "Invalid or missing API key" for all auth failures
- Don't differentiate between missing, malformed, or wrong keys
- Prevents information leakage about valid keys

#### Step 5.3: Key generation helper

Create helper script or document command:

```bash
# Generate secure 32-byte hex key
openssl rand -hex 32
```

### Phase 6: Documentation

#### Step 6.1: Update README.md

Add "Authentication Setup" section:

- How to generate an API key
- How to set `VCAA_API_KEY` environment variable
- How to configure key in extension
- Troubleshooting authentication errors

#### Step 6.2: Create .env.example

Create `.env.example` file:

```bash
# Required: API authentication key (generate with: openssl rand -hex 32)
VCAA_API_KEY=

# Optional: Allowed CORS origins (comma-separated)
VCAA_ALLOWED_ORIGINS=

# ASI Cloud configuration
ASI_CLOUD_API_URL=https://inference.asicloud.cudos.org/v1
ASI_CLOUD_API_KEY=
ASI_CLOUD_MODEL=asi1-mini

# Google Speech-to-Text
GOOGLE_APPLICATION_CREDENTIALS=
```

#### Step 6.3: Update Security Notice

Update `README.md` security table:

- Change "API authentication" status from "Pending" to "Implemented"
- Change "CORS origin allowlist" status from "Pending" to "Implemented"

### Phase 7: Testing

#### Step 7.1: Unit tests

Create `tests/test_auth.py`:

- Test valid key acceptance
- Test invalid key rejection (wrong key)
- Test missing key rejection (no header)
- Test malformed key rejection (too short)
- Test timing-safe comparison works

#### Step 7.2: Integration tests

Create `tests/test_api_auth.py`:

- Test authenticated request to each endpoint succeeds
- Test unauthenticated request returns 401
- Test wrong key returns 401
- Test CORS blocks unauthorized origins

#### Step 7.3: Manual testing checklist

```
[ ] Generate new API key with openssl
[ ] Set VCAA_API_KEY environment variable
[ ] Start API server
[ ] Verify /health returns 200 (no auth required)
[ ] Verify /api/interpreter/actionplan returns 401 without key
[ ] Verify /api/interpreter/actionplan returns 401 with wrong key
[ ] Load extension in Chrome
[ ] Configure API key in extension popup
[ ] Verify extension can make authenticated requests
[ ] Verify voice commands work end-to-end
[ ] Open browser console on random website
[ ] Verify fetch to localhost:8081 is blocked by CORS
[ ] Verify curl without X-API-Key header returns 401
[ ] Verify curl with correct X-API-Key header succeeds
```

---

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `agents/shared/auth.py` | Create | Authentication logic and rate limiting |
| `agents/api_server.py` | Modify | Add auth dependency, update CORS |
| `extension/popup.html` | Modify | Add API key input field |
| `extension/popup.js` | Modify | Key storage and validation |
| `extension/background.js` | Modify | Add auth headers to API calls |
| `extension/local-access.html` | Modify | Add API key input field |
| `extension/local-access.js` | Modify | Key storage and validation |
| `README.md` | Modify | Document authentication setup |
| `.env.example` | Create | Environment variable template |
| `tests/test_auth.py` | Create | Authentication unit tests |
| `tests/test_api_auth.py` | Create | API integration tests |

---

## Rollout Checklist

Before merging:

- [ ] All tests pass
- [ ] Manual testing completed
- [ ] README updated with setup instructions
- [ ] .env.example created
- [ ] Security table in README updated
- [ ] No API keys committed to repository
- [ ] Existing functionality still works with auth enabled

---

## Future Enhancements

After MVP authentication is stable, consider:

1. **JWT Tokens** - For multi-user deployments with user-specific permissions
2. **Key Rotation** - Endpoint to rotate keys without downtime
3. **Audit Logging** - Persistent log of all authenticated actions
4. **Per-Key Rate Limits** - Different limits for different API keys
5. **Key Scopes** - Restrict keys to specific endpoints (read-only, etc.)

---

## References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [FastAPI Security Documentation](https://fastapi.tiangolo.com/tutorial/security/)
- [Chrome Extension Storage API](https://developer.chrome.com/docs/extensions/reference/storage/)
