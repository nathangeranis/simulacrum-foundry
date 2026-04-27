/**
 * Intent classifier — heuristic-only, no LLM call. Classifies the user's
 * latest request into one of the keys in INTENT_PROFILES (see
 * schema-index-service.js). The classification scopes the tool palette
 * and the per-template content injected into the system prompt under
 * smallModelMode.
 *
 * Tradeoffs:
 * - Heuristic-only: keeps the latency floor low (no extra LLM hop) and
 *   the contributor surface tractable. Misclassifications fall through
 *   to `ambiguous`, which retains all tools and templates — same
 *   behavior as before scoping was introduced. Worst case is "no
 *   improvement," not "worse than baseline."
 * - Word-boundary matching: prevents `create` matching inside `creature`,
 *   which the proxy's substring-match version was vulnerable to.
 * - Per-call invocation: callers (chat-handler, conversation-engine,
 *   simulacrum-core) classify the latest user message every turn. The
 *   classifier is cheap enough that caching across turns isn't worth
 *   the cache-invalidation surface.
 */

// Keyword sets keyed by intent vocabulary. Lower-case, deduplicated. Keep
// modest: false positives from over-broad keywords are worse than
// false negatives (which fall back to `ambiguous` and retain everything).
const ACTOR_KEYWORDS = [
  'npc',
  'character',
  'monster',
  'creature',
  'warrior',
  'wizard',
  'knight',
  'goblin',
  'orc',
  'dragon',
  'kobold',
  'skeleton',
  'zombie',
  'vampire',
  'demon',
  'dwarf',
  'elf',
  'halfling',
  'human',
  'tiefling',
  'gnome',
  'vehicle',
  'ship',
  'actor',
  'enemy',
  'ally',
  'henchman',
];

const ITEM_KEYWORDS = [
  'weapon',
  'sword',
  'axe',
  'bow',
  'crossbow',
  'dagger',
  'shield',
  'armor',
  'armour',
  'potion',
  'scroll',
  'spell',
  'ring',
  'amulet',
  'wand',
  'staff',
  'item',
  'tool',
  'consumable',
  'feat',
  'ability',
];

const JOURNAL_KEYWORDS = [
  'journal',
  'note',
  'lore',
  'session',
  'history',
  'page',
  'rumor',
  'rumour',
  'handout',
  'document',
];

const SCENE_KEYWORDS = [
  'scene',
  'map',
  'battlemap',
  'tavern',
  'dungeon',
  'forest',
  'town',
  'village',
  'city',
  'cavern',
  'castle',
];

const CREATE_KEYWORDS = [
  'create',
  'make',
  'spawn',
  'add',
  'build',
  'generate',
  'put',
  'new',
  'craft',
];

const MODIFY_KEYWORDS = [
  'update',
  'change',
  'modify',
  'edit',
  'set',
  'rename',
  'increase',
  'decrease',
  'adjust',
];

const DELETE_KEYWORDS = ['delete', 'remove', 'destroy'];

const SEARCH_KEYWORDS = ['find', 'search', 'list', 'show', 'what', 'where', 'who', 'how many'];

const AUTOMATION_KEYWORDS = ['macro', 'execute', 'run', 'script', 'javascript'];

const ASSET_KEYWORDS = ['icon', 'image', 'token art', 'portrait', 'asset'];

/**
 * Classify a user message into an intent key. Returns one of the keys in
 * INTENT_PROFILES. Falls back to 'ambiguous' when no rule matches —
 * `ambiguous` retains all tools and templates (no scoping).
 *
 * Matching strategy:
 * - Verb keywords (create/modify/delete/search) match on word boundaries
 *   so e.g. "create" doesn't fire on "created" being absent and "creator"
 *   isn't classified as "create" intent.
 * - Object keywords (actor/item/journal/scene names) match via substring
 *   so compound words like "longbow"/"longsword"/"battlemap" naturally
 *   fold into the parent category.
 *
 * Internal — not exported. Production callers use `classifyLatestUserMessage`
 * which wraps this. Tests call this via the same wrapper with a synthetic
 * single-message conversation; keeping the function module-private means
 * knip's dead-code scan doesn't flag a separate export with no production
 * consumer.
 *
 * @param {string|undefined|null} message - raw user message text
 * @returns {string} intent key
 */
