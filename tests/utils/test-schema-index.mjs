/**
 * Tests for SchemaIndexService markdown generation.
 *
 * The full _buildTemplateEntry path goes through DocumentAPI.getDocumentSchema
 * which depends on Foundry's CONFIG. To keep this test isolated, we exercise
 * the pure _buildTemplateEntryFromSchema entry point with a fixture schema
 * matching DocumentAPI's output shape.
 *
 * Run: node tests/utils/test-schema-index.mjs
 */

import assert from 'node:assert/strict';

// Minimal globals — enough for the service to import and run without throwing.
globalThis.CONFIG = {};
globalThis.game = {
  i18n: { localize: key => key },
};

const { schemaIndexService } = await import('../../scripts/core/schema-index-service.js');

/**
 * Fixture schema matching the shape of DocumentAPI.getDocumentSchema output
 * for an Actor with subtype 'npc'. Only fields the markdown generator
 * actually consults are populated.
 */
function buildActorNpcSystemFields() {
  return {
    attributes: {
      type: 'schema',
      required: true,
      nested: {
        hp: {
          type: 'schema',
          required: true,
          nested: {
            value: { type: 'number', required: true },
            max: { type: 'number', required: true },
          },
        },
        ac: {
          type: 'schema',
          required: false,
          nested: { flat: { type: 'number', required: false } },
        },
      },
    },
    details: {
      type: 'schema',
      required: false,
      nested: {
        biography: { type: 'html', required: false },
        cr: { type: 'number', required: false },
      },
    },
    traits: {
      type: 'schema',
      required: false,
      nested: {
        size: { type: 'string', required: false, choices: ['tiny', 'sm', 'med', 'lg'] },
        alignment: { type: 'string', required: false },
      },
    },
    currency: { type: 'schema', required: false },
    skills: { type: 'mapping', required: false, isMapping: true },
    // Non-system housekeeping that should be skipped
    _stats: { type: 'document_stats' },
    flags: { type: 'document_flags' },
  };
}

function buildActorNpcFixture() {
  return {
    type: 'Actor',
    subtype: 'npc',
    fields: ['name', 'type', 'img', 'system'],
    fieldDetails: {
      name: { type: 'string', required: true },
      type: { type: 'string', required: true, choices: ['npc', 'character'] },
      img: { type: 'file_path', required: false },
      system: { type: 'type_data' },
    },
    systemFields: ['attributes', 'details', 'traits', 'currency', 'skills', 'items'],
    systemFieldDetails: buildActorNpcSystemFields(),
    embedded: ['Item', 'ActiveEffect'],
    embeddedSchemas: {
      Item: { isEmbedded: true, note: '...' },
      ActiveEffect: { isEmbedded: true, note: '...' },
    },
  };
}

