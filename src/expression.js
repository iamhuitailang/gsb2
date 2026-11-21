/**
 * 轻量条件表达式引擎。
 * 不依赖 eval：先词法/语法分析成 AST，再在受控变量表上求值。
 * 支持：数字、字符串、布尔、变量、括号、! - * / % + - < <= > >= == != && ||，
 * 以及中文/英文标识符（如 信任、hasTicket）。
 */

export class ExpressionError extends Error {
  constructor(message, position = 0) {
    super(message);
    this.name = 'ExpressionError';
    this.position = position;
  }
}

const ID_START = /[A-Za-z_一-鿿]/;
const ID_PART = /[A-Za-z0-9_一-鿿]/;
const NUMBER = /[0-9]/;

const KEYWORDS = {
  true: { type: 'literal', value: true },
  false: { type: 'literal', value: false },
  and: { type: 'op', value: '&&' },
  or: { type: 'op', value: '||' },
  not: { type: 'op', value: '!' },
};

const TWO_CHAR_OPS = new Set(['&&', '||', '==', '!=', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['!', '<', '>', '+', '-', '*', '/', '%', '(', ')']);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (NUMBER.test(ch) || (ch === '.' && NUMBER.test(source[i + 1] || ''))) {
      let start = i;
      let sawDot = false;
      while (i < source.length && (NUMBER.test(source[i]) || (source[i] === '.' && !sawDot))) {
        if (source[i] === '.') sawDot = true;
        i += 1;
      }
      const raw = source.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ExpressionError(`数字不合法：${raw}`, start);
      tokens.push({ type: 'number', value, position: start, raw });
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
          const next = source[i + 1];
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === undefined) throw new ExpressionError('字符串未结束', start);
          else value += next;
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
      if (!closed) throw new ExpressionError('字符串未结束', start);
      tokens.push({ type: 'string', value, position: start });
      continue;
    }
    if (ID_START.test(ch)) {
      const start = i;
      while (i < source.length && ID_PART.test(source[i])) i += 1;
      const raw = source.slice(start, i);
      const keyword = KEYWORDS[raw];
      if (keyword) {
        tokens.push({ ...keyword, position: start, raw });
      } else {
        tokens.push({ type: 'identifier', value: raw, position: start });
      }
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, position: i });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ type: 'op', value: ch, position: i });
      i += 1;
      continue;
    }
    throw new ExpressionError(`无法识别的字符「${ch}」`, i);
  }
  tokens.push({ type: 'eof', value: '', position: source.length });
  return tokens;
}

export function parse(source) {
  const tokens = tokenize(source);
  let index = 0;
  const identifiers = new Set();

  const peek = () => tokens[index];
  const next = () => tokens[index++];
  const expectOp = (op) => {
    const token = peek();
    if (token.type === 'op' && token.value === op) {
      next();
      return true;
    }
    return false;
  };

  function parseOr() {
    let left = parseAnd();
    while (peek().type === 'op' && peek().value === '||') {
      const token = next();
      left = { type: 'binary', op: '||', left, right: parseAnd(), position: token.position };
    }
    return left;
  }
  function parseAnd() {
    let left = parseEquality();
    while (peek().type === 'op' && peek().value === '&&') {
      const token = next();
      left = { type: 'binary', op: '&&', left, right: parseEquality(), position: token.position };
    }
    return left;
  }
  function parseEquality() {
    let left = parseRelational();
    while (peek().type === 'op' && (peek().value === '==' || peek().value === '!=')) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseRelational(), position: token.position };
    }
    return left;
  }
  function parseRelational() {
    let left = parseAdditive();
    while (peek().type === 'op' && ['<', '<=', '>', '>='].includes(peek().value)) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseAdditive(), position: token.position };
    }
    return left;
  }
  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseMultiplicative(), position: token.position };
    }
    return left;
  }
  function parseMultiplicative() {
    let left = parseUnary();
    while (peek().type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const token = next();
      left = { type: 'binary', op: token.value, left, right: parseUnary(), position: token.position };
    }
    return left;
  }
  function parseUnary() {
    const token = peek();
    if (token.type === 'op' && (token.value === '!' || token.value === '-')) {
      next();
      return { type: 'unary', op: token.value, arg: parseUnary(), position: token.position };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const token = peek();
    if (token.type === 'number' || token.type === 'string' || token.type === 'literal') {
      next();
      return { type: 'literal', value: token.value, position: token.position };
    }
    if (token.type === 'identifier') {
      next();
      identifiers.add(token.value);
      return { type: 'variable', name: token.value, position: token.position };
    }
    if (token.type === 'op' && token.value === '(') {
      next();
      const expr = parseOr();
      if (!expectOp(')')) throw new ExpressionError('缺少右括号', peek().position);
      return expr;
    }
    if (token.type === 'eof') throw new ExpressionError('条件不完整', token.position);
    throw new ExpressionError(`此处不应出现「${token.raw ?? token.value}」`, token.position);
  }

  const ast = parseOr();
  const trailing = peek();
  if (trailing.type !== 'eof') {
    throw new ExpressionError(`多余的内容「${trailing.raw ?? trailing.value}」`, trailing.position);
  }
  return { ast, identifiers };
}

