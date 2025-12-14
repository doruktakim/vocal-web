# Security Fixes Plan: URL Validation and DOMMap Sensitive Field Exclusion

## Executive Summary

This document outlines a detailed plan to address two critical security vulnerabilities discovered in the Vocal Web extension:

1. **No URL Validation Before Navigation** - URLs from execution plans are used directly in `window.location.href` without any validation
2. **Sensitive Fields Not Excluded from DOMMap** - The DOMMap captures all form field values, including passwords, credit card numbers, and other sensitive data

Both vulnerabilities represent significant security and privacy risks that must be addressed before production deployment.

---

## Issue 1: No URL Validation Before Navigation

### Why This Is Critical

**Attack Vectors:**
- **JavaScript Protocol Injection**: An attacker who can influence the execution plan could inject `javascript:maliciousCode()` URLs, leading to arbitrary JavaScript execution in the context of the current page (XSS)
- **Data URL Attacks**: Malicious `data:text/html,<script>...</script>` URLs could execute arbitrary code
- **Phishing**: Users could be redirected to malicious look-alike sites without any warning
- **Protocol Handlers**: URLs like `file://`, `ftp://`, or custom protocol handlers could be invoked unexpectedly
- **Open Redirect Vulnerability**: The extension becomes an open redirect, which can be exploited for phishing attacks

