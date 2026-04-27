/* eslint-disable max-lines */
/**
 * Schema Index Service - Pre-compiles per-template document schemas + shared
 * top-level guidance content for injection into the system prompt under
 * small-model mode.
 *
 * Storage: IndexedDB, keyed by `${systemId}@${systemVersion}|${moduleHash}`
 * Build: Walks CONFIG document classes via DocumentAPI.getDocumentSchema and
 * emits deterministic markdown describing each (documentType, subtype) pair.
 *
 * Sync strategy:
 * - Cache-key based (not interval based): rebuild only when systemId,
 *   systemVersion, or the set of modules contributing document types changes.
 * - Initial build runs lazily: only when smallModelMode is enabled.
 *   Disabled smallModelMode = zero work on world load.
 */

import { createLogger } from '../utils/logger.js';
import { emitIndexStatus } from './hook-manager.js';
import { DocumentAPI } from './document-api.js';

const DB_NAME = 'simulacrum-schema-index';
const DB_VERSION = 1;
const MODULE_ID = 'simulacrum';

// Field types to skip when emitting markdown (they bloat output without helping
// small models). The names match DocumentAPI.#getFieldTypeName output, which
// converts e.g. TypeDataField -> 'type_data'.
const SKIP_FIELD_TYPES = new Set([
  'type_data',
  'embedded_collection',
  'embedded_collection_delta',
  'embedded_data',
  'embedded_document',
  'document_flags',
  'document_stats',
  'document_ownership',
  'document_id',
  'foreign_document',
]);

// Top-level field names to skip in markdown emission (Foundry housekeeping).
const SKIP_FIELD_NAMES = new Set(['_stats', 'flags', '_id', 'ownership', 'sort']);

// Document types that aren't user-creatable in the sense small models care
// about. Excluding them avoids the model trying to e.g. `create_document` a
// User account or a runtime FogExploration record. PR4's intent-driven
// filtering would generalize this.
const NON_CREATABLE_DOCUMENT_TYPES = new Set([
  'User',
  'Setting',
  'FogExploration',
  'Combat',
  'ChatMessage',
  'Folder',
]);

// Field names where DocumentAPI's fuzzy CONFIG-namespace choice lookup is
// known reliable across systems. For these fields we surface the choices
// in Common Fields display (helps the model see valid values) but still
// keep them out of skeleton defaults (model shouldn't blindly copy the
// first choice as the answer). Add field names here only after manual
// verification on the target system.
const TRUSTED_CONFIG_CHOICE_FIELDS = new Set([
  'school', // dnd5e spell schools (abj, con, div, ...)
  'rarity', // item rarity (common, uncommon, rare, ...)
  'size', // creature/object size (tiny, sm, med, lg, ...)
  'alignment', // alignment (lg, ng, cg, ...)
]);

// DataModel-class field types that aren't primitives — emitted by
// DocumentAPI as the class name (e.g. 'activities', 'advancement_collection').
// In Common Fields we mark these as complex so the model knows not to
// invent a structure.
const COMPLEX_FIELD_TYPES = new Set([
  'activities',
  'activity',
  'activation',
  'advancement_collection',
  'actor_deltas',
  'creature_type',
  'duration',
  'formula',
  'identifier',
  'item_type',
  'movement',
  'senses',
  'source',
  'spellcasting',
]);

// Schema-discovery tool names that become redundant + harmful when the
// compiled prompt is injected. Stripping them under smallModelMode avoids
// the chunked-read death-loop trap that triggered when small models tried
// to walk paginated schema dumps.
const SCHEMA_DISCOVERY_TOOL_NAMES = new Set(['inspect_document_schema', 'list_document_schemas']);

// Cap on common fields shown in the worked example / common-fields list.
const COMMON_FIELDS_LIMIT = 10;
// Maximum recursion steps when walking nested SchemaFields. The first call
// processes `system.*`, so a value of 3 means we can reach
// `system.attributes.hp.value` (3 hops) but stop at any deeper chain. Tuned
// for dnd5e/pf2e where required-leaf chains are typically 2-3 deep.
const MAX_RECURSION_STEPS = 3;

// Field type → descriptive label for the Common Fields list. Bare type
// names like "formula" or "html" don't tell a small model what shape to
// emit; descriptive labels do. Falls back to the type name for anything
// not in the map. Field-type keys here are the lower_snake_case names
// produced by DocumentAPI.#getFieldTypeName (e.g. FormulaField → 'formula').
const FIELD_TYPE_DESCRIPTIONS = {
  string: 'string',
  number: 'number',
  numeric: 'number',
  boolean: 'boolean',
  integer: 'integer',
  formula: "string (dice formula, e.g. '1d8+3')",
  html: 'string (HTML content)',
  file_path: 'string (file path)',
  color: 'string (hex color)',
  array: 'array',
  set: 'array (unique values)',
  object: 'object',
  schema: 'object',
  mapping: 'object (key-value map)',
  identifier: 'string (slug identifier)',
  document_id: 'string (document id)',
  foreign_document: 'string (UUID reference to another document)',
  source: 'object (source attribution)',
};

// Leaf field names that carry "common gameplay value" semantics in Foundry
// data models — even when not strictly required, they're the fields a user
// or LLM is most likely to want to set. Surfaced in the worked-JSON skeleton
// so models bias toward the right field instead of an obscure required leaf
// (e.g. `hp.formula` is required but `hp.value`/`hp.max` are what the model
// should actually populate to set a creature's HP).
const COMMON_LEAF_FIELDS = new Set(['value', 'max', 'min']);

