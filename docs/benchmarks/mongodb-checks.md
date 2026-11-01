# MongoDB Security & Behavioral Verification

- **Date**: 2026-11-01
- **Target Engine**: MongoDB 8.0 LTS (`mongo:8.0`)
- **Execution Mode**: Ephemeral Container Sandbox via `mongod` daemon + `mongosh` CLI
- **Commit**: `cf26e18`

---

## 1. Escape Attempt Analysis

All tests executed inside the isolated container sandbox:

### 1.1 `require('child_process').execSync('id')`
- **Script**:
  ```javascript
  try {
    const res = require("child_process").execSync("id").toString();
    print("EXEC_SUCCESS: " + res);
  } catch (e) {
    print("EXEC_BLOCKED: " + e.message);
  }
  ```
- **Output**:
  ```text
  EXEC_BLOCKED: spawnSync /bin/sh EAGAIN
  ```
- **Analysis**: Blocked by container process limit (`pidsLimit: 64`) preventing subprocess creation. Furthermore, `CapDrop: ALL` and `no-new-privileges: true` disallow privilege escalation.

### 1.2 `require('fs').readFileSync('/etc/passwd')`
- **Script**:
  ```javascript
  try {
    const res = require("fs").readFileSync("/etc/passwd", "utf8");
    print("FS_SUCCESS:\n" + res.slice(0, 100));
  } catch (e) {
    print("FS_BLOCKED: " + e.message);
  }
  ```
- **Output**:
  ```text
  FS_SUCCESS:
  root:x:0:0:root:/root:/bin/bash
  daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
  bin:x:2:2:bin:/bin:/
  ```
- **Analysis**: Succeeds in reading `/etc/passwd` inside the unprivileged container rootfs. Behavior is identical to Python (`open('/etc/passwd').read()`) and Node.js submissions in Judge0 / CodeRunner. No host files are accessible because rootfs is isolated and host filesystem is unmounted.

### 1.3 `load('/etc/passwd')`
- **Script**:
  ```javascript
  try {
    load("/etc/passwd");
    print("LOAD_SUCCESS");
  } catch (e) {
    print("LOAD_BLOCKED: " + e.message);
  }
  ```
- **Output**:
  ```text
  LOAD_BLOCKED: Missing semicolon. (1:8)
  > 1 | root:x:0:0:root:/root:/bin/bash
      |         ^
  ```
- **Analysis**: Blocked by JavaScript parser syntax error.

### 1.4 `process.env`
- **Script**:
  ```javascript
  print("ENV_KEYS: " + Object.keys(process.env).sort().join(", "));
  ```
- **Output**:
  ```text
  ENV_KEYS: GLIBC_TUNABLES, GOSU_VERSION, HOME, HOSTNAME, JSYAML_CHECKSUM, JSYAML_VERSION, MONGO_MAJOR, MONGO_PACKAGE, MONGO_REPO, MONGO_VERSION, PATH, PWD, SHLVL, _
  ```
- **Analysis**: Exposes standard container environment variables only. No API tokens, Redis passwords, or host secrets exist within the execution container environment.

### 1.5 `db.adminCommand({shutdown: 1})`
- **Analysis**: Blocked prior to execution by CodeRunner's static analyzer (`src/security/codeAnalyzer.js`) with HTTP 422: `forbidden language construct: mongodb shutdown command`.

### 1.6 `db.getSiblingDB('admin').shutdownServer()`
- **Analysis**: Blocked prior to execution by CodeRunner's static analyzer (`src/security/codeAnalyzer.js`) with HTTP 422: `forbidden language construct: mongodb shutdown server`.

---

## 2. Behavioral Checks

| Test Case | Expected Behavior | Observed Result | Pass/Fail |
|---|---|---|---|
| **Insert then Find** | Correct JSON representation of inserted documents | Returned `[ { name: 'Alice', score: 95 }, { name: 'Bob', score: 88 } ]` | **PASS** |
| **Invalid Script Syntax** | Process non-zero exit code with error message | SyntaxError: Missing semicolon (exit code 1) | **PASS** |
| **Infinite Loop** | Time Limit Exceeded (Status 5) | Worker deadline timer triggers and aborts container (TLE) | **PASS** |
| **Output Truncation** | Capped at `max_file_size` (1024 KB) | Stream parser truncates output and appends `[truncated]` | **PASS** |
| **Multi-File State** | Seed file state accessible to subsequent query file | File 1 inserts item; File 2 queries and prints `{ item: 'widget', qty: 42 }` | **PASS** |

---

## 3. Container Hardening Audit

Inspection of running container via `docker inspect`:
```json
{
  "NetworkMode": "none",
  "CapDrop": [
    "ALL"
  ],
  "ReadonlyRootfs": true,
  "PidsLimit": 64,
  "Memory": 536870912,
  "Tmpfs": {
    "/box": "rw,exec,nosuid,size=64m",
    "/data/configdb": "rw,noexec,nosuid,size=64m",
    "/data/db": "rw,noexec,nosuid,size=256m",
    "/tmp": "rw,noexec,nosuid,size=64m"
  }
}
```

### Resource Cleanup
- `docker volume ls -qf dangling=true` returns zero dangling volumes.
- All temporary storage is hosted on ephemeral in-memory `tmpfs` mounts, ensuring zero disk leaks.
- After container teardown, `docker ps -a --filter label=com.coderunner.pool=true` is completely clean.