**Affected Locations:**
| File | Line | Code |
|------|------|------|
| [content.js:280](extension/content.js#L280) | 280 | `window.location.href = step.value;` |
| [local-access.js:432](extension/local-access.js#L432) | 432 | `window.location.href = url;` |

**Current Code Analysis:**

In `content.js`, the `executePlan()` function:
```javascript
if (step.action_type === "navigate") {
  try {
    if (step.value) {
      window.location.href = step.value;  // No validation whatsoever
```

In `local-access.js`, the `handleRedirect()` function:
```javascript
const url = plan.value || plan.entities?.url;
if (!url) {
  return false;
}
window.location.href = url;  // Only checks if URL exists, not if it's safe
```

### Options Analysis

#### Option A: Protocol Allowlist Only

**Approach:** Only allow `http:` and `https:` protocols.

**Implementation:**
```javascript
function isAllowedProtocol(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}
```

**Pros:**
- Simple implementation
- Blocks `javascript:`, `data:`, `file:`, `vbscript:` attacks
- Low false-positive rate

**Cons:**
- Does not prevent open redirect attacks
- Does not validate URL structure
- No domain-based restrictions

#### Option B: Protocol Allowlist + URL Structure Validation

**Approach:** Validate protocol AND ensure the URL is well-formed.

**Implementation:**
```javascript
function isValidNavigationUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, reason: 'invalid_protocol' };
    }
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { valid: false, reason: 'missing_hostname' };
    }
    return { valid: true, url: parsed.href };
  } catch (e) {
    return { valid: false, reason: 'malformed_url' };
  }
}
```

**Pros:**
- Blocks protocol attacks
- Validates URL structure
- Returns normalized URL

**Cons:**
- Still allows any domain (open redirect)
- May require relative URL handling

#### Option C: Full Validation with Domain Allowlist (Recommended)

**Approach:** Protocol validation + URL structure validation + optional domain allowlist for trusted sites.

**Implementation:**
```javascript
const KNOWN_SAFE_DOMAINS = [
  'google.com', 'youtube.com', 'expedia.com', 'booking.com',
  // Add other trusted domains as needed
];

function isValidNavigationUrl(url, options = {}) {
  const { allowUnknownDomains = true } = options;

  try {
    // Handle relative URLs by resolving against current origin
    const parsed = new URL(url, window.location.origin);

    // 1. Protocol validation - CRITICAL
    const allowedProtocols = ['http:', 'https:'];
    if (!allowedProtocols.includes(parsed.protocol)) {
      return {
        valid: false,
        reason: 'blocked_protocol',
        message: `Protocol "${parsed.protocol}" is not allowed`
      };
    }

    // 2. Hostname validation
    if (!parsed.hostname || parsed.hostname.length === 0) {
      return { valid: false, reason: 'missing_hostname' };
    }

    // 3. Domain validation (optional layer)
    if (!allowUnknownDomains) {
      const domain = extractRootDomain(parsed.hostname);
      if (!KNOWN_SAFE_DOMAINS.includes(domain)) {
        return {
          valid: false,
          reason: 'unknown_domain',
          message: `Domain "${domain}" is not in the allowlist`
        };
      }
    }

    return { valid: true, url: parsed.href, hostname: parsed.hostname };
  } catch (e) {
    return { valid: false, reason: 'malformed_url', message: e.message };
  }
}

function extractRootDomain(hostname) {
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return hostname;
}
```

**Pros:**
- Blocks all dangerous protocols
- Validates URL structure
- Optional domain restriction for high-security mode
- Returns normalized, safe URL
- Flexible configuration

**Cons:**
- Slightly more complex
- Domain allowlist requires maintenance
- May block legitimate but unknown sites in strict mode

#### Option D: Content Security Policy (CSP) Approach

**Approach:** Rely on CSP headers to restrict navigation.

**Pros:**
- Browser-enforced security
- Works at a lower level

**Cons:**
- CSP cannot block `javascript:` URLs in all cases
- Extension context may not fully respect CSP
- Not a complete solution on its own

### Recommended Solution: Option C

**Rationale:**
1. **Defense in depth**: Multiple validation layers provide better protection
2. **Flexibility**: The optional domain allowlist can be enabled for high-security use cases
3. **Transparency**: Clear error messages help debugging
4. **Standards-based**: Uses the URL API for proper parsing
5. **Extensible**: Easy to add new validation rules in the future

### Implementation Steps

1. **Create a URL validation utility module** (`extension/lib/url-validator.js`)
   - Implement `isValidNavigationUrl()` function
   - Export validation constants (allowed protocols, known domains)
   - Include comprehensive error messages

2. **Update content.js (line 280)**
   - Import the validation utility
   - Validate URL before navigation
   - Log blocked attempts for debugging
   - Return error status for invalid URLs

3. **Update local-access.js (line 432)**
   - Import the validation utility
   - Validate URL before navigation
   - Display user-friendly error message
   - Prevent navigation for invalid URLs

4. **Add unit tests**
   - Test `javascript:` protocol blocking
   - Test `data:` URL blocking
   - Test valid HTTP/HTTPS URLs
   - Test malformed URLs
   - Test relative URL handling

---

## Issue 2: Sensitive Fields Not Excluded from DOMMap

### Why This Is Critical

**Privacy Risks:**
- **Password Exposure**: User passwords are captured and sent to the API server
- **Financial Data Leakage**: Credit card numbers, CVVs, bank account details are captured
- **PII Exposure**: SSN, driver's license numbers, and other personally identifiable information
- **Compliance Violations**: Violates GDPR, PCI-DSS, HIPAA, and other data protection regulations
- **Data Breach Amplification**: If the API server is compromised, all captured sensitive data is exposed

**Affected Location:**
| File | Line | Code |
|------|------|------|
| [content.js:242](extension/content.js#L242) | 242 | `value: el.value \|\| null,` |

**Current Code Analysis:**

The `captureDomMap()` function in `content.js` captures **all** form elements:

```javascript
function captureDomMap() {
  const selector = "input, button, select, textarea, a, [role='button'], ...";
  // ...
  elements.push({
    element_id: elementId,
    tag: el.tagName.toLowerCase(),
    type: el.type || null,        // Captures "password", "text", etc.
    // ...
    value: el.value || null,      // CAPTURES THE ACTUAL VALUE - THIS IS THE PROBLEM
    // ...
  });
}
```

**What Gets Sent to the API:**
```json
{
  "element_id": "el_42",
  "tag": "input",
  "type": "password",
  "name": "password",
  "value": "MySecretPassword123!",  // <-- User's actual password sent to API
  "visible": true
}
```

### Options Analysis

#### Option A: Exclude All Input Values

**Approach:** Never capture the `value` attribute for any input element.

**Implementation:**
```javascript
elements.push({
  // ...
  value: null,  // Never capture values
  // ...
});
```

**Pros:**
- Maximum privacy protection
- Simple implementation
- No risk of data leakage

**Cons:**
- **Breaks functionality**: The navigator needs to see current field values to make intelligent decisions about what to fill
- Form state awareness is lost
- May cause incorrect auto-fill behavior

#### Option B: Type-Based Blocklist (Recommended)

**Approach:** Block value capture for known sensitive input types.

**Implementation:**
```javascript
const SENSITIVE_INPUT_TYPES = new Set([
  'password',
  'credit-card',
  'new-password',
  'current-password',
]);

const SENSITIVE_AUTOCOMPLETE_VALUES = new Set([
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-type',
  'new-password',
  'current-password',
  'one-time-code',
]);

const SENSITIVE_NAME_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /credit.?card/i,
  /card.?number/i,
  /cvv/i,
  /cvc/i,
  /security.?code/i,
  /ssn/i,
  /social.?security/i,
  /tax.?id/i,
  /ein/i,
  /pin/i,
  /routing.?number/i,
  /account.?number/i,
];

function isSensitiveField(el) {
  // Check input type
  if (SENSITIVE_INPUT_TYPES.has(el.type)) {
    return true;
  }

  // Check autocomplete attribute
  const autocomplete = el.getAttribute('autocomplete') || '';
  if (SENSITIVE_AUTOCOMPLETE_VALUES.has(autocomplete)) {
    return true;
  }

  // Check name/id patterns
  const name = (el.name || '').toLowerCase();
  const id = (el.id || '').toLowerCase();
  const placeholder = (el.placeholder || '').toLowerCase();

  for (const pattern of SENSITIVE_NAME_PATTERNS) {
    if (pattern.test(name) || pattern.test(id) || pattern.test(placeholder)) {
      return true;
    }
  }

  return false;
}
```

**Pros:**
- Preserves functionality for non-sensitive fields
- Comprehensive detection using type, autocomplete, and name patterns
- Standards-based (uses HTML autocomplete values)
- Extensible pattern list

**Cons:**
- May miss some edge cases
- Requires maintenance as new patterns emerge
- Pattern matching adds slight overhead

#### Option C: Allowlist Approach

**Approach:** Only capture values for explicitly safe field types.

**Implementation:**
```javascript
const SAFE_VALUE_TYPES = new Set([
  'text',
  'search',
  'tel',      // Phone numbers (debatable)
  'url',
  'number',
  'range',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
  'color',
]);

function shouldCaptureValue(el) {
  if (el.tagName.toLowerCase() === 'select') {
    return true;  // Dropdowns are generally safe
  }
  if (el.tagName.toLowerCase() === 'textarea') {
    // Apply sensitive name pattern check
    return !isSensitiveByName(el);
  }
  return SAFE_VALUE_TYPES.has(el.type) && !isSensitiveByName(el);
}
```

**Pros:**
- Safer default - unknown types are blocked
- Clear list of what IS captured

**Cons:**
- May be overly restrictive
- New HTML input types would be blocked by default

#### Option D: Value Masking for Sensitive Fields

**Approach:** Instead of excluding, mask sensitive values.

**Implementation:**
```javascript
function getMaskedValue(el, value) {
  if (isSensitiveField(el)) {
    if (!value) return null;
    return '*'.repeat(Math.min(value.length, 8));  // Show length hint only
  }
  return value;
}
```

**Pros:**
- Preserves information about field state (empty vs filled)
- Navigator can still make decisions

**Cons:**
- Even masked data reveals something (length)
- May still transmit partial information

#### Option E: Combined Blocklist + Indicator (Recommended Enhancement)

**Approach:** Block values AND add a `sensitive` flag to the element metadata.

**Implementation:**
```javascript
elements.push({
  element_id: elementId,
  tag: el.tagName.toLowerCase(),
  type: el.type || null,
  // ...
  value: isSensitiveField(el) ? null : (el.value || null),
  is_sensitive: isSensitiveField(el),  // New flag for navigator awareness
  has_value: Boolean(el.value),        // Indicates if field has content without revealing it
  // ...
});
```

**Pros:**
- Complete privacy protection for sensitive data
- Navigator knows which fields are sensitive (can avoid them or handle specially)
- Navigator knows if a field has content without seeing the content
- Best balance of privacy and functionality

**Cons:**
- Slightly more complex
- Requires navigator to understand new flags

### Recommended Solution: Option E (Combined Blocklist + Indicator)

**Rationale:**
1. **Maximum privacy**: Sensitive values are never transmitted
2. **Navigator awareness**: The `is_sensitive` flag lets the navigator make informed decisions
3. **State visibility**: `has_value` indicates field state without exposing content
4. **Comprehensive detection**: Multiple detection methods (type, autocomplete, name patterns)
5. **Future-proof**: Easy to add new patterns or modify behavior

### Implementation Steps

1. **Create a sensitive field detection module** (`extension/lib/sensitive-fields.js`)
   - Define `SENSITIVE_INPUT_TYPES` constant
   - Define `SENSITIVE_AUTOCOMPLETE_VALUES` constant
   - Define `SENSITIVE_NAME_PATTERNS` array
   - Implement `isSensitiveField()` function
   - Export all utilities

2. **Update content.js `captureDomMap()` function**
   - Import the sensitive field detection module
   - Modify the element capture to use `isSensitiveField()`
   - Add `is_sensitive` flag to element metadata
   - Add `has_value` flag to element metadata
   - Ensure value is `null` for sensitive fields

3. **Update API schema documentation**
   - Document the new `is_sensitive` field
   - Document the new `has_value` field
   - Update any API validation if needed

4. **Add unit tests**
   - Test password field detection
   - Test credit card field detection (by autocomplete)
   - Test SSN field detection (by name pattern)
   - Test safe field value capture
   - Test flag values are correct

---

## Implementation Priority

| Priority | Task | Effort | Risk Reduction |
|----------|------|--------|----------------|
| P0 | URL Protocol Validation | Low | Critical - blocks XSS |
| P0 | Sensitive Field Exclusion | Medium | Critical - blocks data leakage |
| P1 | URL Structure Validation | Low | High - prevents malformed URLs |
| P1 | Sensitive Name Pattern Matching | Medium | High - catches edge cases |
| P2 | Domain Allowlist (optional) | Medium | Medium - prevents open redirect |
| P2 | DOMMap Schema Updates | Low | Low - improves navigator |

---

## Testing Strategy

### URL Validation Tests

```javascript
// Should block
'javascript:alert(1)'
'javascript:void(0)'
'data:text/html,<script>alert(1)</script>'
'vbscript:msgbox("xss")'
'file:///etc/passwd'
''
null
undefined

// Should allow
'https://google.com'
'http://localhost:8080'
'https://example.com/path?query=1'
'/relative/path'  // Resolves against current origin
```

### Sensitive Field Tests

```javascript
// Should be detected as sensitive
<input type="password">
<input autocomplete="cc-number">
<input name="password">
<input name="creditCard">
<input id="user_ssn">
<input placeholder="Enter your SSN">
<input name="cvv">
<input autocomplete="new-password">

// Should NOT be detected as sensitive
<input type="text" name="username">
<input type="email">
<input type="search">
<select name="country">
<button type="submit">
```

---

## Rollout Plan

1. **Development Phase**
   - Implement URL validation utility
   - Implement sensitive field detection utility
   - Update content.js and local-access.js
   - Write comprehensive unit tests

2. **Testing Phase**
   - Run all unit tests
   - Manual testing on various websites
   - Test edge cases (international sites, SPAs, etc.)
   - Security review of implementation

3. **Deployment Phase**
   - Deploy to staging environment
   - Monitor for false positives/negatives
   - Collect metrics on blocked URLs and sensitive fields
   - Gradual rollout to production

---

## Security Considerations

### URL Validation
- Always use the `URL` constructor for parsing - never regex alone
- Resolve relative URLs against `window.location.origin`
- Log blocked navigation attempts for security monitoring
- Consider rate limiting navigation attempts

### Sensitive Field Detection
- Err on the side of caution - block if uncertain
- Regularly update patterns as new attack vectors emerge
- Consider user consent for any data capture
- Ensure logs never contain captured values

---

## Conclusion

Both security issues represent critical vulnerabilities that must be addressed:

1. **URL Validation** prevents XSS and arbitrary code execution through protocol injection
2. **Sensitive Field Exclusion** prevents leakage of passwords, credit cards, and PII

The recommended solutions (Option C for URLs, Option E for sensitive fields) provide robust protection while maintaining the extension's functionality. Implementation should be prioritized as P0 and completed before any production deployment.
