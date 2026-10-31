const mysql = require('mysql2/promise');
const fs = require('fs');

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB limit
const OVERFLOW_MARKER = '\n[Output limit of 1MB exceeded]\n';

function capOutput(output) {
  if (Buffer.byteLength(output, 'utf8') <= MAX_OUTPUT_BYTES) {
    return output;
  }
  const maxContentBytes = MAX_OUTPUT_BYTES - Buffer.byteLength(OVERFLOW_MARKER, 'utf8');
  const buf = Buffer.from(output, 'utf8').subarray(0, maxContentBytes);
  return buf.toString('utf8') + OVERFLOW_MARKER;
}

function formatTable(colNames, rows) {
  if (!colNames || colNames.length === 0) return '';

  const colWidths = colNames.map(name => (name ? String(name).length : 0));

  const stringRows = rows.map(row => {
    return colNames.map((_, idx) => {
      const val = row[idx];
      let strVal = (val === null || val === undefined) ? 'NULL' : (val instanceof Date ? val.toISOString() : String(val));
      if (strVal.length > 50) {
        strVal = strVal.slice(0, 50); // Consistent cell truncation
      }
      if (strVal.length > colWidths[idx]) {
        colWidths[idx] = strVal.length;
      }
      return strVal;
    });
  });

  const header = colNames.map((col, idx) => String(col).padEnd(colWidths[idx])).join('  ');
  const separator = colWidths.map(w => '-'.repeat(Math.max(w, 1))).join('  ');
  let table = header + '\n' + separator + '\n';

  for (const row of stringRows) {
    const rowStr = row.map((cell, idx) => cell.padEnd(colWidths[idx])).join('  ');
    table += rowStr + '\n';
  }

  return table;
}

/**
 * Split MySQL script into discrete statements, supporting DELIMITER directives,
 * stored procedures, functions, triggers, and string/comment literals.
 */
function splitStatements(sql) {
  const statements = [];
  let currentDelimiter = ';';
  let buffer = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let inBlockComment = false;

  const lines = sql.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inBlockComment) {
      const match = trimmed.match(/^DELIMITER\s+(.+)$/i);
      if (match) {
        if (buffer.trim()) {
          statements.push(buffer.trim());
          buffer = '';
        }
        currentDelimiter = match[1].trim();
        continue;
      }
    }

    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      const nextCh = line[i + 1] || '';

      if (inBlockComment) {
        if (ch === '*' && nextCh === '/') {
          inBlockComment = false;
          buffer += '*/';
          i += 2;
          continue;
        }
        buffer += ch;
        i++;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
        if (ch === '/' && nextCh === '*') {
          inBlockComment = true;
          buffer += '/*';
          i += 2;
          continue;
        }
        if ((ch === '-' && nextCh === '-' && (line[i + 2] === ' ' || line[i + 2] === '\t' || i + 2 >= line.length)) || ch === '#') {
          buffer += line.slice(i);
          break;
        }
      }

      if (ch === '\\' && (inSingleQuote || inDoubleQuote)) {
        buffer += ch + nextCh;
        i += 2;
        continue;
      }

      if (ch === "'" && !inDoubleQuote && !inBacktick) {
        inSingleQuote = !inSingleQuote;
        buffer += ch;
        i++;
        continue;
      }

      if (ch === '"' && !inSingleQuote && !inBacktick) {
        inDoubleQuote = !inDoubleQuote;
        buffer += ch;
        i++;
        continue;
      }

      if (ch === '`' && !inSingleQuote && !inDoubleQuote) {
        inBacktick = !inBacktick;
        buffer += ch;
        i++;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
        if (line.startsWith(currentDelimiter, i)) {
          const stmt = buffer.trim();
          if (stmt) {
            statements.push(stmt);
          }
          buffer = '';
          i += currentDelimiter.length;
          continue;
        }
      }

      buffer += ch;
      i++;
    }

    buffer += '\n';
  }

  if (buffer.trim()) {
    statements.push(buffer.trim());
  }

  return statements;
}

