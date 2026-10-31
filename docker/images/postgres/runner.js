const pg = require('pg');
const fs = require('fs');
const { splitPostgresStatements, stripCommentsAndLiterals } = require('./splitter.js');

let Cursor = null;
try {
  Cursor = require('pg-cursor');
} catch (err) {
  process.stderr.write(`[WARN] pg-cursor not installed, falling back to buffered query execution: ${err.message}\n`);
}

const { Client } = pg;

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
 * - Values printed exactly as returned (no 50-char truncation, D1)
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
 * Execute a query with cursor in batches to bound memory consumption (D5)
 */
async function executeWithCursor(client, stmt) {
  const cursor = client.query(new Cursor(stmt, [], { rowMode: 'array' }));
  const collectedRows = [];
  let colNames = [];
  let approxBytes = 0;
  let hitLimit = false;

  try {
    while (true) {
      const rows = await new Promise((resolve, reject) => {
        cursor.read(500, (err, batch) => {
          if (err) return reject(err);
          resolve(batch);
        });
      });

      if (!colNames.length && cursor._result && cursor._result.fields) {
        colNames = cursor._result.fields.map(f => f.name);
      }

      if (!rows || rows.length === 0) {
        break;
      }

      for (const row of rows) {
        collectedRows.push(row);
        for (const cell of row) {
          approxBytes += cell != null ? String(cell).length : 4;
        }
        if (approxBytes >= MAX_OUTPUT_BYTES) {
          hitLimit = true;
          break;
        }
      }

      if (hitLimit) {
        await new Promise(r => cursor.close(r));
        break;
      }
    }
  } catch (err) {
    await new Promise(r => cursor.close(() => r())).catch(() => {});
    throw err;
  }

  return formatTable(colNames, collectedRows);
}

/**
 * Determines whether a statement can return rows and cannot modify data.
 * Safe for cursor execution without side-effects:
 * - Starts with SELECT, VALUES or TABLE
 * - Starts with WITH and contains none of INSERT, UPDATE, DELETE, MERGE outside quoted strings/comments
 */
function isCursorEligible(stmt) {
  const stripped = stripCommentsAndLiterals(stmt).trim();
  if (/^\s*(SELECT|VALUES|TABLE)\b/i.test(stripped)) {
    return true;
  }
  if (/^\s*WITH\b/i.test(stripped)) {
    // If it's a CTE, ensure it has no data-modifying statements (INSERT, UPDATE, DELETE, MERGE)
    if (!/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(stripped)) {
      return true;
    }
  }
  return false;
}

/**
 * Execute a single statement and return its formatted text output
 */
async function executeSingleStatement(client, stmt) {
  if (Cursor && isCursorEligible(stmt)) {
    // Use cursor path; rethrow all errors (including statement_timeout 57014 and syntax errors)
    return await executeWithCursor(client, stmt);
  }

  // Fallback buffered path: for statements that modify data or if Cursor is not available
  const res = await client.query({ text: stmt, rowMode: 'array' });
  const results = Array.isArray(res) ? res : [res];
  let out = '';

  for (const r of results) {
    if (!r) continue;
    if (r.fields && r.fields.length > 0) {
      const colNames = r.fields.map(f => f.name);
      out += formatTable(colNames, r.rows || []);
    } else if (r.command) {
      if (r.command === 'INSERT') {
        out += `INSERT 0 ${r.rowCount || 0}\n`;
      } else if (r.rowCount !== null && r.rowCount !== undefined && r.command !== 'SELECT') {
        out += `${r.command} ${r.rowCount}\n`;
      } else {
        out += `${r.command}\n`;
      }
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

  // Host/runner wall-clock watchdog (exit code 124 on timeout) (D6)
  const wallTimer = setTimeout(() => {
    if (client) client.end().catch(() => {});
    process.stderr.write('canceling statement due to statement timeout\n', () => {
      process.exit(124);
    });
  }, timeoutMs);

  let client;
  const clientConfig = {
    user: 'runner',
    password: process.env.DB_PASSWORD || 'coderunner_runner_secret',
    database: process.env.DB_NAME || 'coderunner',
    host: '/box/socket',
    connectionTimeoutMillis: 1500,
    // D2: parse every type as raw text so jsonb, booleans (t/f), arrays ({1,2}), timestamps match server text output
    types: { getTypeParser: () => (v) => v },
  };

  try {
    try {
      client = new Client(clientConfig);
      await client.connect();
    } catch {
      clientConfig.connectionTimeoutMillis = 3000;
      client = new Client(clientConfig);
      await client.connect();
    }

    // Set PostgreSQL statement timeout in milliseconds
    await client.query(`SET statement_timeout = ${timeoutMs};`);

    // D4: Sequential statement execution with autocommit semantics
    const statements = splitPostgresStatements(sql);
    let output = '';

    for (const stmt of statements) {
      if (!stmt.trim()) continue;

      try {
        const stmtOutput = await executeSingleStatement(client, stmt);
        output += stmtOutput;

        if (Buffer.byteLength(output, 'utf8') >= MAX_OUTPUT_BYTES) {
          break;
        }
      } catch (stmtErr) {
        clearTimeout(wallTimer);
        await client.end().catch(() => {});

        // Multi-statement contract: STOP AT FIRST ERROR;
        // stdout contains output of all statements before the error, stderr contains the error, exit 1
        if (output) {
          process.stdout.write(capOutput(output));
        }

        // Code 57014 is PostgreSQL's query_canceled (statement_timeout)
        if (stmtErr.code === '57014' || stmtErr.message?.includes('statement timeout')) {
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
    await client.end().catch(() => {});
    process.stdout.write(output, () => {
      process.exit(0);
    });
  } catch (err) {
    clearTimeout(wallTimer);
    if (client) {
      await client.end().catch(() => {});
    }

    if (err.code === '57014' || err.message?.includes('statement timeout')) {
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
