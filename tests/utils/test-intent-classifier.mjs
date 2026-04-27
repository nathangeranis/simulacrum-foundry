/**
 * Tests for intent-classifier heuristics.
 *
 * Intent classification feeds the per-intent tool/template scoping under
 * smallModelMode. Misclassifications fall back to `ambiguous` (which
 * retains all tools/templates) — they're forgiven, but the happy paths
 * documented here MUST hold or the scoping work-product is undermined.
 *
 * Run: node tests/utils/test-intent-classifier.mjs
 */

import assert from 'node:assert/strict';

const { classifyLatestUserMessage } = await import('../../scripts/core/intent-classifier.js');

// Test helper: wrap a single user message in the conversation envelope
// expected by classifyLatestUserMessage. Mirrors the path that production
// code (chat-handler / conversation-engine / simulacrum-core) takes.
const classifyIntent = msg => classifyLatestUserMessage([{ role: 'user', content: msg }]);

function testCreateActorIntents() {
  // Grunk benchmark — the canonical happy path.
  assert.equal(
    classifyIntent('Create a goblin warrior named Grunk with 15 HP and a rusty shortsword.'),
    'create_actor'
  );
  assert.equal(classifyIntent('Make an NPC for me'), 'create_actor');
  assert.equal(classifyIntent('Spawn a dragon'), 'create_actor');
  assert.equal(classifyIntent('Add a vampire to the world'), 'create_actor');
  assert.equal(classifyIntent('Build a character named Aria'), 'create_actor');
}

function testCreateItemIntents() {
  assert.equal(classifyIntent('Create a magic sword called Frostbite'), 'create_item');
  assert.equal(classifyIntent('Make a healing potion'), 'create_item');
  assert.equal(classifyIntent('Create a +1 longbow'), 'create_item');
  assert.equal(classifyIntent('Add a scroll of fireball'), 'create_item');
}

function testActorWithItemsResolvesToActor() {
  // "Create a goblin warrior with a rusty shortsword" — Grunk-style. The
  // primary object is the actor; the item is incidental. Actor must win
  // over item when both keyword groups appear with a create verb.
  assert.equal(
    classifyIntent('Create a goblin warrior with a rusty shortsword'),
    'create_actor',
    'actor takes precedence when both actor + item keywords appear'
  );
}

function testCreateJournalIntents() {
  assert.equal(classifyIntent('Create a journal entry titled "Session 3"'), 'create_journal');
  assert.equal(classifyIntent('Make a note about the tavern'), 'create_journal');
  assert.equal(classifyIntent('Generate a session recap page'), 'create_journal');
}

function testCreateSceneIntents() {
  assert.equal(classifyIntent('Create a scene for the dungeon'), 'create_scene');
  assert.equal(classifyIntent('Make a battlemap'), 'create_scene');
}

function testModifyIntents() {
  assert.equal(classifyIntent("Update the goblin's HP to 20"), 'modify');
  assert.equal(classifyIntent('Rename the actor "Hero" to "Champion"'), 'modify');
  assert.equal(classifyIntent('Set the AC to 18'), 'modify');
}

function testDeleteIntents() {
  assert.equal(classifyIntent('Delete the goblin'), 'delete');
  assert.equal(classifyIntent('Remove that journal entry'), 'delete');
  assert.equal(classifyIntent('Destroy the old map'), 'delete');
}

function testSearchOrListIntents() {
  assert.equal(classifyIntent('Find the goblin actor'), 'search_or_list');
  assert.equal(classifyIntent('List all NPCs'), 'search_or_list');
  assert.equal(classifyIntent('What journals do I have?'), 'search_or_list');
  assert.equal(classifyIntent('Show me the scenes'), 'search_or_list');
}

function testExecuteAutomationIntents() {
  assert.equal(classifyIntent('Execute the macro called Roll Init'), 'execute_automation');
  assert.equal(classifyIntent('Run the cleanup script'), 'execute_automation');
}

function testAssetManagementIntents() {
  // "Find an icon for goblins" — has search keyword too, but our heuristic
  // prefers asset over search when both match.
  assert.equal(classifyIntent('Show me icons for goblins'), 'search_or_list');
  // Pure asset phrasings:
  assert.equal(classifyIntent('Browse for a portrait'), 'asset_management');
}

function testAmbiguousFallback() {
  assert.equal(classifyIntent(''), 'ambiguous');
  assert.equal(classifyIntent(null), 'ambiguous');
  assert.equal(classifyIntent(undefined), 'ambiguous');
  assert.equal(classifyIntent('Hello!'), 'ambiguous');
  assert.equal(classifyIntent('Tell me a story'), 'ambiguous');
  assert.equal(classifyIntent(42), 'ambiguous', 'non-string input → ambiguous');
}

/**
 * Word-boundary regression: substring match alone would classify "describe
 * this creature" as create_actor (because "create" is a substring of
 * "creature"). The proxy had this bug; our classifier must not.
 */
function testWordBoundaries() {
  // "describe this creature" has actor keyword "creature" but no create keyword.
  // Without word boundaries, "create" inside "creature" would falsely trigger.
  assert.equal(
    classifyIntent('Describe this creature'),
    'ambiguous',
    'creature alone (no verb) → ambiguous, not create_actor'
  );
  // "Create" with "creature" SHOULD work though:
  assert.equal(classifyIntent('Create a creature'), 'create_actor');
}

function testClassifyLatestUserMessage() {
  // Skips system + assistant + tool messages, finds the latest user message.
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi! How can I help?' },
    { role: 'user', content: 'Create a goblin warrior' },
    { role: 'assistant', content: 'On it...' },
    { role: 'tool', content: 'tool result' },
  ];
  assert.equal(classifyLatestUserMessage(messages), 'create_actor');

  assert.equal(classifyLatestUserMessage([]), 'ambiguous');
  assert.equal(classifyLatestUserMessage(null), 'ambiguous');
  assert.equal(classifyLatestUserMessage(undefined), 'ambiguous');

  // No user message at all
  assert.equal(classifyLatestUserMessage([{ role: 'system', content: '...' }]), 'ambiguous');
}

testCreateActorIntents();
testCreateItemIntents();
testActorWithItemsResolvesToActor();
testCreateJournalIntents();
testCreateSceneIntents();
testModifyIntents();
testDeleteIntents();
testSearchOrListIntents();
testExecuteAutomationIntents();
testAssetManagementIntents();
testAmbiguousFallback();
testWordBoundaries();
testClassifyLatestUserMessage();

console.log('intent-classifier tests passed');