function processResult(rawResults, rawFields) {
  let out = '';
  const isMulti = Array.isArray(rawResults) && (
    (rawResults.length > 0 && rawResults[0]?.constructor?.name === 'ResultSetHeader') ||
    (Array.isArray(rawFields) && rawFields.length > 0 && Array.isArray(rawFields[0]))
  );

  if (isMulti) {
    for (let i = 0; i < rawResults.length; i++) {
      const stmtResult = rawResults[i];
      const stmtFields = rawFields ? rawFields[i] : null;

      if (Array.isArray(stmtResult)) {
        const colNames = (stmtFields || []).map(f => f.name);
        out += formatTable(colNames, stmtResult);
      } else if (stmtResult && stmtResult.affectedRows !== undefined) {
        out += `Query OK, ${stmtResult.affectedRows} row${stmtResult.affectedRows === 1 ? '' : 's'} affected\n`;
      }
    }
  } else {
    if (Array.isArray(rawResults)) {
      const colNames = (rawFields || []).map(f => f.name);
      out += formatTable(colNames, rawResults);
    } else if (rawResults && rawResults.affectedRows !== undefined) {
      out += `Query OK, ${rawResults.affectedRows} row${rawResults.affectedRows === 1 ? '' : 's'} affected\n`;
    }
  }
  return out;
}

async function main() {
  const filePath = process.argv[2];
  const timeoutSecs = parseFloat(process.argv[3]) || 5;

  if (!filePath || !fs.existsSync(filePath)) {
    process.stderr.write(`Error: SQL file not found: ${filePath}\n`, () => {
      process.exit(1);
    });
    return;
  }

  const sql = fs.readFileSync(filePath, 'utf-8');
  if (!sql.trim()) {
    process.exit(0);
  }

  const timeoutMs = Math.max(Math.floor(timeoutSecs * 1000), 500);

  // Host/runner wall-clock watchdog (exit code 124 on timeout)
  const wallTimer = setTimeout(() => {
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124);
    });
  }, timeoutMs);

  let connection = null;

  try {
    try {
      connection = await mysql.createConnection({
        user: 'runner',
        password: process.env.DB_PASSWORD || 'coderunner_runner_secret',
        database: process.env.DB_NAME || 'coderunner',
        socketPath: '/box/socket/mysqld.sock',
        multipleStatements: true,
        rowsAsArray: true,
        connectTimeout: 1500,
        dateStrings: true,
      });
    } catch {
      connection = await mysql.createConnection({
        user: 'runner',
        password: process.env.DB_PASSWORD || 'coderunner_runner_secret',
        database: process.env.DB_NAME || 'coderunner',
        socketPath: '/box/socket/mysqld.sock',
        multipleStatements: true,
        rowsAsArray: true,
        connectTimeout: 3000,
        dateStrings: true,
      });
    }

    // Set MySQL execution timeout for SELECT statements
    await connection.query(`SET SESSION max_execution_time = ${timeoutMs};`);

    let output = '';
    const hasDelimiter = /\bDELIMITER\s+/i.test(sql);

    if (hasDelimiter) {
      const statements = splitStatements(sql);
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        const [rawResults, rawFields] = await connection.query({ sql: stmt, rowsAsArray: true });
        output += processResult(rawResults, rawFields);

        if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
          break;
        }
      }
    } else {
      const [rawResults, rawFields] = await connection.query({ sql, rowsAsArray: true });
      output = processResult(rawResults, rawFields);
    }

    clearTimeout(wallTimer);
    output = capOutput(output);
    await connection.end().catch(() => {});
    process.stdout.write(output, () => {
      process.exit(0);
    });
  } catch (err) {
    clearTimeout(wallTimer);
    if (connection) {
      await connection.end().catch(() => {});
    }

    // ER_QUERY_TIMEOUT (code 3024) or ER_STATEMENT_TIMEOUT (code 1907)
    if (err.errno === 3024 || err.errno === 1907 || err.code === 'PROTOCOL_TIMEOUT' || err.message?.includes('exceeded')) {
      process.stderr.write('canceling statement due to statement timeout\n', () => {
        process.exit(124);
      });
      return;
    }

    process.stderr.write(`ERROR: ${err.message}\n`, () => {
      process.exit(1);
    });
  }
}

main();
