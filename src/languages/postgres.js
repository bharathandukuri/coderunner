export default {
  id: 8,
  slug: "postgresql",
  name: "PostgreSQL 16",
  category: "database",
  is_daemon: true,
  runner: "sql-driver",
  extension: "sql",
  is_archived: false,
  source_file: "query.sql",
  compile_cmd: null,
  run_cmd: "node /opt/runner/runner.js /box/query.sql",
  image: "coderunner/postgres:16",
  default_time_limit: 5,
  max_time_limit: 30,
};

