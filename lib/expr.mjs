/**
 * A small, safe expression evaluator for ontology rule expressions.
 *
 * Rules are data, not code: `availableQty < safetyStock && leadTime < 3`. This
 * module parses that grammar directly — no `eval`, no `Function`, no property
 * access beyond dotted identifiers, no calls, no assignment. Anything outside
 * the grammar is a parse error, so an asset file cannot smuggle executable code
 * into the Host.
 *
 * Grammar (precedence low → high):
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | compare
 *   compare := sum ( ('<'|'<='|'>'|'>='|'=='|'!=') sum )?
 *            | sum 'between' sum 'and' sum
 *   sum     := product ( ('+'|'-') product )*
 *   product := neg ( ('*'|'/') neg )*
 *   neg     := '-' neg | primary
 *   primary := number | string | true | false | null | identifier | '(' or ')'
 */
import { createTokenStream, tokenize } from './expr-lexer.mjs';

class ParseError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'ParseError';
    this.position = position;
  }
}

const COMPARATORS = new Set(['<', '<=', '>', '>=', '==', '!=']);

function toNumber(value, what) {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = Number(value);
  if (Number.isNaN(n)) throw new TypeError(`${what} 不是数字：${JSON.stringify(value)}`);
  return n;
}

function compare(op, left, right) {
  const numeric = (typeof left === 'number' && typeof right === 'number') || (typeof left === 'number' && typeof right === 'boolean') || (typeof left === 'boolean' && typeof right === 'number');
  let a = left;
  let b = right;
  if (numeric || op !== '==' && op !== '!=') {
    if (typeof a !== 'string' || typeof b !== 'string') {
      a = toNumber(left, '左操作数');
      b = toNumber(right, '右操作数');
    }
  }
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '==':
      return a === b || (typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b) && typeof a === typeof b);
    case '!=':
      return !(a === b || (typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b) && typeof a === typeof b));
    default:
      throw new ParseError(`未知比较运算符：${op}`);
  }
}

/**
 * Parse an expression into an AST. Throws ParseError with a position.
 * @param {string} source
 */