function testHeadingAndDescription() {
  const service = schemaIndexService;
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  assert.match(md, /^## Actor \(npc\)/m, 'expected heading');
  assert.match(md, /Actor document with subtype "npc"\./, 'expected description');
}

function testMinimumViableJsonSection() {
  const service = schemaIndexService;
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  assert.match(md, /### Minimum viable create_document call/, 'expected section header');
  assert.match(md, /```json/, 'expected fenced JSON block');
  assert.match(md, /"documentType": "Actor"/, 'expected documentType in JSON');
  assert.match(md, /"name": "<string>"/, 'expected name placeholder');
  assert.match(md, /"type": "npc"/, 'expected type subtype');
  assert.match(md, /"system":/, 'expected system block');
  assert.match(md, /"hp":/, 'expected required nested hp');
  assert.match(md, /"value":/, 'expected required leaf within hp');
}

function testCommonFieldsSection() {
  const service = schemaIndexService;
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  assert.match(md, /### Common system\.\* fields/, 'expected common-fields section');
  assert.match(md, /`system\.attributes`.*\*\*required\*\*/, 'required field marked required');
  assert.match(md, /`system\.traits`/, 'expected non-required field listed');
}

function testSkipListExcludesHousekeepingFields() {
  const service = schemaIndexService;
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  assert.equal(/`system\._stats`/.test(md), false, '_stats should be skipped');
  assert.equal(/`system\.flags`/.test(md), false, 'flags should be skipped');
}

function testRequiredOnlyInJsonSkeleton() {
  const service = schemaIndexService;
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  // attributes is required, details is not — only attributes should be in skeleton
  // We can't easily check JSON contents without parsing; check that required field
  // appears in JSON section but non-required (currency) is omitted from system block.
  const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch, 'expected json block');
  const jsonText = jsonMatch[1];
  assert.match(jsonText, /"attributes":/, 'required field in skeleton');
  assert.equal(/"currency":/.test(jsonText), false, 'non-required field omitted from skeleton');
}

function testBaseTemplate() {
  const service = schemaIndexService;
  const fixture = buildActorNpcFixture();
  delete fixture.subtype;
  const md = service._buildTemplateEntryFromSchema('Actor', null, fixture);
  assert.match(md, /^## Actor \(base\)/m, 'base heading');
  assert.match(md, /Base schema for Actor documents/, 'base description');
  // No "type" field expected when subtype is null
  const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch);
  const jsonText = jsonMatch[1];
  assert.equal(/"type":/.test(jsonText), false, 'no type field in base skeleton');
}

function testDeterminism() {
  const service = schemaIndexService;
  const a = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  const b = service._buildTemplateEntryFromSchema('Actor', 'npc', buildActorNpcFixture());
  assert.equal(a, b, 'output should be deterministic for identical inputs');
}

function testStaticSnapshot() {
  // Locks the high-level shape of output to catch unintended drift between
  // PR1 and PR3. Strict string equality on a fixture-derived snapshot.
  const service = schemaIndexService;
  const fixture = {
    type: 'Item',
    subtype: 'weapon',
    fields: ['name', 'type', 'img', 'system'],
    fieldDetails: {
      name: { type: 'string', required: true },
      type: { type: 'string', required: true },
      img: { type: 'file_path' },
    },
    systemFields: ['damage', 'range'],
    systemFieldDetails: {
      damage: { type: 'string', required: true, choices: ['piercing', 'slashing', 'bludgeoning'] },
      range: { type: 'number', required: false },
    },
  };
  const md = service._buildTemplateEntryFromSchema('Item', 'weapon', fixture);

  const expected = [
    '## Item (weapon)',
    'Item document with subtype "weapon".',
    '',
    '### Minimum viable create_document call',
    '```json',
    '{',
    '  "documentType": "Item",',
    '  "data": {',
    '    "name": "<string>",',
    '    "type": "weapon",',
    '    "img": "<path or omit>",',
    '    "system": {',
    '      "damage": "piercing"',
    '    }',
    '  }',
    '}',
    '```',
    '',
    '### Common system.* fields',
    '- `system.damage` (string) — **required** — choices: `piercing`, `slashing`, `bludgeoning`',
    '- `system.range` (number)',
  ].join('\n');

  assert.equal(md, expected, 'snapshot mismatch');
}

function testCacheKeyDeterminism() {
  // Stub game.system + modules so _computeCacheKey produces a stable result
  globalThis.game.system = { id: 'dnd5e', version: '3.0.0' };
  globalThis.game.modules = new Map([
    ['mod-a', { active: true, version: '1.0.0' }],
    ['mod-b', { active: true, version: '2.0.0' }],
  ]);

  const service = schemaIndexService;
  const k1 = service._computeCacheKey();
  const k2 = service._computeCacheKey();
  assert.equal(k1, k2, 'same inputs produce same key');
  assert.match(k1, /^dnd5e@3\.0\.0\|[0-9a-f]{8}$/, 'key matches expected shape');

  // Different module set → different key
  globalThis.game.modules = new Map([
    ['mod-a', { active: true, version: '1.0.0' }],
    ['mod-c', { active: true, version: '3.0.0' }],
  ]);
  const k3 = service._computeCacheKey();
  assert.notEqual(k1, k3, 'different modules produce different key');

  // Inactive modules excluded
  globalThis.game.modules = new Map([
    ['mod-a', { active: true, version: '1.0.0' }],
    ['mod-b', { active: false, version: '2.0.0' }],
  ]);
  const k4 = service._computeCacheKey();
  assert.notEqual(k1, k4, 'inactive modules should not contribute to hash');
}

/**
 * Common-leaf heuristic: when a SchemaField is required, also surface its
 * `value`/`max`/`min` children even if they're not strictly required. This
 * matches dnd5e-style schemas where `hp.formula` is required but the
 * gameplay-relevant fields are `hp.value` and `hp.max`. Without this
 * surface, small models populate only the required leaf and leave HP at 0.
 */
function testCommonLeafSurfacing() {
  const service = schemaIndexService;
  const fixture = {
    type: 'Actor',
    subtype: 'npc',
    fields: ['name', 'type', 'system'],
    fieldDetails: {
      name: { type: 'string', required: true },
      type: { type: 'string', required: true },
    },
    systemFields: ['attributes'],
    systemFieldDetails: {
      attributes: {
        type: 'schema',
        required: true,
        nested: {
          hp: {
            type: 'schema',
            required: true,
            nested: {
              formula: { type: 'formula', required: true },
              value: { type: 'number', required: false },
              max: { type: 'number', required: false },
              dt: { type: 'number', required: false },
            },
          },
        },
      },
    },
  };
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', fixture);
  const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch);
  const jsonText = jsonMatch[1];
  assert.match(jsonText, /"value":/, 'value should be surfaced under required hp');
  assert.match(jsonText, /"max":/, 'max should be surfaced under required hp');
  assert.match(jsonText, /"formula":/, 'required formula remains');
  assert.equal(/"dt":/.test(jsonText), false, 'non-common non-required leaf should be omitted');
}

/**
 * Embedded-children stub: when the documentClass declares an embedded
 * hierarchy (Actor → items, JournalEntry → pages), the per-template JSON
 * skeleton must include a top-level array with a populated stub child
 * for each. Empty `[]` was insufficient — small models read the empty
 * array as "not used here" and invented `data.system.<madeup>` to
 * satisfy their training-data prior. The stub is a fill-in-the-blank
 * target: `{"name": "<...>", "type": "<...>"}`.
 */
function testEmbeddedChildrenStubInSkeleton() {
  const service = schemaIndexService;
  // Simulate Foundry's CONFIG.<DocType>.documentClass.hierarchy for Actor.
  const originalCONFIG = globalThis.CONFIG;
  const originalDocumentTypes = globalThis.game.documentTypes;
  globalThis.CONFIG = {
    Actor: {
      documentClass: {
        hierarchy: { items: { metadata: { name: 'Item' } }, effects: {} },
      },
    },
  };
  // Item has subtypes (so stub gets a `type` hint); ActiveEffect doesn't.
  globalThis.game.documentTypes = {
    Item: ['weapon', 'equipment'],
    ActiveEffect: [],
  };

  const fixture = {
    type: 'Actor',
    subtype: 'npc',
    fields: ['name', 'type', 'system'],
    fieldDetails: { name: { type: 'string', required: true } },
    systemFields: ['attributes'],
    systemFieldDetails: {
      attributes: {
        type: 'schema',
        required: true,
        nested: { hp: { type: 'number', required: true } },
      },
    },
  };
  const md = service._buildTemplateEntryFromSchema('Actor', 'npc', fixture);
  const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(jsonMatch);
  const jsonText = jsonMatch[1];

  // items has subtypes → stub includes `type` hint
  assert.match(jsonText, /"items": \[\s*\{ "name": "<item name>", "type": "<item subtype>" \}/);
  // effects has no subtypes → stub is name-only
  assert.match(jsonText, /"effects": \[\s*\{ "name": "<.*?name>" \}/);

  // Items must be at the SAME indent as `system` (i.e. a sibling under
  // `data`), not nested inside the system block.
  const systemIndent = jsonText.match(/^( +)"system":/m)?.[1];
  const itemsIndent = jsonText.match(/^( +)"items":/m)?.[1];
  assert.ok(systemIndent, 'system line found');
  assert.ok(itemsIndent, 'items line found');
  assert.equal(itemsIndent, systemIndent, 'items must be a sibling of system, not nested');

  globalThis.CONFIG = originalCONFIG;
  globalThis.game.documentTypes = originalDocumentTypes;
}

/**
 * Embedded-children section gets the explicit "Common mistakes" callout
 * forbidding `data.system.<X>` for embedded items. Targets the failure
 * mode where small models invented `data.system.inventory` despite the
 * skeleton showing `data.items`.
 */
function testEmbeddedChildrenCommonMistakesCallout() {
  const service = schemaIndexService;
  const originalCONFIG = globalThis.CONFIG;
  globalThis.CONFIG = {
    Actor: {
      documentClass: {
        hierarchy: { items: { metadata: { name: 'Item' } } },
      },
    },
  };

  const md = service._buildEmbeddedChildrenSection('Actor');
  assert.ok(md, 'section emitted');
  assert.match(md, /Common mistakes/, 'common-mistakes header present');
  assert.match(md, /Do NOT.*data\.system/, 'forbids data.system nesting');
  assert.match(md, /inventory/, 'explicitly names the invented field as a bad pattern');

  globalThis.CONFIG = originalCONFIG;
}

/**
 * Initial values: when a field declares an `initial` default, prefer that
 * over generic placeholders in the JSON skeleton AND surface it as a
 * `default <value>` annotation in the Common Fields list.
 */
function testInitialValueRendering() {
  const service = schemaIndexService;
  const fixture = {
    type: 'Item',
    subtype: 'weapon',
    fields: ['name', 'type'],
    fieldDetails: { name: { type: 'string', required: true } },
    systemFields: ['quantity'],
    systemFieldDetails: {
      quantity: { type: 'number', required: true, initial: 1 },
    },
  };
  const md = service._buildTemplateEntryFromSchema('Item', 'weapon', fixture);
  const jsonMatch = md.match(/```json\n([\s\S]*?)\n```/);
  assert.match(jsonMatch[1], /"quantity": 1/, 'initial value used in skeleton');
  assert.match(md, /default 1/, 'initial annotated in common fields');
}

/**
 * Intent profiles: filterToolSchemas with a known intent should restrict
 * the tool set to that intent's whitelist (plus stripping schema-discovery
 * tools always).
 */
function testFilterToolSchemasByIntent() {
  const service = schemaIndexService;

  // Stub the gating preconditions so filterToolSchemas runs its full path.
  const originalSettings = globalThis.game.settings;
  globalThis.game.settings = {
    get: (_module, key) => (key === 'smallModelMode' ? true : undefined),
  };
  service.db = service.db || {}; // any non-null sentinel
  service._initialIndexComplete = true;
  service._templateCount = 1;

  const schemas = [
    { type: 'function', function: { name: 'create_document' } },
    { type: 'function', function: { name: 'delete_document' } },
    { type: 'function', function: { name: 'inspect_document_schema' } },
    { type: 'function', function: { name: 'manage_task' } },
    { type: 'function', function: { name: 'end_loop' } },
    { type: 'function', function: { name: 'execute_macro' } },
    { type: 'function', function: { name: 'search_documents' } },
    { type: 'function', function: { name: 'search_assets' } },
  ];

  const filteredCreate = service.filterToolSchemas(schemas, 'create_actor');
  const namesCreate = filteredCreate.map(s => s.function.name).sort();
  assert.deepEqual(
    namesCreate,
    ['create_document', 'end_loop', 'manage_task', 'search_assets', 'search_documents'],
    'create_actor whitelist applied (no update_document available in test schemas)'
  );
  assert.equal(
    namesCreate.includes('inspect_document_schema'),
    false,
    'schema-discovery still stripped under intent'
  );

  const filteredDelete = service.filterToolSchemas(schemas, 'delete');
  const namesDelete = filteredDelete.map(s => s.function.name).sort();
  assert.deepEqual(
    namesDelete,
    ['delete_document', 'end_loop', 'manage_task', 'search_documents'],
    'delete intent restricts to delete_document family'
  );

  const filteredAmbiguous = service.filterToolSchemas(schemas, 'ambiguous');
  assert.equal(
    filteredAmbiguous.includes('inspect_document_schema'),
    false,
    'schema-discovery stripped under ambiguous'
  );
  assert.equal(
    filteredAmbiguous.length,
    7,
    'ambiguous keeps all but schema-discovery (7 of 8 input schemas)'
  );

  // Restore globals
  globalThis.game.settings = originalSettings;
  service._initialIndexComplete = false;
  service._templateCount = 0;
  service.db = null;
}

/**
 * Intent docTypes filter should drop per-DocType doc_fields and per-template
 * entries that don't match the intent's docTypes set.
 */
function testIntentDocTypeFilter() {
  const service = schemaIndexService;
  const filterCreateActor = service._intentDocTypeFilter('create_actor');
  assert.ok(filterCreateActor instanceof Set);
  assert.equal(filterCreateActor.has('Actor'), true);
  assert.equal(filterCreateActor.has('Item'), true);
  assert.equal(filterCreateActor.has('JournalEntry'), false);

  const filterCreateOther = service._intentDocTypeFilter('create_other');
  assert.equal(filterCreateOther, null, "'*' resolves to null (no filter)");

  const filterAmbiguous = service._intentDocTypeFilter('ambiguous');
  assert.equal(filterAmbiguous, null, 'ambiguous applies no doc filter');

  const filterUnknown = service._intentDocTypeFilter('not_a_real_intent');
  assert.equal(filterUnknown, null, 'unknown intent applies no filter');

  // Helpers
  assert.equal(
    service._docFieldMatchesIntent('doc_fields::Actor', filterCreateActor),
    true,
    'Actor doc_fields included for create_actor'
  );
  assert.equal(
    service._docFieldMatchesIntent('doc_fields::Scene', filterCreateActor),
    false,
    'Scene doc_fields excluded for create_actor'
  );

  assert.equal(service._templateMatchesIntent({ documentType: 'Actor' }, filterCreateActor), true);
  assert.equal(service._templateMatchesIntent({ documentType: 'Scene' }, filterCreateActor), false);
}

/**
 * Sanity: every documented intent key behaves predictably through the
 * public API. INTENT_PROFILES isn't exported (kept module-private to keep
 * knip's surface clean), so we exercise the table indirectly via the
 * filter helpers — same coverage, no extra exports.
 */
function testEveryIntentDispatchable() {
  const service = schemaIndexService;
  const documented = [
    'create_actor',
    'create_item',
    'create_journal',
    'create_scene',
    'create_other',
    'modify',
    'delete',
    'search_or_list',
    'execute_automation',
    'asset_management',
    'ambiguous',
  ];
  for (const intent of documented) {
    const filter = service._intentDocTypeFilter(intent);
    assert.ok(filter === null || filter instanceof Set, `${intent} resolves to a Set or null`);
    const allowList = service._intentToolAllowList(intent);
    assert.ok(
      allowList === null || allowList instanceof Set,
      `${intent} tool allow-list resolves to a Set or null`
    );
  }
  // Unknown intent strings fall through to "no filter" (graceful degradation).
  assert.equal(service._intentDocTypeFilter('totally_made_up'), null);
  assert.equal(service._intentToolAllowList('totally_made_up'), null);
}

testHeadingAndDescription();
testMinimumViableJsonSection();
testCommonFieldsSection();
testSkipListExcludesHousekeepingFields();
testRequiredOnlyInJsonSkeleton();
testBaseTemplate();
testDeterminism();
testStaticSnapshot();
testCacheKeyDeterminism();
testCommonLeafSurfacing();
testEmbeddedChildrenStubInSkeleton();
testEmbeddedChildrenCommonMistakesCallout();
testInitialValueRendering();
testFilterToolSchemasByIntent();
testIntentDocTypeFilter();
testEveryIntentDispatchable();

console.log('schema-index tests passed');
