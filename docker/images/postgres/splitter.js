/**
 * Splits a PostgreSQL script into individual executable statements.
 * Handles:
 * - Single-quoted string literals with '' escapes and E'...' C-style escapes
 * - Double-quoted identifiers ("col;name", "")
 * - Dollar quoting ($tag$...$tag$, $$...$$)
 * - Line comments (-- comment to newline)
 * - Block comments with nesting support (slash-star ... star-slash)
 * - Semicolons outside of quotes/comments as statement boundaries
 */
function splitPostgresStatements(sql) {
  if (!sql || !sql.trim()) return [];

  const statements = [];
  let buffer = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const nextCh = i + 1 < len ? sql[i + 1] : '';

    // 1. Line comment: -- to newline
    if (ch === '-' && nextCh === '-') {
      let end = sql.indexOf('\n', i + 2);
      if (end === -1) end = len;
      buffer += sql.slice(i, end);
      i = end;
      continue;
    }

    // 2. Block comment with nesting: /* ... /* ... */ ... */
    if (ch === '/' && nextCh === '*') {
      let depth = 1;
      let start = i;
      i += 2;
      while (i < len && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // 3. Dollar quoting: $tag$...$tag$ or $$...$$
    if (ch === '$') {
      const match = sql.slice(i).match(/^\$([a-zA-Z0-9_]*)\$/);
      if (match) {
        const tag = match[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        if (closeIdx !== -1) {
          const end = closeIdx + tag.length;
          buffer += sql.slice(i, end);
          i = end;
          continue;
        }
      }
    }

    // 4. Single-quoted string (including E'...' escapes and '' escapes)
    const isEscapeString = (ch === 'E' || ch === 'e') && nextCh === "'";
    if (ch === "'" || isEscapeString) {
      const start = i;
      if (isEscapeString) {
        i += 2; // skip E'
      } else {
        i += 1; // skip '
      }

      while (i < len) {
        if (isEscapeString && sql[i] === '\\' && i + 1 < len) {
          i += 2; // skip escaped char
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // '' doubled quote escape
          } else {
            i += 1; // closing quote
            break;
          }
        } else {
          i++;
        }
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // 5. Double-quoted identifiers ("...")
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2; // "" doubled quote escape
          } else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      buffer += sql.slice(start, i);
      continue;
    }

    // 6. Statement delimiter ';'
    if (ch === ';') {
      const trimmed = buffer.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      buffer = '';
      i++;
      continue;
    }

    buffer += ch;
    i++;
  }

  const trailing = buffer.trim();
  if (trailing) {
    statements.push(trailing);
  }

  return statements;
}

module.exports = { splitPostgresStatements };
