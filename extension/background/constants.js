const DEFAULT_API_BASE = "http://localhost:8081";
const CONTENT_SCRIPT_FILE = "content.js";
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const SIDE_PANEL_BEHAVIOR = { openPanelOnActionClick: true };

// ============================================================================
// Session Storage Keys for Pending Execution Plans
// ============================================================================
const SESSION_STORAGE_KEYS = {
  PENDING_PLAN: "vcaaPendingPlan",
};
const LAST_DEBUG_STORAGE_KEY = "vcaaLastDebug";

// ============================================================================
// Debug Recording (feature-flagged via DEBUG_RECORDING=1 in sync storage)
// ============================================================================

const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
const AX_RECORDING_STORAGE_KEYS = {
  AGENT_PREFIX: "axrec_agent:",
  HUMAN_ACTIVE: "axrec_human:active",
  HUMAN_PREFIX: "axrec_human:",
};
const AX_CAPTURE_CONTEXT = {
  method: "Accessibility.getFullAXTree",
  notes: "CDP Accessibility.getFullAXTree depth=15",
};

// ============================================================================
const STORAGE_KEYS = {
  API_BASE: "vcaaApiBase",
  API_KEY: "vcaaApiKey",
  REQUIRE_HTTPS: "vcaaRequireHttps",
  PROTOCOL_PREFERENCE: "vcaaProtocolPreference",
};
const HEALTH_TIMEOUT_MS = 2500;

const HUMAN_CLARIFICATION_REASONS = new Set([
  "missing_query",
  "ambiguous_destination",
  "ambiguous_origin",
  "missing_origin",
  "missing_destination",
  "missing_date",
  "ambiguous_date",
]);
