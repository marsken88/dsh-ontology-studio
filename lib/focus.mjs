/**
 * Task-layer focus: which objects does this turn appear to be about?
 *
 * Deliberately dumb and predictable: keyword hits over object ids, names and
 * property labels. It only ever adds one advisory line to the brief — it never
 * removes context, so a wrong guess costs a sentence rather than the answer.
 */

/** Pull plain text out of a message list (string content or text blocks). */
export function messageText(messages) {
  const parts = [];
  for (const message of messages || []) {
    const content = message && message.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block.text === 'string') parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * @param {object} ir package
 * @param {string} text
 * @param {{ limit?: number }} options
 * @returns {Array<{id: string, name: string, score: number, hits: string[]}>}
 */
export function focusOf(ir, text, options = {}) {
  const limit = options.limit || 3;
  const lower = String(text || '').toLowerCase();
  if (!lower) return [];
  const scored = [];

  for (const object of ir.objects || []) {
    const id = String(object.id || '');
    const name = String(object.name || '');
    let score = 0;
    const hits = [];
    const consider = (word, weight) => {
      const needle = String(word || '').toLowerCase();
      if (needle.length < 2) return;
      if (lower.includes(needle)) {
        score += weight;
        if (!hits.includes(needle)) hits.push(needle);
      }
    };

    consider(id, 3);
    consider(name, 2);
    for (const property of object.properties || []) {
      consider(property.label, 1);
      consider(property.name, 1);
    }
    if (score > 0) scored.push({ id, name, score, hits });
  }

  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
