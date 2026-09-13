// A bounded data reader for the monitor's serialized arrays. This deliberately
// does not execute JavaScript: calls, member access and arbitrary expressions
// are rejected, even when they appear inside an otherwise valid record.
export function hydrationArrays(source: string, names: string[]): Map<string, unknown[]> {
  const arrays = new Map<string, unknown[]>();
  const references = new Map<string, unknown>();
  let cursor = 0, values = 0;
  const invalid = (): never => { throw new Error("monitor-schema-changed"); };
  const whitespace = () => { while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++; };
  const take = (pattern: RegExp): string | undefined => {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) return undefined;
    cursor = pattern.lastIndex;
    return match[0];
  };
  const string = () => {
    const literal = take(/"(?:[^"\\]|\\.)*"/y);
    if (!literal) return invalid();
    try {
      return JSON.parse(literal.replace(/\\(?:x([0-9a-f]{2})|.)/gi,
        (match, hex) => hex ? `\\u00${hex}` : match)) as string;
    } catch { return invalid(); }
  };
  function read(depth = 0): unknown {
    if (depth > 32 || ++values > 100_000) return invalid();
    whitespace();
    const reference = take(/\$R\[\d+\]/y);
    if (reference) {
      whitespace();
      if (source[cursor] === "=") {
        cursor++;
        const value = read(depth + 1);
        references.set(reference, value);
        return value;
      }
      return references.has(reference) ? references.get(reference) : invalid();
    }
    const char = source[cursor];
    if (char === '"') return string();
    if (char === "[" || char === "{") {
      cursor++;
      const array: unknown[] = [], object: Record<string, unknown> = Object.create(null);
      const end = char === "[" ? "]" : "}";
      whitespace();
      while (source[cursor] !== end) {
        if (char === "[") array.push(read(depth + 1));
        else {
          const key = source[cursor] === '"' ? string() : take(/[a-zA-Z_$][\w$]*/y);
          whitespace();
          if (key === undefined || source[cursor++] !== ":") return invalid();
          object[key] = read(depth + 1);
        }
        whitespace();
        if (source[cursor] === end) break;
        if (source[cursor++] !== ",") return invalid();
        whitespace();
      }
      cursor++;
      return char === "[" ? array : object;
    }
    const primitive = take(/(?:null|true|false|!0|!1|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/iy);
    if (primitive === undefined) return invalid();
    if (primitive === "null") return null;
    if (primitive === "!0" || primitive === "true") return true;
    if (primitive === "!1" || primitive === "false") return false;
    return Number(primitive);
  }
  // Skip quoted strings while finding fields, so post text cannot impersonate
  // another array. Consume each array fully, including empty collections.
  const fields = /"(?:[^"\\]|\\.)*"|\b([a-zA-Z]+):/g;
  let match: RegExpExecArray | null;
  while ((match = fields.exec(source))) {
    const name = match[1];
    if (!name || !names.includes(name)) continue;
    cursor = fields.lastIndex;
    const value = read();
    if (!Array.isArray(value)) return invalid();
    arrays.set(name, value);
    fields.lastIndex = cursor;
  }
  return arrays;
}
