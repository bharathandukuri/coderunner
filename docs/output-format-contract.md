# Database Runner Output Format Contract

This document formalizes the execution output contract for PostgreSQL (`id: 8`) and MySQL (`id: 9`) in CodeRunner.

## 1. Output Specification

Both `docker/images/postgres/runner.js` and `docker/images/mysql/runner.js` adhere to the same output specification:

1. **Header Row**: Always printed, even when a `SELECT` statement returns zero rows.
2. **Column Separator**: A dashed line (`-` repeated to match column name length or minimum width).
3. **Duplicate Column Names**: Preserved intact (e.g., `SELECT a.id, b.id` renders `id id` with respective values, rather than collapsing or renaming).
4. **NULL Handling**: Rendered strictly as literal uppercase `NULL`.
5. **DML / DDL Statements**: Print standard execution confirmations:
   `Query OK, <N> row(s) affected`
6. **Multi-Statement Scripts**: Render all statement results sequentially in execution order.
7. **Size Limits & Truncation**:
   - Output byte length is measured with `Buffer.byteLength(output, 'utf8')`.
   - Capped at `MAX_OUTPUT_BYTES = 1024 * 1024` (1MB).
   - If output exceeds 1MB, truncation cuts off cleanly at the byte boundary and appends `\n... [Output truncated at 1048576 bytes]`.
8. **Time Limits & Watchdog**:
   - In-database query timeout: `statement_timeout` (Postgres) / `max_execution_time` (MySQL).
   - Container runner wall-clock watchdog: fires if query hangs or statement timeout is overridden, exiting with code `124`.
   - Host-side execution grace period: container is terminated if it exceeds time limit + 1.5s grace.
   - CodeRunner ResultParser translates exit code 124 to Status `5` (Time Limit Exceeded).

---

## 2. Canonical Examples

### A. Simple SELECT
**Query**:
```sql
SELECT 1 AS num, 'hello' AS msg;
```
**Stdout**:
```
num msg  
--- -----
1   hello
```

### B. Empty Result Set (Zero Rows)
**Query**:
```sql
SELECT 1 AS num WHERE 1 = 0;
```
**Stdout**:
```
num
---
```

### C. NULL Value Representation
**Query**:
```sql
SELECT NULL AS val;
```
**Stdout**:
```
val 
----
NULL
```

### D. Duplicate Column Names
**Query**:
```sql
SELECT 1 AS id, 2 AS id;
```
**Stdout**:
```
id id
-- --
1  2 
```

### E. Multi-Statement Script
**Query**:
```sql
CREATE TABLE items (id INT, name VARCHAR(20));
INSERT INTO items VALUES (1, 'apple'), (2, 'banana');
SELECT * FROM items ORDER BY id;
```
**Stdout**:
```
Query OK, 0 rows affected
Query OK, 2 rows affected
id name  
-- ------
1  apple 
2  banana
```

### F. MySQL DELIMITER & Stored Procedure
**Query**:
```sql
DELIMITER //
CREATE PROCEDURE CalcSquare(IN n INT, OUT res INT)
BEGIN
  SET res = n * n;
END //
DELIMITER ;

CALL CalcSquare(9, @ans);
SELECT @ans AS square;
```
**Stdout**:
```
Query OK, 0 rows affected
Query OK, 0 rows affected
square
------
81    
```