// Per-intent profiles for tool/template scoping. Mirrors the proxy's
// INTENT_PROFILES dict. `tools` is a whitelist of tool names; '*' means
// no whitelist (only the always-strip rules apply). `docTypes` is a
// whitelist of top-level documentType prefixes; '*' means include all.
// `ambiguous` is the fallback when classification cannot determine intent.
const INTENT_PROFILES = {
  create_actor: {
    tools: new Set([
      'create_document',
      'update_document',
      'search_documents',
      'search_assets',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(['Actor', 'Item']),
  },
  create_item: {
    tools: new Set(['create_document', 'search_documents', 'manage_task', 'end_loop']),
    docTypes: new Set(['Item']),
  },
  create_journal: {
    tools: new Set([
      'create_document',
      'search_documents',
      'search_assets',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(['JournalEntry', 'JournalEntryPage']),
  },
  create_scene: {
    tools: new Set([
      'create_document',
      'search_documents',
      'search_assets',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(['Scene']),
  },
  create_other: {
    tools: new Set(['create_document', 'search_documents', 'manage_task', 'end_loop']),
    docTypes: '*',
  },
  modify: {
    tools: new Set([
      'read_document',
      'update_document',
      'search_documents',
      'manage_task',
      'end_loop',
    ]),
    docTypes: '*',
  },
  delete: {
    tools: new Set([
      'read_document',
      'delete_document',
      'search_documents',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(),
  },
  search_or_list: {
    tools: new Set([
      'search_documents',
      'list_documents',
      'read_document',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(),
  },
  execute_automation: {
    tools: new Set([
      'execute_macro',
      'run_javascript',
      'search_documents',
      'manage_task',
      'end_loop',
    ]),
    docTypes: new Set(),
  },
  asset_management: {
    tools: new Set(['search_assets', 'browse_folders', 'manage_task', 'end_loop']),
    docTypes: new Set(),
  },
  ambiguous: {
    tools: '*',
    docTypes: '*',
  },
};

/**
 * Deterministic 32-bit FNV-1a hash. Used for the module-set component of the
 * cache key. Not cryptographic; we only need stable equality for "did the
 * inputs change?" comparisons, and FNV-1a works synchronously in both browser
 * and Node (unlike crypto.subtle.digest which is async-only in browsers).
 *
 * @param {string} str
 * @returns {string} 8-char lowercase hex
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Type → example-value lookup. Drives the worked-JSON skeleton.
const TYPE_EXAMPLE = {
  string: '"<string>"',
  html: '"<string>"',
  file_path: '"<string>"',
  number: '0',
  numeric: '0',
  boolean: 'false',
  array: '[]',
  set: '[]',
  object: '{}',
  schema: '{}',
};

/**
 * Format a JSON value compactly for inclusion in worked examples. Only
 * trusts choice-derived defaults when the choices came from the field's
 * own declaration — fuzzy CONFIG-namespace lookups in DocumentAPI produce
 * false matches (e.g. `units: "turn"`, `type: "required"`) that would
 * mislead the model. Prefers `initial` value when present (DataModel
 * convention: `initial` is the documented default and a safe placeholder).
 * @param {object} fieldInfo
 * @returns {string}
 */
function formatExampleValue(fieldInfo) {
  if (fieldInfo && Object.prototype.hasOwnProperty.call(fieldInfo, 'initial')) {
    const init = fieldInfo.initial;
    if (init === null || ['string', 'number', 'boolean'].includes(typeof init)) {
      return JSON.stringify(init);
    }
  }
  const trusted =
    Array.isArray(fieldInfo?.choices) &&
    fieldInfo.choices.length > 0 &&
    fieldInfo.choicesSource !== 'CONFIG';
  if (trusted) {
    return JSON.stringify(fieldInfo.choices[0]);
  }
  return TYPE_EXAMPLE[fieldInfo?.type] ?? '"<value>"';
}

/**
 * Map a DocumentAPI field-type name to a descriptive label for display.
 * @param {string|undefined} typeName
 * @returns {string}
 */
function describeFieldType(typeName) {
  if (!typeName) return 'unknown';
  return FIELD_TYPE_DESCRIPTIONS[typeName] ?? typeName;
}

class SchemaIndexService {
  constructor() {
    this.logger = createLogger('SchemaIndexService');
    this.db = null;
    this.isIndexing = false;
    this.initialized = false;
    this._initialIndexPromise = null;
    this._initialIndexResolve = null;
    this._initialIndexComplete = false;
    this._templateCount = 0;
    this._builtAt = null;
    this._cacheKey = null;
  }

  /**
   * Initialize the service - open DB, check cache, build if stale (when
   * smallModelMode is enabled). Safe to call multiple times.
   */
  async initialize() {
    if (this.initialized) return;

    this.logger.info('Initializing schema index service...');

    this._initialIndexPromise = new Promise(resolve => {
      this._initialIndexResolve = resolve;
    });

    try {
      this.db = await this._openDB();
      this.logger.info('IndexedDB opened successfully');
    } catch (err) {
      this.logger.error('Failed to open IndexedDB, falling back to memory-only mode', err);
      this.db = null;
    }

    const liveCacheKey = this._computeCacheKey();
    const hasFreshCache = await this._checkExistingIndex(liveCacheKey);

    if (hasFreshCache) {
      this.logger.info(
        `Using cached index: ${this._templateCount} templates, key=${this._cacheKey}`
      );
      this._initialIndexComplete = true;
      this._initialIndexResolve();
    } else {
      const smallModelMode = this._readSmallModelMode();
      if (smallModelMode) {
        this.logger.info('No fresh cache and smallModelMode enabled; building index now');
        // Don't await — run in background like AssetIndexService.
        // rebuildIndex() resolves _initialIndexPromise on completion.
        this.rebuildIndex();
      } else {
        // Resolve the promise so consumers awaiting readiness don't block.
        // _initialIndexComplete stays false; getAvailability() returns
        // {available: false} until smallModelMode is enabled and the index
        // builds.
        this.logger.info('No fresh cache; smallModelMode disabled, deferring build until enabled');
        this._initialIndexResolve();
      }
    }

    this.initialized = true;
    this.logger.info('Schema index service initialized');
  }

  /**
   * Read smallModelMode setting safely.
   * @returns {boolean}
   */
  _readSmallModelMode() {
    try {
      return Boolean(game?.settings?.get(MODULE_ID, 'smallModelMode'));
    } catch (_e) {
      return false;
    }
  }

  /**
   * Compute the live cache key from current system + active modules.
   * @returns {string}
   */
  _computeCacheKey() {
    const systemId = game?.system?.id ?? 'unknown';
    const systemVersion = game?.system?.version ?? '0.0.0';
    const moduleHash = this._moduleContributorsHash();
    return `${systemId}@${systemVersion}|${moduleHash}`;
  }

  /**
   * Hash the set of active modules that may contribute document types or
   * dataModels. Only modules whose presence could change schema output are
   * included so unrelated module toggles don't trigger rebuilds.
   * @returns {string}
   */
  _moduleContributorsHash() {
    if (!game?.modules) return fnv1a('');

    const contributors = [];
    for (const [id, mod] of game.modules.entries()) {
      if (!mod?.active) continue;
      // Heuristic: if the module registers Actors.types / Items.types / etc.
      // through its module.json, we want to track its version. We approximate
      // by including any active module — false positives just trigger occasional
      // unnecessary rebuilds, which is acceptable.
      contributors.push(`${id}@${mod.version ?? '0'}`);
    }
    contributors.sort();
    return fnv1a(contributors.join('|'));
  }

  /**
   * Open IndexedDB database with the three stores.
   * @returns {Promise<IDBDatabase>}
   */
  _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('templates')) {
          db.createObjectStore('templates', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('shared')) {
          db.createObjectStore('shared', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Check if the cached index matches the live cache key.
   * @param {string} liveCacheKey
   * @returns {Promise<boolean>}
   */
  async _checkExistingIndex(liveCacheKey) {
    if (!this.db) return false;

    try {
      const storedKey = await this._readMeta('cacheKey');
      if (!storedKey || storedKey !== liveCacheKey) return false;

      const storedBuiltAt = await this._readMeta('builtAt');
      const storedCount = await this._readMeta('templateCount');

      this._cacheKey = storedKey;
      this._builtAt = storedBuiltAt ? new Date(storedBuiltAt) : null;
      this._templateCount = Number(storedCount) || 0;
      return this._templateCount > 0;
    } catch (err) {
      this.logger.debug(`Failed to check existing index: ${err.message}`);
      return false;
    }
  }

  /**
   * Read a single value from the meta store.
   * @param {string} key
   * @returns {Promise<unknown>}
   */
  _readMeta(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Rebuild the entire index from current CONFIG state. Skips when cache is
   * already fresh unless `force` is true.
   * @param {{force?: boolean}} [options]
   */
  async rebuildIndex({ force = false } = {}) {
    if (this.isIndexing) {
      this.logger.debug('Index rebuild already in progress, skipping');
      return;
    }
    if (this._isCacheFreshSkippable(force)) {
      this.logger.debug('Cache is fresh, skipping rebuild');
      return;
    }

    this.isIndexing = true;
    const startTime = Date.now();
    const isInitialIndex = !this._initialIndexComplete;
    this.logger.info(`Starting schema index rebuild${force ? ' (forced)' : ''}...`);
    if (isInitialIndex) emitIndexStatus('start');

    await this._clearStoresSafely();

    const liveCacheKey = this._computeCacheKey();
    const generatedAt = Date.now();
    const documentTypes = DocumentAPI.getAllDocumentTypes();

    const { templates, shared } = this._buildAllContent(documentTypes, generatedAt);

    await this._persistIndex(templates, shared, liveCacheKey, generatedAt);

    this._templateCount = templates.length;
    this._builtAt = new Date(generatedAt);
    this._cacheKey = liveCacheKey;
    this.isIndexing = false;

    if (!this._initialIndexComplete) {
      this._initialIndexComplete = true;
      if (this._initialIndexResolve) {
        this._initialIndexResolve();
        this._initialIndexResolve = null;
      }
      emitIndexStatus('complete', { templateCount: this._templateCount });
    }

    const elapsed = Date.now() - startTime;
    this.logger.info(
      `Schema index rebuild complete: ${templates.length} templates, ${shared.length} shared blocks in ${elapsed}ms`
    );
  }

  /**
   * Whether the cached index is current and the rebuild can be skipped.
   * @param {boolean} force
   * @returns {boolean}
   */
  _isCacheFreshSkippable(force) {
    if (force) return false;
    if (!this._initialIndexComplete) return false;
    if (this._templateCount === 0) return false;
    return this._cacheKey === this._computeCacheKey();
  }

  /**
   * Clear stores; tolerate IndexedDB errors (memory-only fallback).
   */
  async _clearStoresSafely() {
    if (!this.db) return;
    try {
      await this._clearStores();
    } catch (err) {
      this.logger.error('Failed to clear IndexedDB stores', err);
    }
  }

  /**
   * Walk document types and emit per-template + shared content arrays.
   * @param {string[]} documentTypes
   * @param {number} generatedAt
   * @returns {{templates: object[], shared: object[]}}
   */
  _buildAllContent(documentTypes, generatedAt) {
    const creatableTypes = documentTypes.filter(t => !NON_CREATABLE_DOCUMENT_TYPES.has(t));

    const templates = [];
    const shared = [];

    for (const documentType of creatableTypes) {
      try {
        this._collectTemplatesForType(documentType, generatedAt, templates);
      } catch (err) {
        this.logger.warn(`Failed to build entry for ${documentType}: ${err.message}`);
      }
    }

    // One shared "Standard top-level fields" block, plus per-DocType
    // embedded-children sections only when present.
    shared.push({
      key: 'preamble',
      content: this._buildPreamble(creatableTypes),
      generatedAt,
    });
    shared.push({ key: 'uuid_format', content: this._buildUuidFormat(), generatedAt });
    shared.push({
      key: 'top_level_fields',
      content: this._buildTopLevelFieldsSection(),
      generatedAt,
    });

    for (const documentType of creatableTypes) {
      const embeddedContent = this._buildEmbeddedChildrenSection(documentType);
      if (embeddedContent) {
        shared.push({
          key: `doc_fields::${documentType}`,
          content: embeddedContent,
          generatedAt,
        });
      }
    }

    return { templates, shared };
  }

  /**
   * Push template entries for a document type. Skips empty entries (pure
   * boilerplate with no system data) and consolidates them into a single
   * `(any subtype)` entry that lists valid subtype names without repeating
   * the call shape for each.
   *
   * @param {string} documentType
   * @param {number} generatedAt
   * @param {object[]} templates - mutated in place
   */
  _collectTemplatesForType(documentType, generatedAt, templates) {
    const subtypes = (game?.documentTypes?.[documentType] ?? []).filter(s => s !== 'base');

    if (subtypes.length === 0) {
      this._collectBaseOnly(documentType, generatedAt, templates);
      return;
    }

    const { meaningful, empty } = this._partitionSubtypes(documentType, subtypes);

    for (const { subtype, entry } of meaningful) {
      templates.push({
        id: `${documentType}::${subtype}`,
        documentType,
        subtype,
        content: entry,
        generatedAt,
      });
    }

    if (empty.length > 0) {
      const consolidatedSubtypes = meaningful.length > 0 ? empty : subtypes;
      templates.push({
        id: `${documentType}::_any`,
        documentType,
        subtype: null,
        content: this._buildConsolidatedSubtypeEntry(documentType, consolidatedSubtypes),
        generatedAt,
      });
    }
  }

  /**
   * Emit the base entry for a type that has no subtypes, but only when it
   * has system content worth showing.
   */
  _collectBaseOnly(documentType, generatedAt, templates) {
    const baseEntry = this._buildTemplateEntry(documentType, null);
    if (!baseEntry || !this._entryHasSystemContent(baseEntry)) return;
    templates.push({
      id: `${documentType}::_base`,
      documentType,
      subtype: null,
      content: baseEntry,
      generatedAt,
    });
  }

  /**
   * Build template entries for each subtype and partition into "meaningful"
   * (has system content) vs "empty" (pure boilerplate).
   * @param {string} documentType
   * @param {string[]} subtypes
   * @returns {{meaningful: Array<{subtype:string,entry:string}>, empty: string[]}}
   */
  _partitionSubtypes(documentType, subtypes) {
    const meaningful = [];
    const empty = [];
    for (const subtype of subtypes) {
      const entry = this._buildTemplateEntry(documentType, subtype);
      if (!entry) continue;
      if (this._entryHasSystemContent(entry)) {
        meaningful.push({ subtype, entry });
      } else {
        empty.push(subtype);
      }
    }
    return { meaningful, empty };
  }

  /**
   * Build a single entry for a parent document type whose subtypes have no
   * system-specific fields. Lists the valid subtype names and shows the
   * call shape once.
   * @param {string} documentType
   * @param {string[]} subtypes
   * @returns {string}
   */
  _buildConsolidatedSubtypeEntry(documentType, subtypes) {
    const subtypeUnion = subtypes.map(s => JSON.stringify(s)).join(' | ');
    const skeleton = {
      name: '"<string>"',
      type: `<${subtypes.join('|')}>`,
    };
    const heading = `## ${documentType} (any of: ${subtypes.join(', ')})`;
    const description = `${documentType} subtypes \`${subtypes.join('`, `')}\` have no system-specific fields. Pick one for \`data.type\`.`;
    const dataBlock = this._renderJSONLike(skeleton, 2);
    const wrapper = `{\n  "documentType": ${JSON.stringify(documentType)},\n  "data": ${dataBlock}\n}`;
    const json = '```json\n' + wrapper + '\n```';

    return [
      heading,
      description,
      '',
      `Valid \`data.type\` values: ${subtypeUnion}`,
      '',
      '### Minimum viable create_document call',
      json,
    ].join('\n');
  }

  /**
   * Whether a generated template entry contains any system data — i.e.
   * something more than the bare minimum-viable JSON skeleton with just
   * name and (optionally) img/type. Used to drop pure-boilerplate base
   * entries.
   * @param {string} entry
   * @returns {boolean}
   */
  _entryHasSystemContent(entry) {
    return entry.includes('"system"') || entry.includes('### Common system.* fields');
  }

  /**
   * Persist templates + shared + meta to IndexedDB. Tolerates DB errors.
   * @param {object[]} templates
   * @param {object[]} shared
   * @param {string} liveCacheKey
   * @param {number} generatedAt
   */
  async _persistIndex(templates, shared, liveCacheKey, generatedAt) {
    if (!this.db) return;
    try {
      await this._writeBatch(templates, shared);
      await this._writeMeta({
        cacheKey: liveCacheKey,
        builtAt: generatedAt,
        templateCount: templates.length,
      });
    } catch (err) {
      this.logger.error('Failed to persist index to IndexedDB', err);
    }
  }

  /**
   * Clear all stores (used at start of rebuild).
   */
  async _clearStores() {
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['templates', 'shared', 'meta'], 'readwrite');
      tx.objectStore('templates').clear();
      tx.objectStore('shared').clear();
      tx.objectStore('meta').delete('cacheKey');
      tx.objectStore('meta').delete('builtAt');
      tx.objectStore('meta').delete('templateCount');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Write batches to templates + shared stores in a single transaction.
   * @param {Array<object>} templates
   * @param {Array<object>} shared
   */
  async _writeBatch(templates, shared) {
    if (!this.db) return;
    if (templates.length === 0 && shared.length === 0) return;

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(['templates', 'shared'], 'readwrite');
      const tStore = tx.objectStore('templates');
      const sStore = tx.objectStore('shared');
      for (const t of templates) tStore.put(t);
      for (const s of shared) sStore.put(s);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Write meta entries.
   * @param {Record<string, unknown>} entries
   */
  async _writeMeta(entries) {
    if (!this.db) return;
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      for (const [key, value] of Object.entries(entries)) {
        store.put({ key, value });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Build the markdown entry for one (documentType, subtype) pair. Returns
   * null when the schema can't be retrieved.
   * @param {string} documentType
   * @param {string|null} subtype
   * @returns {string|null}
   */
  _buildTemplateEntry(documentType, subtype) {
    const schema = DocumentAPI.getDocumentSchema(documentType, subtype || undefined);
    if (!schema) return null;
    return this._buildTemplateEntryFromSchema(documentType, subtype, schema);
  }

  /**
   * Pure markdown generation from a pre-fetched schema. Separated from
   * _buildTemplateEntry so unit tests can inject fixture schemas without
   * needing the full Foundry CONFIG environment.
   * @param {string} documentType
   * @param {string|null} subtype
   * @param {object} schema - Output of DocumentAPI.getDocumentSchema
   * @returns {string}
   */
  _buildTemplateEntryFromSchema(documentType, subtype, schema) {
    const heading = subtype ? `## ${documentType} (${subtype})` : `## ${documentType} (base)`;
    const description = this._describeTemplate(documentType, subtype);
    const minimalJson = this._buildMinimalJSON(documentType, subtype, schema);
    const common = this._formatCommonFields(schema);
    const advancedFields = this._formatAdvancedFields(schema, common.names);

    const sections = [
      heading,
      description,
      '',
      '### Minimum viable create_document call',
      minimalJson,
    ];

    if (common.markdown) {
      sections.push('', '### Common system.* fields', common.markdown);
    }
    if (advancedFields) {
      sections.push(
        '',
        '### Advanced fields (use inspect_document_schema for details)',
        advancedFields
      );
    }

    return sections.join('\n');
  }

  /**
   * Produce a one-sentence description for a template. Pulls from CONFIG
   * typeLabels / localization when available; falls back to a generic phrase.
   * @param {string} documentType
   * @param {string|null} subtype
   * @returns {string}
   */
  _describeTemplate(documentType, subtype) {
    if (!subtype) {
      return `Base schema for ${documentType} documents (subtype not yet selected).`;
    }
    try {
      const labelKey = CONFIG?.[documentType]?.typeLabels?.[subtype];
      if (labelKey && typeof game?.i18n?.localize === 'function') {
        const localized = game.i18n.localize(labelKey);
        if (localized && localized !== labelKey) {
          return `${localized} (${documentType} subtype "${subtype}").`;
        }
      }
    } catch (_e) {
      // fall through to generic
    }
    return `${documentType} document with subtype "${subtype}".`;
  }

  /**
   * Build the worked-example JSON block for create_document. Uses required
   * leaves only, depth-capped at MAX_RECURSION_STEPS. Includes top-level
   * placeholders for embedded-children arrays (e.g. `data.items` on Actor,
   * `data.pages` on JournalEntry) so the model sees the right nesting
   * position when copying the template — without these, small models
   * faithfully fill out `data.system.*` and then nest items under
   * `data.system.items` because the heavy section pulls everything in.
   *
   * @param {string} documentType
   * @param {string|null} subtype
   * @param {object} schema
   * @returns {string} fenced JSON block
   */
  _buildMinimalJSON(documentType, subtype, schema) {
    const data = {
      name: '"<string>"',
    };
    if (subtype) {
      data.type = JSON.stringify(subtype);
    }
    // img is conventional for visual document types; include when present
    if (schema.fieldDetails?.img) {
      data.img = '"<path or omit>"';
    }

    // Embedded children FIRST, system block AFTER. The reverse order
    // (system first, items at the end) made small models pattern-match
    // items into the heavy system content because that's where their
    // attention was when constructing the call. Putting items high in
    // the skeleton — visually adjacent to `name` and `type` — makes the
    // top-level placement structurally obvious. Empty `[]` was tried
    // and read as "unused slot"; the populated stub gives the model a
    // fill-in-the-blank target.
    for (const stub of this._embeddedFieldStubs(documentType)) {
      data[stub.fieldName] = stub.literal;
    }

    const systemBlock = this._buildSystemSkeleton(schema.systemFieldDetails, 0);
    if (systemBlock) {
      data.system = systemBlock;
    }

    const dataBlock = this._renderJSONLike(data, 2);
    const wrapper = `{\n  "documentType": ${JSON.stringify(documentType)},\n  "data": ${dataBlock}\n}`;
    return '```json\n' + wrapper + '\n```';
  }

  /**
   * Embedded-children stubs for the per-template JSON skeleton. Each stub
   * is a `{ fieldName, literal }` pair where `literal` is a pre-rendered
   * string emitted verbatim by `_renderJSONLike` (it bypasses the recursive
   * object-render path because we want to control multi-line indentation).
   *
   * Stub shape: `[ { "name": "<child name>", "type": "<subtype>" } ]` for
   * children whose document type has subtypes (Item, JournalEntryPage),
   * `[ { "name": "<child name>" } ]` otherwise (ActiveEffect). The `type`
   * hint in the stub is what stops the model from omitting `type` on
   * embedded items — its absence is what made dnd5e Item creation fail.
   *
   * @param {string} documentType
   * @returns {Array<{fieldName: string, literal: string}>}
   */
  _embeddedFieldStubs(documentType) {
    const hierarchy = CONFIG?.[documentType]?.documentClass?.hierarchy;
    if (!hierarchy) return [];

    const stubs = [];
    for (const [fieldName, fieldDef] of Object.entries(hierarchy)) {
      const childType = this._extractEmbeddedChildType(fieldDef) ?? fieldName;
      const childLower = childType.toLowerCase();
      const childSubtypes = (game?.documentTypes?.[childType] ?? []).filter(s => s !== 'base');
      const stubObject =
        childSubtypes.length > 0
          ? `{ "name": "<${childLower} name>", "type": "<${childLower} subtype>" }`
          : `{ "name": "<${childLower} name>" }`;
      stubs.push({
        fieldName,
        literal: `[\n      ${stubObject}\n    ]`,
      });
    }
    return stubs;
  }

  /**
   * Recursively assemble a skeleton object containing required leaves (and
   * "common gameplay" leaves under required parents), up to
   * MAX_RECURSION_STEPS levels deep. Returns null when nothing qualifies at
   * the current level (caller can omit the block entirely).
   *
   * The `parentRequired` flag lets us surface non-required leaves named
   * `value`/`max`/`min` whenever they sit under a required SchemaField —
   * the canonical Foundry pattern (e.g. `attributes.hp.value/max` are both
   * non-required in dnd5e but are the actual mechanical fields users want
   * to set; only `formula` is strictly required). Without this surface,
   * small models faithfully populate only `formula` and leave HP at 0.
   *
   * @param {object|undefined} fieldDetails
   * @param {number} depth
   * @param {boolean} parentRequired - whether the current level sits inside
   *   a required SchemaField (controls the common-leaf surface)
   * @returns {Record<string, string|object>|null}
   */
  _buildSystemSkeleton(fieldDetails, depth, parentRequired = false) {
    if (!fieldDetails || typeof fieldDetails !== 'object') return null;
    if (depth >= MAX_RECURSION_STEPS) return null;

    const out = {};
    for (const [name, info] of Object.entries(fieldDetails)) {
      if (!this._fieldQualifiesForSkeleton(name, info, parentRequired)) continue;
      const value = this._renderSkeletonField(info, depth);
      if (value !== undefined) out[name] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * Whether a field should be emitted into the JSON skeleton: must not be
   * skipped, must be either required or qualify as a common-leaf under a
   * required parent.
   * @param {string} name
   * @param {object} info
   * @param {boolean} parentRequired
   * @returns {boolean}
   */
  _fieldQualifiesForSkeleton(name, info, parentRequired) {
    if (this._shouldSkipSchemaField(name, info)) return false;
    if (info.required) return true;
    return parentRequired && COMMON_LEAF_FIELDS.has(name) && !info.nested && !info.isCollection;
  }

  /**
   * Whether a field should be omitted from skeleton/common/advanced lists.
   * @param {string} name
   * @param {object} info
   * @returns {boolean}
   */
  _shouldSkipSchemaField(name, info) {
    if (SKIP_FIELD_NAMES.has(name)) return true;
    if (!info || typeof info !== 'object') return true;
    if (SKIP_FIELD_TYPES.has(info.type)) return true;
    return false;
  }

  /**
   * Render a single field as a skeleton value: recurse into nested SchemaFields,
   * or emit a primitive example. Returns undefined to signal "skip this field."
   * Recursion passes `parentRequired=true` because we only call this for
   * fields that themselves qualified for emission (required, or common-leaf
   * under a required parent).
   *
   * @param {object} info
   * @param {number} depth
   * @returns {string|object|undefined}
   */
  _renderSkeletonField(info, depth) {
    if (info.nested && typeof info.nested === 'object') {
      const nested = this._buildSystemSkeleton(info.nested, depth + 1, true);
      if (nested && Object.keys(nested).length > 0) return nested;
      return undefined;
    }
    if (info.isCollection || info.isMapping) return undefined;
    return formatExampleValue(info);
  }

  /**
   * Render a JS object as JSON-like text where string values that are already
   * formatted (start with '"') are emitted verbatim and other primitives use
   * JSON.stringify. Indented to match the surrounding block.
   * @param {object} obj
   * @param {number} indent
   * @returns {string}
   */
  _renderJSONLike(obj, indent) {
    const pad = ' '.repeat(indent);
    const childPad = ' '.repeat(indent + 2);
    const entries = Object.entries(obj).map(([k, v]) => {
      let rendered;
      if (typeof v === 'string') {
        rendered = v;
      } else if (v && typeof v === 'object') {
        rendered = this._renderJSONLike(v, indent + 2);
      } else {
        rendered = JSON.stringify(v);
      }
      return `${childPad}${JSON.stringify(k)}: ${rendered}`;
    });
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }

  /**
   * Format the "Common system.* fields" markdown list. Picks the top
   * COMMON_FIELDS_LIMIT fields, required first, then non-required ranked by
   * presence of choices / hint.
   * @param {object} schema
   * @returns {{markdown: string|null, names: Set<string>}}
   */
  _formatCommonFields(schema) {
    const details = schema.systemFieldDetails;
    if (!details || typeof details !== 'object' || details.$ref) {
      return { markdown: null, names: new Set() };
    }

    const candidates = [];
    for (const [name, info] of Object.entries(details)) {
      if (this._shouldSkipSchemaField(name, info)) continue;
      candidates.push({ name, info });
    }

    candidates.sort((a, b) => {
      const aReq = a.info.required ? 1 : 0;
      const bReq = b.info.required ? 1 : 0;
      if (aReq !== bReq) return bReq - aReq;
      const aHas = this._hasDisplayableChoices(a.name, a.info) ? 1 : 0;
      const bHas = this._hasDisplayableChoices(b.name, b.info) ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      return a.name.localeCompare(b.name);
    });

    const top = candidates.slice(0, COMMON_FIELDS_LIMIT);
    if (top.length === 0) return { markdown: null, names: new Set() };

    const names = new Set(top.map(({ name }) => name));
    const markdown = top.map(({ name, info }) => this._formatFieldLine(name, info)).join('\n');
    return { markdown, names };
  }

  /**
   * Whether `info.choices` is suitable for display in the Common Fields
   * list. Trusts choices declared on the field directly; for fuzzy
   * CONFIG-derived choices, only trusts whitelisted field names where the
   * fuzzy match is known reliable. The skeleton (formatExampleValue)
   * applies a stricter rule — never trusts CONFIG-fuzzy as a default value
   * even when whitelisted, because models tend to copy defaults verbatim.
   * @param {string} name
   * @param {object} info
   * @returns {boolean}
   */
  _hasDisplayableChoices(name, info) {
    if (!Array.isArray(info?.choices) || info.choices.length === 0) return false;
    if (info.choicesSource !== 'CONFIG') return true;
    return TRUSTED_CONFIG_CHOICE_FIELDS.has(name);
  }

  /**
   * Format a single field as a markdown bullet line. Annotates DataModel-
   * class types as (complex) so the model knows it can't construct them
   * inline. Shows choices when displayable (trusted source or whitelisted).
   * Surfaces `initial` value when the field declares one — matches the
   * proxy's "default 'X'" annotation that helps models pick safe values.
   */
  _formatFieldLine(name, info) {
    const typeName = info.type || 'unknown';
    const isComplex = COMPLEX_FIELD_TYPES.has(typeName);
    const baseLabel = describeFieldType(typeName);
    const typeLabel = isComplex ? `${baseLabel}; complex, use inspect_document_schema` : baseLabel;
    const parts = [`- \`system.${name}\` (${typeLabel})`];
    if (info.required) parts.push('**required**');
    if (info && Object.prototype.hasOwnProperty.call(info, 'initial')) {
      const init = info.initial;
      if (init === null || ['string', 'number', 'boolean'].includes(typeof init)) {
        parts.push(`default ${JSON.stringify(init)}`);
      }
    }
    if (this._hasDisplayableChoices(name, info)) {
      const sample = info.choices
        .slice(0, 5)
        .map(c => `\`${c}\``)
        .join(', ');
      parts.push(`choices: ${sample}${info.choices.length > 5 ? ', ...' : ''}`);
    }
    return parts.join(' — ');
  }

  /**
   * Format the "Advanced fields" list — strictly fields NOT already shown
   * in Common Fields. Terse names only.
   * @param {object} schema
   * @param {Set<string>} commonNames - field names already emitted in Common
   * @returns {string|null}
   */
  _formatAdvancedFields(schema, commonNames) {
    const details = schema.systemFieldDetails;
    if (!details || typeof details !== 'object' || details.$ref) return null;

    const remainder = Object.keys(details)
      .filter(name => !this._shouldSkipSchemaField(name, details[name]))
      .filter(name => !commonNames.has(name))
      .sort();

    if (remainder.length === 0) return null;

    return remainder.map(n => `\`system.${n}\``).join(', ');
  }

  /**
   * Build the preamble shared content. Anchors the model on the two-layer
   * (top-level vs system) document structure with a worked example,
   * because small models given only a structural skeleton tend to flatten
   * `system.*` fields up under `data` (the failure mode that spawned this
   * section). Common-mistakes pedagogy is empirically load-bearing — the
   * proxy variant of this content was a measured contributor to the
   * 110/100 result.
   *
   * @param {string[]} documentTypes
   * @returns {string}
   */
  _buildPreamble(documentTypes) {
    const typesSummary = documentTypes.length > 0 ? documentTypes.join(', ') : '(none)';
    return [
      '## Document Schemas',
      '',
      'This section is the authoritative reference for creating documents in this world.',
      'When CREATING new documents, construct payloads directly from the entries below.',
      'Use `read_document` only on existing documents you intend to MODIFY or DELETE.',
      '',
      '### Document structure',
      '',
      'Every document has two layers of fields:',
      '- **Top-level document fields** — shared across all documents of a class (e.g. all Actors have `name`, `type`, `img`, `items`, `effects`, `folder`, `sort`, `ownership`, `flags`).',
      '- **System-specific fields** — specific to the subtype, nested under `data.system.*`.',
      '',
      '### Required for every `create_document` call',
      '',
      `- \`documentType\` — top-level document class (one of: ${typesSummary})`,
      '- `data.name` — human-readable name (string, REQUIRED)',
      '- `data.type` — subtype discriminator (REQUIRED for typed documents — e.g. `"npc"` for Actor, `"weapon"` for Item)',
      '- `data.system` — object containing subtype-specific fields (see template-specific schemas below)',
      '',
      '### Common mistakes to avoid',
      '',
      '- **Do NOT** put system fields at the top level of `data`. They go under `data.system.*`.',
      '- **Do NOT** omit `data.type` — Foundry will reject the document with `UNKNOWN_DOCUMENT_TYPE`.',
      '- **Do NOT** include fields like `attributes` or `traits` directly under `data` — those belong under `data.system`.',
      '- **Do NOT** create embedded documents (e.g. an Item belonging to an Actor) as standalone — embed them via the parent\'s top-level array (see per-document-type "Embedded children" sections).',
      '',
      this._buildPreambleWorkedExample(),
      '',
      'For document types not covered by per-template entries below, fall back to `inspect_document_schema(documentType, subtype)`.',
    ].join('\n');
  }

  /**
   * Worked-example block emitted inside the preamble. Extracted to keep
   * `_buildPreamble` under the per-function line cap. Shows the canonical
   * shape: `data.system.*` for system fields, `data.items[]` for embedded
   * children, and the value/max HP convention.
   * @returns {string}
   */
  _buildPreambleWorkedExample() {
    return [
      '### Worked example (Actor with embedded weapon)',
      '',
      '```json',
      '{',
      '  "documentType": "Actor",',
      '  "data": {',
      '    "name": "Goblin Warrior",',
      '    "type": "npc",',
      '    "system": {',
      '      "attributes": {',
      '        "hp": { "value": 15, "max": 15 },',
      '        "ac": { "value": 13 }',
      '      }',
      '    },',
      '    "items": [',
      '      { "name": "Rusty Shortsword", "type": "weapon" }',
      '    ]',
      '  }',
      '}',
      '```',
      '',
      'Note how `attributes` is nested under `data.system`, NOT directly under `data`. The `items` array is a TOP-LEVEL field on the Actor `data` object — embedded children (Items inside an Actor, Pages inside a JournalEntry) DO NOT go under `data.system`.',
    ].join('\n');
  }

  /**
   * Build the UUID format reference content, with live world ID and pack
   * list. Includes a DOCUMENT_NOT_FOUND troubleshooting note — small models
   * often default to world UUID format for compendium documents, then
   * fail their `read_document` call and stall.
   *
   * @returns {string}
   */
  _buildUuidFormat() {
    const worldId = game?.world?.id ?? '<world>';
    const packs = game?.packs ? Array.from(game.packs).map(p => p.collection) : [];
    const PACK_SAMPLE_LIMIT = 5;
    const sampled = packs.slice(0, PACK_SAMPLE_LIMIT);
    const truncatedNote =
      packs.length > PACK_SAMPLE_LIMIT
        ? `\n- ...and ${packs.length - PACK_SAMPLE_LIMIT} more (use \`list_documents\` to enumerate)`
        : '';
    const packsSample =
      sampled.length > 0 ? '- ' + sampled.join('\n- ') + truncatedNote : '- (none)';

    return [
      '## UUID Format Conventions',
      '',
      'Foundry uses `@UUID[...]` syntax for cross-document references. The format depends on where the document lives.',
      '',
      '### Format by location',
      '',
      '**World documents (in this world):**',
      '`@UUID[<DocType>.<id>]{Display Name}`',
      `Example: \`@UUID[Actor.BtDHCHehjqLjmMpV]{Grunk}\` (world id: ${worldId})`,
      '',
      '**Compendium documents (in a pack):**',
      '`@UUID[Compendium.<scope>.<pack>.<DocType>.<id>]{Display Name}`',
      'Example: `@UUID[Compendium.dnd5e.actors24.Actor.mmGoblinWarrior0]{Goblin Warrior}`',
      'The full prefix `Compendium.<scope>.<pack>` is REQUIRED for compendium references.',
      '',
      '**Embedded documents (Items inside an Actor, Pages inside a JournalEntry):**',
      '`@UUID[<ParentType>.<parentId>.<ChildType>.<childId>]{Display Name}`',
      'Example: `@UUID[Actor.BtDHCHehjqLjmMpV.Item.someWeaponId]{Shortsword}`',
      '',
      '### When `read_document` returns DOCUMENT_NOT_FOUND',
      '',
      'The most common cause is using world UUID format for a compendium document. Check your search results: if the result was returned from a compendium pack, you need the full `Compendium.<scope>.<pack>.` prefix when reading it.',
      '',
      'Available compendium pack scopes in this world:',
      packsSample,
    ].join('\n');
  }

  /**
   * One shared "## Standard top-level fields" section. The fields name/type
   * are universal; img/folder are listed conditionally per-DocType where
   * the per-template entries reference them.
   * @returns {string}
   */
  _buildTopLevelFieldsSection() {
    return [
      '## Standard top-level fields',
      '',
      'These fields apply to the `data` object of every `create_document` call.',
      'Per-template entries below show only the system-specific fields under `data.system`.',
      '',
      '- `name` (string, **required**) — display name',
      '- `type` (string, **required** when the document type has subtypes) — subtype identifier (see per-template entries)',
      '- `img` (file_path) — image path; use `search_assets` to find valid paths. Only on document types that support visuals (Actor, Item, Cards, Macro, RollTable, Scene).',
      '- `folder` (string|null) — folder ID for organization. Only on document types that appear in the sidebar.',
    ].join('\n');
  }

  /**
   * Per-DocType "Embedded children" section, emitted only when the document
   * class declares an embedded hierarchy. Walks `documentClass.hierarchy`
   * to derive the array field name + child document type, then emits a
   * worked-JSON example showing the parent-creation embedding pattern.
   * This is empirically load-bearing — small models given only structural
   * schemas tend to issue separate create_document calls for embedded
   * children, which Foundry rejects (e.g. `documentType="JournalEntryPage"`
   * with no parent fails because pages exist only as children of
   * JournalEntry).
   *
   * @param {string} documentType
   * @returns {string|null}
   */
  _buildEmbeddedChildrenSection(documentType) {
    const documentClass = CONFIG?.[documentType]?.documentClass;
    if (!documentClass) return null;

    const hierarchy = documentClass.hierarchy;
    if (!hierarchy || Object.keys(hierarchy).length === 0) return null;

    const fields = Object.entries(hierarchy)
      .map(([fieldName, fieldDef]) => ({
        fieldName,
        childType: this._extractEmbeddedChildType(fieldDef) ?? fieldName,
      }))
      .filter(f => f.fieldName && f.childType);

    if (fields.length === 0) return null;

    const lines = [`## ${documentType} — Embedded children`, ''];

    lines.push(`A \`${documentType}\` contains embedded child documents:`);
    for (const { fieldName, childType } of fields) {
      lines.push(`- \`data.${fieldName}\` — array of \`${childType}\` create-payloads`);
    }
    lines.push('');
    lines.push(
      'These embedded children are NOT created as standalone documents. To create them, populate the array on the parent at `create_document` time — each entry is a full create-payload (with its own `name`, `type`, `system`, etc.). Modifying an existing parent uses `update_document` with the same array shape.'
    );

    lines.push('', ...this._embeddedChildrenMistakesCallout(fields));

    const exampleField = fields[0];
    lines.push('', `### Example: ${documentType} with embedded ${exampleField.childType}`, '');
    lines.push('```json');
    lines.push('{');
    lines.push(`  "documentType": ${JSON.stringify(documentType)},`);
    lines.push('  "data": {');
    lines.push('    "name": "<string>",');
    lines.push(`    ${JSON.stringify(exampleField.fieldName)}: [`);
    lines.push(
      `      { "name": "<child name>", "type": "<${exampleField.childType.toLowerCase()} subtype>" }`
    );
    lines.push('    ]');
    lines.push('  }');
    lines.push('}');
    lines.push('```');

    return lines.join('\n');
  }

  /**
   * "Common mistakes" sub-block emitted inside _buildEmbeddedChildrenSection.
   * Extracted so the parent stays under the per-function line cap. Calls
   * out the specific failure modes observed empirically (small models
   * inventing `data.system.inventory` rather than using `data.items`).
   * @param {Array<{fieldName: string}>} fields
   * @returns {string[]} lines (caller joins with \n)
   */
  _embeddedChildrenMistakesCallout(fields) {
    const fieldList = fields.map(f => `\`data.${f.fieldName}\``).join(' / ');
    return [
      '### Common mistakes (DO NOT do these)',
      '',
      `- **Do NOT** put embedded children under \`data.system.*\`. They are TOP-LEVEL fields on \`data\`: ${fieldList}.`,
      '- **Do NOT** invent a system-nested array name like `data.system.inventory`, `data.system.items`, or similar. Use the documented field above.',
      `- **Do NOT** call \`create_document\` separately for each embedded child — embed them in the parent's array.`,
    ];
  }

  /**
   * Extract the embedded child documentType from a `documentClass.hierarchy`
   * entry. Foundry V13 entries look roughly like
   * `{ documentClass: <ClassRef>, ... }` or have a `model.metadata.name`
   * pointer to the child type. Returns null when neither is decipherable —
   * caller falls back to the field name.
   * @param {object} fieldDef
   * @returns {string|null}
   */
  _extractEmbeddedChildType(fieldDef) {
    if (!fieldDef || typeof fieldDef !== 'object') return null;
    const candidates = [
      fieldDef?.model?.metadata?.name,
      fieldDef?.element?.metadata?.name,
      fieldDef?.documentClass?.metadata?.name,
      fieldDef?.documentClass?.name,
      fieldDef?.metadata?.name,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
    }
    return null;
  }

  /**
   * Get the compiled prompt string ready to inject. Concatenates preamble,
   * UUID format, all per-DocType fields content, and all per-template entries
   * in a deterministic order.
   *
   * When `intent` is provided AND the corresponding INTENT_PROFILES entry
   * has a non-`*` `docTypes` set, per-DocType doc_fields and per-template
   * entries are filtered to that set. Preamble + UUID format are always
   * included so the model has the structural rules even if no template
   * scoping applies.
   *
   * @param {string|null|undefined} intent - intent key from INTENT_PROFILES
   * @returns {Promise<string>}
   */
  async getCompiledPrompt(intent = null) {
    if (this._initialIndexPromise && !this._initialIndexComplete) {
      await this._initialIndexPromise;
    }
    if (!this.db) return '';

    const [shared, templates] = await Promise.all([
      this._readAll('shared'),
      this._readAll('templates'),
    ]);

    const docTypeFilter = this._intentDocTypeFilter(intent);

    const sections = [];
    const sharedByKey = new Map(shared.map(s => [s.key, s]));

    // Order: preamble, uuid_format, top_level_fields (shared), per-DocType
    // embedded-children (sorted), per-template entries (sorted).
    if (sharedByKey.has('preamble')) sections.push(sharedByKey.get('preamble').content);
    if (sharedByKey.has('uuid_format')) sections.push(sharedByKey.get('uuid_format').content);
    if (sharedByKey.has('top_level_fields')) {
      sections.push(sharedByKey.get('top_level_fields').content);
    }

    const docFields = shared
      .filter(s => s.key.startsWith('doc_fields::'))
      .filter(s => this._docFieldMatchesIntent(s.key, docTypeFilter))
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const df of docFields) sections.push(df.content);

    const sortedTemplates = templates
      .slice()
      .filter(t => this._templateMatchesIntent(t, docTypeFilter))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const t of sortedTemplates) sections.push(t.content);

    return sections.join('\n\n');
  }

  /**
   * Resolve the docTypes filter for a given intent. Returns `null` to
   * signal "no filtering" (include everything) and an empty Set to signal
   * "include nothing" (intent like `delete` or `search_or_list` that
   * needs no per-template content).
   * @param {string|null|undefined} intent
   * @returns {Set<string>|null}
   */
  _intentDocTypeFilter(intent) {
    if (!intent || !INTENT_PROFILES[intent]) return null;
    const docTypes = INTENT_PROFILES[intent].docTypes;
    if (docTypes === '*') return null;
    return docTypes;
  }

  /**
   * Whether a per-DocType `doc_fields::<DocType>` shared entry should be
   * included given the intent filter. Null filter = include everything.
   * Empty filter = include nothing.
   * @param {string} key
   * @param {Set<string>|null} filter
   * @returns {boolean}
   */
  _docFieldMatchesIntent(key, filter) {
    if (filter === null) return true;
    const docType = key.replace(/^doc_fields::/, '');
    return filter.has(docType);
  }

  /**
   * Whether a per-template entry should be included given the intent filter.
   * @param {{documentType: string}} template
   * @param {Set<string>|null} filter
   * @returns {boolean}
   */
  _templateMatchesIntent(template, filter) {
    if (filter === null) return true;
    return filter.has(template.documentType);
  }

  /**
   * Read all records from a store.
   * @param {string} storeName
   * @returns {Promise<object[]>}
   */
  _readAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get index stats.
   * @returns {{templateCount: number, builtAt: Date|null, cacheKey: string|null, isIndexing: boolean}}
   */
  getStats() {
    return {
      templateCount: this._templateCount,
      builtAt: this._builtAt,
      cacheKey: this._cacheKey,
      isIndexing: this.isIndexing,
    };
  }

  /**
   * Whether the index is ready for consumption.
   * @returns {boolean}
   */
  isReady() {
    return this.db !== null && this._initialIndexComplete;
  }

  /**
   * Availability contract used by tools / system prompt builder.
   * @returns {{available: boolean, reason?: string}}
   */
  getAvailability() {
    if (!this.db) {
      return { available: false, reason: 'IndexedDB not available' };
    }
    if (!this._initialIndexComplete) {
      return { available: false, reason: 'Initial indexing in progress or not yet started' };
    }
    if (this._templateCount === 0) {
      return { available: false, reason: 'No templates indexed' };
    }
    return { available: true };
  }

  /**
   * Filter the LLM tool list for the current request. When small-model mode
   * is on AND the index has compiled content available to inject, strip the
   * schema-discovery tools (inspect_document_schema, list_document_schemas)
   * — they're redundant and small models trip over their paginated output.
   *
   * When `intent` is provided AND the corresponding INTENT_PROFILES entry
   * has a non-`*` `tools` whitelist, the tool list is further restricted
   * to that whitelist. The schema-discovery strip remains in effect even
   * when the whitelist would otherwise admit them — those tools are
   * always wrong in this mode.
   *
   * @param {Array<{function?: {name: string}}>} schemas - tool schemas as
   *   produced by toolRegistry.getToolSchemas()
   * @param {string|null|undefined} intent - intent key from INTENT_PROFILES
   * @returns {Array} filtered (or original) schemas
   */
  filterToolSchemas(schemas, intent = null) {
    if (!Array.isArray(schemas)) return schemas;
    if (!this._readSmallModelMode()) return schemas;
    if (!this.isReady()) return schemas;
    if (this._templateCount === 0) return schemas;

    const allowList = this._intentToolAllowList(intent);

    return schemas.filter(s => {
      const name = s?.function?.name;
      if (SCHEMA_DISCOVERY_TOOL_NAMES.has(name)) return false;
      if (allowList && !allowList.has(name)) return false;
      return true;
    });
  }

  /**
   * Resolve the per-intent tool whitelist. Returns `null` for "no
   * whitelist" (only the always-strip schema-discovery rule applies).
   * @param {string|null|undefined} intent
   * @returns {Set<string>|null}
   */
  _intentToolAllowList(intent) {
    if (!intent || !INTENT_PROFILES[intent]) return null;
    const tools = INTENT_PROFILES[intent].tools;
    if (tools === '*') return null;
    return tools;
  }

  /**
   * Teardown hook for parity with AssetIndexService. SchemaIndexService has no
   * heartbeat to stop, but we expose this for symmetry.
   */
  stopSync() {
    /* no-op — schema index is not interval-driven */
  }
}

// Singleton instance
export const schemaIndexService = new SchemaIndexService();
