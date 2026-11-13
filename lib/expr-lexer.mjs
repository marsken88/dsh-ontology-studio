/**
 * Tokenizer for the ontology rule expression grammar.
 *
 * Kept separate from the parser so the token vocabulary is auditable on its own:
 * numbers, single or double quoted strings, identifiers, punctuation, and the
 * comparison/logical operator set. Nothing else can be produced.
 */
export class LexError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'LexError';
    this.position = position;
  }
}

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '+', '-', '*', '/'];

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i;
      i += 1;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
          const escaped = source[i + 1];
          if (escaped === undefined) break;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) throw new LexError('字符串没有闭合', start);
      tokens.push({ type: 'string', value, position: start });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < source.length && /[0-9.]/.test(source[i])) i += 1;
      const raw = source.slice(start, i);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new LexError(`无法解析的数字：${raw}`, start);
      tokens.push({ type: 'number', value, position: start });
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_PART.test(source[i])) i += 1;
      tokens.push({ type: 'ident', value: source.slice(start, i), position: start });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (OPERATORS.includes(two)) {
      tokens.push({ type: 'op', value: two, position: i });
      i += 2;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push({ type: 'op', value: ch, position: i });
      i += 1;
      continue;
    }

    throw new LexError(`表达式里出现不允许的字符：${ch}`, i);
  }
  return tokens;
}

export function createTokenStream(tokens) {
  let index = 0;
  return {
    peek() {
      return tokens[index];
    },
    next() {
      const token = tokens[index];
      index += 1;
      return token;
    },
    get position() {
      return index;
    },
    get length() {
      return tokens.length;
    },
  };
}