export function parse(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new ParseError('表达式为空');
  }
  const stream = createTokenStream(tokenize(source));

  const peek = () => stream.peek();
  const next = () => stream.next();
  const isKeyword = (token, word) => token && token.type === 'ident' && token.value === word;
  const isOp = (token, op) => token && token.type === 'op' && token.value === op;

  function parseOr() {
    let node = parseAnd();
    while (isOp(peek(), '||')) {
      next();
      node = { type: 'logical', op: '||', left: node, right: parseAnd() };
    }
    return node;
  }

  function parseAnd() {
    let node = parseUnary();
    while (isOp(peek(), '&&')) {
      next();
      node = { type: 'logical', op: '&&', left: node, right: parseUnary() };
    }
    return node;
  }

  function parseUnary() {
    if (isOp(peek(), '!')) {
      next();
      return { type: 'not', operand: parseUnary() };
    }
    return parseCompare();
  }

  function parseCompare() {
    const left = parseSum();
    const token = peek();
    if (token && token.type === 'op' && COMPARATORS.has(token.value)) {
      next();
      return { type: 'compare', op: token.value, left, right: parseSum() };
    }
    if (isKeyword(token, 'between')) {
      next();
      const low = parseSum();
      if (!isKeyword(peek(), 'and')) {
        throw new ParseError('between 需要 and 连接上下界', peek() ? peek().position : source.length);
      }
      next();
      const high = parseSum();
      return { type: 'between', value: left, low, high };
    }
    return left;
  }

  function parseSum() {
    let node = parseProduct();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      node = { type: 'binary', op, left: node, right: parseProduct() };
    }
    return node;
  }

  function parseProduct() {
    let node = parseNeg();
    while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = next().value;
      node = { type: 'binary', op, left: node, right: parseNeg() };
    }
    return node;
  }

  function parseNeg() {
    if (isOp(peek(), '-')) {
      next();
      return { type: 'negate', operand: parseNeg() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = next();
    if (!token) throw new ParseError('表达式意外结束', source.length);
    if (token.type === 'number') return { type: 'literal', value: token.value };
    if (token.type === 'string') return { type: 'literal', value: token.value };
    if (token.type === 'ident') {
      if (token.value === 'true') return { type: 'literal', value: true };
      if (token.value === 'false') return { type: 'literal', value: false };
      if (token.value === 'null') return { type: 'literal', value: null };
      if (token.value === 'and' || token.value === 'or' || token.value === 'not' || token.value === 'between') {
        throw new ParseError(`保留字不能作为标识符：${token.value}`, token.position);
      }
      return { type: 'identifier', name: token.value };
    }
    if (isOp(token, '(')) {
      const node = parseOr();
      const close = next();
      if (!isOp(close, ')')) throw new ParseError('缺少右括号', close ? close.position : source.length);
      return node;
    }
    throw new ParseError(`无法解析的记号：${token.value}`, token.position);
  }

  const ast = parseOr();
  const rest = peek();
  if (rest) throw new ParseError(`表达式有未消费的内容：${rest.value}`, rest.position);
  return ast;
}

/** Collect every identifier an AST reads, in first-appearance order. */
export function identifiersOf(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case 'identifier':
      if (!out.includes(node.name)) out.push(node.name);
      break;
    case 'not':
    case 'negate':
      identifiersOf(node.operand, out);
      break;
    case 'logical':
    case 'compare':
    case 'binary':
      identifiersOf(node.left, out);
      identifiersOf(node.right, out);
      break;
    case 'between':
      identifiersOf(node.value, out);
      identifiersOf(node.low, out);
      identifiersOf(node.high, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Evaluate an AST against a fact bag.
 * Missing identifiers throw `UnknownIdentifierError` so a caller can report
 * "this rule does not apply here" instead of silently evaluating to false.
 */
export class UnknownIdentifierError extends Error {
  constructor(name) {
    super(`未知标识符：${name}`);
    this.name = 'UnknownIdentifierError';
    this.identifier = name;
  }
}

export function evaluate(node, facts) {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'identifier':
      if (!facts || !Object.prototype.hasOwnProperty.call(facts, node.name)) {
        throw new UnknownIdentifierError(node.name);
      }
      return facts[node.name];
    case 'not':
      return !evaluate(node.operand, facts);
    case 'negate':
      return -toNumber(evaluate(node.operand, facts), '取负操作数');
    case 'logical': {
      const left = evaluate(node.left, facts);
      if (node.op === '&&') return left ? evaluate(node.right, facts) : left;
      return left ? left : evaluate(node.right, facts);
    }
    case 'compare':
      return compare(node.op, evaluate(node.left, facts), evaluate(node.right, facts));
    case 'between': {
      const value = toNumber(evaluate(node.value, facts), 'between 主体');
      const low = toNumber(evaluate(node.low, facts), 'between 下界');
      const high = toNumber(evaluate(node.high, facts), 'between 上界');
      return value >= low && value <= high;
    }
    case 'binary': {
      const left = toNumber(evaluate(node.left, facts), '左操作数');
      const right = toNumber(evaluate(node.right, facts), '右操作数');
      if (node.op === '+') return left + right;
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      if (node.op === '/') {
        if (right === 0) throw new RangeError('除数为零');
        return left / right;
      }
      throw new ParseError(`未知运算符：${node.op}`);
    }
    default:
      throw new ParseError(`未知节点类型：${node.type}`);
  }
}

/**
 * Convenience: parse + evaluate. `identifiers` lets a caller pre-check which
 * names the expression needs before deciding it applies to a record set.
 */
export function evaluateExpression(source, facts) {
  return evaluate(parse(source), facts);
}

export { ParseError };
