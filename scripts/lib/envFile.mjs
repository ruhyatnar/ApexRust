// Pure .env parsing / rendering that preserves the template's comments and key order.

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const COMMENTED_KEY_LINE = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"(?:\s*(?:#.*)?)?$/.exec(value);
    if (m) {
      // Single-pass unescape so `\\n` decodes to `\n` (literal backslash + n), never `<newline>`
      return m[1].replace(/\\([rn"\\])/g, (_, ch) => {
        if (ch === 'r') return '\r';
        if (ch === 'n') return '\n';
        return ch;
      });
    }
  }
  if (value.startsWith("'")) {
    const m = /^'([^']*)'(?:\s*(?:#.*)?)?$/.exec(value);
    if (m) return m[1];
  }
  // Strip trailing inline comment on unquoted values (`KEY=value # note`)
  const hashIdx = value.search(/\s#/);
  return (hashIdx >= 0 ? value.slice(0, hashIdx) : value).trim();
}

/** Parse dotenv text into a plain object (later keys win, like dotenv). */
export function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = KEY_LINE.exec(line);
    if (match) out[match[1]] = unquote(match[2]);
  }
  return out;
}

/** Quote values only when needed so dotenv parses them back identically. */
export function formatEnvValue(value) {
  const str = value === undefined || value === null ? '' : String(value);
  if (str === '') return '';
  if (/[\s#"'=\\\r]/.test(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
  }
  return str;
}

/**
 * Render `values` onto `template` text:
 * - active `KEY=` lines are replaced when the key is present in `values`
 * - commented `# KEY=` lines are uncommented only when `values[KEY]` is a non-empty string
 * - keys missing from the template are appended at the end
 */
export function renderEnv(template, values) {
  const used = new Set();
  const lines = String(template ?? '').split(/\r?\n/).map((line) => {
    const active = KEY_LINE.exec(line);
    if (active && !line.trim().startsWith('#')) {
      const key = active[1];
      if (Object.prototype.hasOwnProperty.call(values, key)) {
        used.add(key);
        return `${key}=${formatEnvValue(values[key])}`;
      }
      return line;
    }
    const commented = COMMENTED_KEY_LINE.exec(line);
    if (commented) {
      const key = commented[1];
      const val = values[key];
      if (typeof val === 'string' && val !== '') {
        used.add(key);
        return `${key}=${formatEnvValue(val)}`;
      }
      if (Object.prototype.hasOwnProperty.call(values, key)) used.add(key);
    }
    return line;
  });

  const extras = Object.keys(values).filter(
    (k) => !used.has(k) && values[k] !== undefined && values[k] !== null && values[k] !== ''
  );
  if (extras.length > 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push('', '# --- Additional settings ---');
    for (const key of extras) lines.push(`${key}=${formatEnvValue(values[key])}`);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}
