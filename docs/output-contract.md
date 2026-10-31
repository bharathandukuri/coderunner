# SQL Output Contract

This document defines the strict output formatting contract for all database execution engines (PostgreSQL and MySQL) in CodeRunner.

---

## 1. Table Formatting Rules

| Rule | Description |
| :--- | :--- |
| **Headers** | Column headers are always printed, separated by 2 spaces (`  `), even when a query returns zero rows (0 rows). |
| **Header Separator** | A dashed line (`-` repeated for column width) appears immediately below headers. |
| **NULL Representation** | `NULL` values are explicitly printed as the literal string `NULL`. |
| **No Cell Truncation** | Cell values are printed in full as returned by the engine text output. Truncation at arbitrary limits (e.g. 50 characters) is strictly forbidden. |
| **Raw Server Text** | All data types are formatted as raw text returned by the server: <br>- PostgreSQL `jsonb`: parsed as raw JSON string, never `[object Object]` <br>- PostgreSQL boolean: `t` / `f` <br>- PostgreSQL arrays: `{val1, val2}` <br>- MySQL `BIGINT`: exact precision preserved without IEEE 754 float rounding <br>- MySQL `JSON`/`BLOB`/`BIT`/`DECIMAL`: converted to server string representation |

---

## 2. Byte Capping (1MB Limit)

- Output is capped at **1,048,576 bytes (1MB)**.
- If the output exceeds 1MB, it is truncated cleanly at a valid UTF-8 boundary and followed by the exact overflow marker:
  ```
  [Output limit of 1MB exceeded]
  ```
- Memory consumption during query execution is bounded:
  - **PostgreSQL**: Queries are streamed in 500-row batches via `pg-cursor`.
  - **MySQL**: Queries are streamed row-by-row via streaming queries.
  - As soon as the byte cap (1MB) is reached, reading aborts immediately, and remaining rows are never loaded into Node.js heap memory, preventing Out-Of-Memory (OOM) errors even on queries producing 50,000,000+ rows.

---

## 3. Multi-Statement Script Execution & Error Handling

- **Sequential Execution**: Multi-statement SQL scripts are parsed into individual statements using SQL-aware statement splitters:
  - PostgreSQL: Handles single quotes (including `''` and `E'...'` escapes), double-quoted identifiers, `$tag$...$tag$` dollar quoting, `--` comments, and nested `/* ... */` block comments.
  - MySQL: Handles `DELIMITER` commands, single/double quotes, backticks, `-- ` comments, `#` comments, and `/* ... */` block comments.
- **Autocommit Semantics**: Each statement executes independently. Commands requiring autocommit (such as `VACUUM` and `CREATE INDEX CONCURRENTLY` in PostgreSQL) execute without error.
- **Stop at First Error**:
  - Execution immediately halts at the first failing statement.
  - `stdout` contains the complete output of all statements executed **before** the error.
  - `stderr` contains the error message of the failing statement.
  - Exit code is `1`.

---

## 4. Timeouts & Watchdog

- A wall-clock watchdog timer enforces script time limits.
- If the watchdog timer or server statement timeout expires, the runner halts and exits with **code 124**.
- CodeRunner's `ResultParser` maps exit code 124 directly to `Time Limit Exceeded` (Status 5).