/**
 * 编译条件；空条件等价于 true。
 * 返回 { ok, ast, identifiers, error }。
 */
export function compileCondition(source) {
  const raw = String(source ?? '').trim();
  if (!raw) {
    return { ok: true, ast: { type: 'literal', value: true }, identifiers: new Set(), source: raw };
  }
  try {
    const { ast, identifiers } = parse(raw);
    return { ok: true, ast, identifiers, source: raw };
  } catch (error) {
    return {
      ok: false,
      ast: null,
      identifiers: new Set(),
      source: raw,
      error: error instanceof ExpressionError ? error.message : String(error),
      position: error.position ?? 0,
    };
  }
}

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  return Boolean(value);
}

export function evaluateAst(ast, variables) {
  switch (ast.type) {
    case 'literal':
      return ast.value;
    case 'variable': {
      if (!Object.prototype.hasOwnProperty.call(variables, ast.name)) {
        const error = new ExpressionError(`变量「${ast.name}」未设置`, ast.position);
        error.code = 'UNKNOWN_VARIABLE';
        error.variable = ast.name;
        throw error;
      }
      return variables[ast.name];
    }
    case 'unary': {
      const value = evaluateAst(ast.arg, variables);
      if (ast.op === '!') return !truthy(value);
      if (typeof value !== 'number') throw new ExpressionError('一元负号只能作用于数字', ast.position);
      return -value;
    }
    case 'binary': {
      const { op } = ast;
      if (op === '&&') return truthy(evaluateAst(ast.left, variables)) && truthy(evaluateAst(ast.right, variables));
      if (op === '||') return truthy(evaluateAst(ast.left, variables)) || truthy(evaluateAst(ast.right, variables));
      const left = evaluateAst(ast.left, variables);
      const right = evaluateAst(ast.right, variables);
      switch (op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '+':
          if (typeof left === 'string' || typeof right === 'string') return String(left) + String(right);
          return numeric(left, ast) + numeric(right, ast);
        case '-':
          return numeric(left, ast) - numeric(right, ast);
        case '*':
          return numeric(left, ast) * numeric(right, ast);
        case '/': {
          const divisor = numeric(right, ast);
          if (divisor === 0) throw new ExpressionError('除数不能为 0', ast.position);
          return numeric(left, ast) / divisor;
        }
        case '%': {
          const divisor = numeric(right, ast);
          if (divisor === 0) throw new ExpressionError('除数不能为 0', ast.position);
          return numeric(left, ast) % divisor;
        }
        default:
          throw new ExpressionError(`不支持的运算符「${op}」`, ast.position);
      }
    }
    default:
      throw new ExpressionError('表达式节点不合法', 0);
  }
}

function numeric(value, ast) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ExpressionError('算术运算需要数字', ast.position);
  }
  return value;
}

export function evaluateConditionSource(source, variables) {
  const compiled = compileCondition(source);
  if (!compiled.ok) {
    const error = new ExpressionError(compiled.error, compiled.position);
    error.code = 'PARSE_ERROR';
    throw error;
  }
  return truthy(evaluateAst(compiled.ast, variables));
}

/** 求值并给出安全的失败信息，供编辑器/运行时使用。 */
export function checkCondition(source, variables) {
  try {
    return { ok: true, value: evaluateConditionSource(source, variables) };
  } catch (error) {
    return {
      ok: false,
      value: false,
      error: error.message,
      code: error.code || 'EVAL_ERROR',
      variable: error.variable,
      position: error.position,
    };
  }
}