function classifyIntent(message) {
  if (!message || typeof message !== 'string') return 'ambiguous';
  const lower = message.toLowerCase();
  const signals = extractSignals(lower);

  if (signals.delete) return 'delete';
  if (signals.create) return classifyCreateIntent(signals);
  return classifyNonCreateIntent(signals);
}

/**
 * Pick the non-create dispatch from a signal bundle. Reached only when
 * `delete` and `create` are both absent — order is the heuristic priority
 * (modify wins over search wins over asset).
 * @param {object} signals
 * @returns {string}
 */
function classifyNonCreateIntent(signals) {
  if (signals.modify) return 'modify';
  if (signals.automation) return 'execute_automation';
  if (signals.search) return 'search_or_list';
  if (signals.asset) return 'asset_management';
  return 'ambiguous';
}

/**
 * Extract boolean signals for each keyword group from a lower-cased message.
 * Pure data — no branching logic.
 * @param {string} lower
 * @returns {object}
 */
function extractSignals(lower) {
  return {
    create: anyVerb(lower, CREATE_KEYWORDS),
    modify: anyVerb(lower, MODIFY_KEYWORDS),
    delete: anyVerb(lower, DELETE_KEYWORDS),
    search: anyVerb(lower, SEARCH_KEYWORDS),
    automation: anyVerb(lower, AUTOMATION_KEYWORDS),
    asset: anyObject(lower, ASSET_KEYWORDS),
    actor: anyObject(lower, ACTOR_KEYWORDS),
    journal: anyObject(lower, JOURNAL_KEYWORDS),
    scene: anyObject(lower, SCENE_KEYWORDS),
    item: anyObject(lower, ITEM_KEYWORDS),
  };
}

/**
 * Pick the most specific create-intent for a signal bundle. Order matters:
 * actor wins over item when both fire (Grunk-style "warrior with sword"
 * is primarily an actor request).
 * @param {object} signals
 * @returns {string}
 */
function classifyCreateIntent(signals) {
  if (signals.actor) return 'create_actor';
  if (signals.journal) return 'create_journal';
  if (signals.scene) return 'create_scene';
  if (signals.item) return 'create_item';
  return 'create_other';
}

/**
 * Find the latest user message in a conversation and classify it. Helper
 * for callers that have a messages array but want a single call to do
 * the lookup + classification.
 *
 * @param {Array<{role: string, content: string}>|undefined} messages
 * @returns {string} intent key
 */
export function classifyLatestUserMessage(messages) {
  if (!Array.isArray(messages)) return 'ambiguous';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') {
      return classifyIntent(m.content);
    }
  }
  return 'ambiguous';
}

/**
 * Word-boundary match for verb keywords. Phrasal needles use substring
 * (phrases don't collide on word boundaries the way single tokens do).
 * @param {string} haystack - lower-cased text
 * @param {string[]} needles - lower-cased keywords
 * @returns {boolean}
 */
function anyVerb(haystack, needles) {
  for (const needle of needles) {
    if (needle.includes(' ')) {
      if (haystack.includes(needle)) return true;
    } else {
      const re = new RegExp(`\\b${escapeRegex(needle)}\\b`);
      if (re.test(haystack)) return true;
    }
  }
  return false;
}

/**
 * Substring match for object keywords. Catches compound words ("longbow"
 * → "bow", "battlemap" → "map") that word-boundary matching would miss.
 * @param {string} haystack - lower-cased text
 * @param {string[]} needles - lower-cased keywords
 * @returns {boolean}
 */
function anyObject(haystack, needles) {
  for (const needle of needles) {
    if (haystack.includes(needle)) return true;
  }
  return false;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
