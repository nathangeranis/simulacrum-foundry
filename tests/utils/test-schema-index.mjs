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

testHeadingAndDescription();
testMinimumViableJsonSection();
testCommonFieldsSection();
testSkipListExcludesHousekeepingFields();
testRequiredOnlyInJsonSkeleton();
testBaseTemplate();
testDeterminism();
testStaticSnapshot();
testCacheKeyDeterminism();

console.log('schema-index tests passed');
