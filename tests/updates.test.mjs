import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSummary, markRead, unreadCount, freshPost, suggestedDraft } from '../public/updates.js';

test('same-millisecond messages remain unread until the displayed snapshot includes them', () => {
  let thread = { incomingCount: 1, messageCount: 2, updatedAt: 10, expiresAt: 100 };
  thread = mergeSummary(thread, { incomingCount: 3, messageCount: 4, updatedAt: 10 });
  thread = markRead(thread, { incomingCount: 2, messageCount: 3, updatedAt: 10 });
  assert.equal(unreadCount(thread, 20), 1);
  thread = mergeSummary(thread, { incomingCount: 1, messageCount: 2, updatedAt: 9 });
  assert.equal(unreadCount(thread, 20), 1);
  assert.equal(thread.messageCount, 4);
  thread = markRead(thread, { incomingCount: 3, messageCount: 4, updatedAt: 10 });
  assert.equal(unreadCount(thread, 20), 0);
  assert.equal(unreadCount({ ...thread, incomingCount: 5 }, 100), 0);
});

test('same-millisecond reopening is not overwritten by an old mutation response', () => {
  const reopened = { revision: 2, updatedAt: 10, places: 1 };
  assert.equal(freshPost(reopened, { revision: 1, updatedAt: 10, places: 0 }), reopened);
  assert.equal(freshPost(reopened, { revision: 3, updatedAt: 10, places: 0 }).places, 0);
});

test('quick suggestions never overwrite a manually edited draft', () => {
  assert.equal(suggestedDraft('', '', 'Bonjour'), 'Bonjour');
  assert.equal(suggestedDraft('Bonjour', 'Bonjour', 'Toujours dispo ?'), 'Toujours dispo ?');
  assert.equal(suggestedDraft('Mon brouillon', 'Bonjour', 'Toujours dispo ?'), 'Mon brouillon');
});
