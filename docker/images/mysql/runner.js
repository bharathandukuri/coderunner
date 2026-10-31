const mysql = require('mysql2/promise');
const fs = require('fs');
const { splitMySQLStatements } = require('./splitter.js');

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

/**
 * Format table matching output contract:
 * - Header always printed, even for 0 rows
 * - NULL printed as NULL
 * - Values printed exactly as returned (no 50-char cell truncation, D1)
 * - Space padding between columns
 */
function formatTable(colNames, rows) {
  if (!colNames || colNames.length === 0) return '';

  const colWidths = colNames.map(name => (name ? String(name).length : 0));

  const stringRows = (rows || []).map(row => {
    return colNames.map((_, idx) => {
      const val = row[idx];
      const strVal = (val === null || val === undefined) ? 'NULL' : String(val);
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
 * Execute a SELECT-like statement using streaming query to bound memory consumption (D5)
 */
async function executeStreamingQuery(connection, stmt) {
  return new Promise((resolve, reject) => {
    let colNames = null;
    const collectedRows = [];
    let approxBytes = 0;
    let hitLimit = false;

    // Use underlying connection for streaming query
    const rawConn = connection.connection || connection;
    const query = rawConn.query({
      sql: stmt,
      rowsAsArray: true,
    });

    const stream = query.stream({ highWaterMark: 128 });

    stream.on('fields', (fields) => {
      if (fields && fields.length > 0) {
        colNames = fields.map(f => f.name);
      }
    });

    stream.on('data', (row) => {
      if (hitLimit) return;

      collectedRows.push(row);
      for (const cell of (Array.isArray(row) ? row : [])) {
        approxBytes += cell != null ? String(cell).length : 4;
      }

      if (approxBytes >= MAX_OUTPUT_BYTES) {
        hitLimit = true;
        stream.destroy();
        resolve(formatTable(colNames || [], collectedRows));
      }
    });

    stream.on('end', () => {
      if (!hitLimit) {
        resolve(formatTable(colNames || [], collectedRows));
      }
    });

    stream.on('error', (err) => {
      if (hitLimit) return;
      reject(err);
    });
  });
}

/**
 * Execute a single statement and return its formatted text output
 */
async function executeSingleStatement(connection, stmt) {
  const trimmed = stmt.trim();
  const isSelectLike = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(trimmed);

  if (isSelectLike) {
    try {
      return await executeStreamingQuery(connection, stmt);
    } catch (err) {
      // Fallback to standard query if streaming fails on custom syntax
    }
  }

  const [rawResults, rawFields] = await connection.query({ sql: stmt, rowsAsArray: true });

  if (Array.isArray(rawResults)) {
    const colNames = (rawFields || []).map(f => f.name);
    return formatTable(colNames, rawResults);
  } else if (rawResults && rawResults.affectedRows !== undefined) {
    return `Query OK, ${rawResults.affectedRows} row${rawResults.affectedRows === 1 ? '' : 's'} affected\n`;
  }

  return '';
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

  // Host/runner wall-clock watchdog (exit code 124 on timeout) (D6)
  const wallTimer = setTimeout(() => {
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124);
    });
  }, timeoutMs);

  let connection = null;
  const connectionConfig = {
    user: 'runner',
    password: process.env.DB_PASSWORD || 'coderunner_runner_secret',
    database: process.env.DB_NAME || 'coderunner',
    socketPath: '/box/socket/mysqld.sock',
    multipleStatements: false,
    rowsAsArray: true,
    connectTimeout: 1500,
    // D3: big numbers, big number strings, date strings, and raw typeCast
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    typeCast: function (field, next) {
      if (['JSON', 'BLOB', 'BIT', 'DECIMAL', 'NEWDECIMAL', 'GEOMETRY', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB'].includes(field.type)) {
        return field.string();
      }
      return next();
    },
  };

  try {
    try {
      connection = await mysql.createConnection(connectionConfig);
    } catch {
      connectionConfig.connectTimeout = 3000;
      connection = await mysql.createConnection(connectionConfig);
    }

    // Set MySQL execution timeout for SELECT statements
    await connection.query(`SET SESSION max_execution_time = ${timeoutMs};`);

    // D4: Sequential statement execution via splitMySQLStatements
    const statements = splitMySQLStatements(sql);
    let output = '';

    for (const stmt of statements) {
      if (!stmt.trim()) continue;

      try {
        const stmtOutput = await executeSingleStatement(connection, stmt);
        output += stmtOutput;

        if (Buffer.byteLength(output, 'utf8') >= MAX_OUTPUT_BYTES) {
          break;
        }
      } catch (stmtErr) {
        clearTimeout(wallTimer);
        if (connection) {
          await connection.end().catch(() => {});
        }

        // Multi-statement contract: STOP AT FIRST ERROR;
        // stdout contains output of all statements before the error, stderr contains the error, exit 1
        if (output) {
          process.stdout.write(capOutput(output));
        }

        // ER_QUERY_TIMEOUT (code 3024) or ER_STATEMENT_TIMEOUT (code 1907)
        if (stmtErr.errno === 3024 || stmtErr.errno === 1907 || stmtErr.code === 'PROTOCOL_TIMEOUT' || stmtErr.message?.includes('exceeded') || stmtErr.message?.includes('statement timeout')) {
          process.stderr.write('canceling statement due to statement timeout\n', () => {
            process.exit(124);
          });
          return;
        }

        process.stderr.write(`ERROR: ${stmtErr.message}\n`, () => {
          process.exit(1);
        });
        return;
      }
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

    if (err.errno === 3024 || err.errno === 1907 || err.code === 'PROTOCOL_TIMEOUT' || err.message?.includes('exceeded') || err.message?.includes('statement timeout')) {
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
