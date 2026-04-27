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
 * mislead the model.
 * @param {object} fieldInfo
 * @returns {string}
 */
function formatExampleValue(fieldInfo) {
  const trusted =
    Array.isArray(fieldInfo?.choices) &&
    fieldInfo.choices.length > 0 &&
    fieldInfo.choicesSource !== 'CONFIG';
  if (trusted) {
    return JSON.stringify(fieldInfo.choices[0]);
  }
  return TYPE_EXAMPLE[fieldInfo?.type] ?? '"<value>"';
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
   * leaves only, depth-capped at MAX_RECURSION_STEPS.
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

    const systemBlock = this._buildSystemSkeleton(schema.systemFieldDetails, 0);
    if (systemBlock) {
      data.system = systemBlock;
    }

    const dataBlock = this._renderJSONLike(data, 2);
    const wrapper = `{\n  "documentType": ${JSON.stringify(documentType)},\n  "data": ${dataBlock}\n}`;
    return '```json\n' + wrapper + '\n```';
  }

  /**
   * Recursively assemble a skeleton object containing only required leaves,
   * up to MAX_RECURSION_STEPS levels deep. Returns null when nothing required is
   * found at the current level (caller can omit the system block entirely).
   *
   * @param {object|undefined} fieldDetails
   * @param {number} depth
   * @returns {Record<string, string|object>|null}
   */
  _buildSystemSkeleton(fieldDetails, depth) {
    if (!fieldDetails || typeof fieldDetails !== 'object') return null;
    if (depth >= MAX_RECURSION_STEPS) return null;

    const out = {};
    for (const [name, info] of Object.entries(fieldDetails)) {
      if (this._shouldSkipSchemaField(name, info)) continue;
      if (!info.required) continue;
      const value = this._renderSkeletonField(info, depth);
      if (value !== undefined) out[name] = value;
    }
    return Object.keys(out).length > 0 ? out : null;
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
   * @param {object} info
   * @param {number} depth
   * @returns {string|object|undefined}
   */
  _renderSkeletonField(info, depth) {
    if (info.nested && typeof info.nested === 'object') {
      const nested = this._buildSystemSkeleton(info.nested, depth + 1);
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
   */
  _formatFieldLine(name, info) {
    const typeName = info.type || 'unknown';
    const isComplex = COMPLEX_FIELD_TYPES.has(typeName);
    const typeLabel = isComplex ? `${typeName}; complex, use inspect_document_schema` : typeName;
    const parts = [`- \`system.${name}\` (${typeLabel})`];
    if (info.required) parts.push('**required**');
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
   * Build the preamble shared content. Explains create_document call shape.
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
      '### Calling create_document',
      '',
      'Every `create_document` call requires:',
      '- `documentType` — top-level type from this list: ' + typesSummary,
      '- `data.name` — string, the document name',
      '- `data.type` — subtype (e.g. `"npc"`, `"weapon"`); see per-template entries below',
      '- `data.system.*` — system-specific fields, see per-template entries',
      '',
      'For document types not covered below, fall back to `inspect_document_schema(documentType, subtype)`.',
    ].join('\n');
  }

  /**
   * Build the UUID format reference content, with live world ID and pack list.
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
      'Foundry documents are referenced by UUID. The format depends on where the document lives.',
      '',
      '**World documents (in this world):**',
      '`@UUID[<DocType>.<id>]` or `@UUID[<DocType>.<id>]{Display Name}`',
      `Example: \`@UUID[Actor.abc123]\` (world: ${worldId})`,
      '',
      '**Compendium documents (in a pack):**',
      '`@UUID[Compendium.<scope>.<pack>.<DocType>.<id>]`',
      'Example: `@UUID[Compendium.dnd5e.heroes.Actor.xyz789]{Hero Name}`',
      '',
      '**Embedded documents (Items inside an Actor, Pages inside a Journal):**',
      '`@UUID[<ParentType>.<parentId>.<EmbeddedType>.<embeddedId>]`',
      'Example: `@UUID[Actor.abc123.Item.def456]`',
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
   * class declares an embedded hierarchy. Skips the boilerplate top-level
   * fields list (now shared).
   * @param {string} documentType
   * @returns {string|null}
   */
  _buildEmbeddedChildrenSection(documentType) {
    const documentClass = CONFIG?.[documentType]?.documentClass;
    if (!documentClass) return null;

    const hierarchy = documentClass.hierarchy;
    if (!hierarchy || Object.keys(hierarchy).length === 0) return null;

    const embeddedNames = Object.keys(hierarchy);
    return [
      `## ${documentType} — Embedded children`,
      '',
      `${documentType} contains embedded documents of these types: ${embeddedNames.join(', ')}.`,
      `These are NOT created as standalone documents — they exist only as children of a ${documentType}.`,
    ].join('\n');
  }

  /**
   * Get the compiled prompt string ready to inject. Concatenates preamble,
   * UUID format, all per-DocType fields content, and all per-template entries
   * in a deterministic order.
   * @returns {Promise<string>}
   */
  async getCompiledPrompt() {
    if (this._initialIndexPromise && !this._initialIndexComplete) {
      await this._initialIndexPromise;
    }
    if (!this.db) return '';

    const [shared, templates] = await Promise.all([
      this._readAll('shared'),
      this._readAll('templates'),
    ]);

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
      .sort((a, b) => a.key.localeCompare(b.key));
    for (const df of docFields) sections.push(df.content);

    const sortedTemplates = templates.slice().sort((a, b) => a.id.localeCompare(b.id));
    for (const t of sortedTemplates) sections.push(t.content);

    return sections.join('\n\n');
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
   * Otherwise pass through unchanged.
   * @param {Array<{function?: {name: string}}>} schemas - tool schemas as
   *   produced by toolRegistry.getToolSchemas()
   * @returns {Array} filtered (or original) schemas
   */
  filterToolSchemas(schemas) {
    if (!Array.isArray(schemas)) return schemas;
    if (!this._readSmallModelMode()) return schemas;
    if (!this.isReady()) return schemas;
    if (this._templateCount === 0) return schemas;
    return schemas.filter(s => !SCHEMA_DISCOVERY_TOOL_NAMES.has(s?.function?.name));
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
