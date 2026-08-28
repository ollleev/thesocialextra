// Counts, not timestamps: several messages can arrive in the same millisecond.
export function mergeSummary(previous = {}, summary) {
  return {
    ...previous, ...summary,
    messageCount: Math.max(previous.messageCount || 0, summary.messageCount || 0),
    incomingCount: Math.max(previous.incomingCount || 0, summary.incomingCount || 0),
    updatedAt: Math.max(previous.updatedAt || 0, summary.updatedAt || 0),
    readIncomingCount: previous.readIncomingCount || 0,
  };
}

export function markRead(previous, snapshot) {
  const merged = mergeSummary(previous, snapshot);
  merged.readIncomingCount = Math.max(previous.readIncomingCount || 0, snapshot.incomingCount || 0);
  return merged;
}

export function unreadCount(thread, now) {
  return thread.expiresAt > now ? Math.max(0, (thread.incomingCount || 0) - (thread.readIncomingCount || 0)) : 0;
}

export function freshPost(current, candidate) {
  return (candidate.revision ?? candidate.updatedAt) >= (current.revision ?? current.updatedAt) ? candidate : current;
}

export function suggestedDraft(current, previousSuggestion, suggestion) {
  return !current.trim() || current === previousSuggestion ? suggestion : current;
}
