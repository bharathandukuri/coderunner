/**
 * Splits a MySQL script into individual executable statements.
 * Handles:
 * - DELIMITER commands (e.g. DELIMITER //, DELIMITER ;)
 * - Single-quoted strings ('...') with \' and ''
 * - Double-quoted strings ("...") with \" and ""
 * - Backtick identifiers (`...`) with ``
 * - Line comments: -- with trailing whitespace, and #
 * - Block comments: /* ... * /
 * - Dynamic delimiters outside of quotes/comments
 */
function splitMySQLStatements(sql) {
  if (!sql || !sql.trim()) return [];

  const statements = [];
  let currentDelimiter = ';';
  let buffer = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    // Check for DELIMITER command at start of line or statement
    if (buffer.trim() === '') {
      const rest = sql.slice(i);
      const delimMatch = rest.match(/^[ \t]*DELIMITER\s+([^ \t\r\n]+)[ \t]*(?:\r?\n|$)/i);
      if (delimMatch) {
        currentDelimiter = delimMatch[1];
        i += delimMatch[0].length;
        continue;
      }
    }

    const ch = sql[i];
    const nextCh = i + 1 < len ? sql[i + 1] : '';

    // 1. Line comment: -- with trailing whitespace or #
    const isDashComment = ch === '-' && nextCh === '-' && (i + 2 >= len || sql[i + 2] === ' ' || sql[i + 2] === '\t' || sql[i + 2] === '\r' || sql[i + 2] === '\n');
    const isHashComment = ch === '#';
    if (isDashComment || isHashComment) {
      let end = sql.indexOf('\n', i + (isDashComment ? 3 : 1));
      if (end === -1) end = len;
      buffer += sql.slice(i, end);
      i = end;
      continue;
    }

    // 2. Block comment: /* ... */
    if (ch === '/' && nextCh === '*') {
      const closeIdx = sql.indexOf('*/', i + 2);
      if (closeIdx !== -1) {
        const end = closeIdx + 2;
        buffer += sql.slice(i, end);
        i = end;
        continue;
      }
    }

    // 3. Single-quoted strings ('...')
    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === '\\' && i + 1 < len) {
          i += 2; // escape sequence
        } else if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // doubled quote
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

    // 4. Double-quoted strings ("...")
    if (ch === '"') {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === '\\' && i + 1 < len) {
          i += 2;
        } else if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
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

    // 5. Backtick identifiers (`...`)
    if (ch === '`') {
      const start = i;
      i++;
      while (i < len) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            i += 2;
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

    // 6. Check delimiter
    if (sql.startsWith(currentDelimiter, i)) {
      const trimmed = buffer.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      buffer = '';
      i += currentDelimiter.length;
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

module.exports = { splitMySQLStatements };

