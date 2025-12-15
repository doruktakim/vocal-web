/**
 * Fast command detection and execution for primitive browser actions.
 * Bypasses the full Interpreter/Navigator pipeline for instant response.
 */

const FAST_COMMAND_PATTERNS = [
  // Scroll down commands
  {
    patterns: [
      /\b(scroll|page|go)\s*(down|lower)\b/i,
      /\bdown\s*(a\s*)?(page|screen)?\b/i,
      /\bscroll\s*down\b/i,
    ],
    action: { type: "scroll", direction: "down" }
  },
  // Scroll up commands
  {
    patterns: [
      /\b(scroll|page|go)\s*(up|higher)\b/i,
      /\bup\s*(a\s*)?(page|screen)?\b/i,
      /\bscroll\s*up\b/i,
    ],
    action: { type: "scroll", direction: "up" }
  },

  // History back navigation
  {
    patterns: [
      /\b(go\s*)?back\b/i,
      /\bprevious\s*(page)?\b/i,
      /\breturn\b/i,
      /\bgo\s+to\s+(the\s+)?previous\s+(page)?\b/i,
    ],
    action: { type: "history_back" }
  },
  // History forward navigation
  {
    patterns: [
      /\b(go\s*)?forward\b/i,
      /\bnext\s*(page)?\b/i,
      /\bgo\s+to\s+(the\s+)?next\s+(page)?\b/i,
    ],
    action: { type: "history_forward" }
  },

  // Page refresh
  {
    patterns: [
      /\b(refresh|reload)\s*(the\s*)?(page|this)?\b/i,
      /\brefresh\b/i,
      /\breload\b/i,
    ],
    action: { type: "reload" }
  },

  // Scroll to top
  {
    patterns: [
      /\b(scroll|go)\s*(to\s*)?(the\s*)?(top|beginning|start)\b/i,
      /\btop\s*of\s*(the\s*)?page\b/i,
      /\bgo\s+to\s+(the\s+)?top\b/i,
      /\bscroll\s+to\s+top\b/i,
    ],
    action: { type: "scroll_to", position: "top" }
  },
  // Scroll to bottom
  {
    patterns: [
      /\b(scroll|go)\s*(to\s*)?(the\s*)?(bottom|end)\b/i,
      /\bbottom\s*of\s*(the\s*)?page\b/i,
      /\bgo\s+to\s+(the\s+)?bottom\b/i,
      /\bscroll\s+to\s+bottom\b/i,
    ],
    action: { type: "scroll_to", position: "bottom" }
  },
];

// Keywords that suggest a command might be a fast command (for quick pre-filtering)
const FAST_COMMAND_KEYWORDS = [
  'scroll', 'up', 'down', 'back', 'forward',
  'refresh', 'reload', 'top', 'bottom', 'page',
  'previous', 'next', 'return'
];

/**
 * Quick pre-check if a transcript might be a fast command.
 * Used to avoid expensive regex matching on clearly complex commands.
 * @param {string} transcript - The user's voice command
 * @returns {boolean}
 */
function isProbablyFastCommand(transcript) {
  if (!transcript) return false;
  const lower = transcript.toLowerCase();
  // If the transcript is too long, it's probably a complex command
  if (lower.split(/\s+/).length > 6) return false;
  return FAST_COMMAND_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Attempt to match a transcript to a fast command.
 * @param {string} transcript - The user's voice command
 * @returns {object|null} - The matched action or null if no match
 */
function matchFastCommand(transcript) {
  if (!transcript) return null;

  const normalized = transcript.toLowerCase().trim();

  // Quick pre-check to avoid unnecessary regex matching
  if (!isProbablyFastCommand(normalized)) {
    return null;
  }

  for (const command of FAST_COMMAND_PATTERNS) {
    for (const pattern of command.patterns) {
      if (pattern.test(normalized)) {
        return { ...command.action };
      }
    }
  }

  return null;
}

// Export for use in background.js (service worker context)
if (typeof globalThis !== 'undefined') {
  globalThis.matchFastCommand = matchFastCommand;
  globalThis.isProbablyFastCommand = isProbablyFastCommand;
}
