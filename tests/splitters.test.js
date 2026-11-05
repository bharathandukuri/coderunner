import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { splitPostgresStatements, stripCommentsAndLiterals } = require('../docker/images/postgres/splitter.js');
const { splitMySQLStatements } = require('../docker/images/mysql/splitter.js');

describe('SQL Statement Splitter Unit Tests (Section D)', () => {
  describe('PostgreSQL Statement Splitter', () => {
    it('splits basic statements separated by semicolons', () => {
      const sql = 'SELECT 1; SELECT 2; SELECT 3;';
      const stmts = splitPostgresStatements(sql);
      assert.deepStrictEqual(stmts, ['SELECT 1', 'SELECT 2', 'SELECT 3']);
    });

    it('ignores semicolons inside single quotes and doubled-quotes', () => {
      const sql = "SELECT 'hello;world'; SELECT 'it''s;cool';";
      const stmts = splitPostgresStatements(sql);
      assert.deepStrictEqual(stmts, [
        "SELECT 'hello;world'",
        "SELECT 'it''s;cool'",
      ]);
    });

    it("ignores semicolons inside E'...' escape strings", () => {
      const sql = "SELECT E'line1\\;line2'; SELECT 2;";
      const stmts = splitPostgresStatements(sql);
      assert.deepStrictEqual(stmts, [
        "SELECT E'line1\\;line2'",
        'SELECT 2',
      ]);
    });

    it('ignores semicolons inside double-quoted identifiers', () => {
      const sql = 'SELECT "col;one", "col""two" FROM t; SELECT 2;';
      const stmts = splitPostgresStatements(sql);
      assert.deepStrictEqual(stmts, [
        'SELECT "col;one", "col""two" FROM t',
        'SELECT 2',
      ]);
    });

    it('ignores semicolons inside dollar-quoted blocks ($$ and $tag$)', () => {
      const sql = `
        CREATE OR REPLACE FUNCTION add_tax(price numeric) RETURNS numeric AS $$
        BEGIN
          RETURN price * 1.1; -- comment;
        END;
        $$ LANGUAGE plpgsql;

        CREATE FUNCTION foo() RETURNS void AS $my_tag$
        BEGIN
          SELECT 1;
        END;
        $my_tag$;
      `;
      const stmts = splitPostgresStatements(sql);
      assert.strictEqual(stmts.length, 2);
      assert(stmts[0].includes('price * 1.1; -- comment;'));
      assert(stmts[1].includes('$my_tag$'));
    });

    it('handles line comments and nested block comments', () => {
      const sql = `
        SELECT 1; -- line comment with ; here
        SELECT 2 /* block /* nested; */ comment */ ;
        SELECT 3;
      `;
      const stmts = splitPostgresStatements(sql);
      assert.strictEqual(stmts.length, 3);
      assert(stmts[0].startsWith('SELECT 1'));
      assert(stmts[1].includes('nested;'));
      assert(stmts[2].startsWith('SELECT 3'));
    });
  });

  describe('MySQL Statement Splitter', () => {
    it('splits basic statements separated by semicolons', () => {
      const sql = 'SELECT 1; SELECT 2; SELECT 3;';
      const stmts = splitMySQLStatements(sql);
      assert.deepStrictEqual(stmts, ['SELECT 1', 'SELECT 2', 'SELECT 3']);
    });

    it('handles DELIMITER commands and stored procedures', () => {
      const sql = `
        DELIMITER //
        CREATE PROCEDURE my_proc()
        BEGIN
          SELECT 1;
          SELECT 2;
        END //
        DELIMITER ;
        SELECT 3;
      `;
      const stmts = splitMySQLStatements(sql);
      assert.strictEqual(stmts.length, 2);
      assert(stmts[0].includes('CREATE PROCEDURE my_proc()'));
      assert(stmts[0].includes('SELECT 1;'));
      assert(stmts[0].includes('SELECT 2;'));
      assert.strictEqual(stmts[1], 'SELECT 3');
    });

    it('ignores semicolons inside single/double quotes and backticks', () => {
      const sql = 'SELECT \'a;b\', "c;d", `e;f`; SELECT 2;';
      const stmts = splitMySQLStatements(sql);
      assert.deepStrictEqual(stmts, [
        'SELECT \'a;b\', "c;d", `e;f`',
        'SELECT 2',
      ]);
    });

    it('handles -- (with space), # and /* */ comments', () => {
      const sql = `
        SELECT 1; -- comment with ; space
        SELECT 2; # hash comment with ;
        SELECT 3 /* block comment; */ ;
      `;
      const stmts = splitMySQLStatements(sql);
      assert.strictEqual(stmts.length, 3);
      assert(stmts[0].includes('SELECT 1'));
      assert(stmts[1].includes('SELECT 2'));
      assert(stmts[2].includes('SELECT 3'));
    });
  });

  describe('PostgreSQL stripCommentsAndLiterals & Cursor Eligibility (Section 2)', () => {
    it('strips strings, dollar quotes, and comments to reveal underlying SQL commands', () => {
      const sql = `
        /* comment with INSERT */
        -- line comment with DELETE
        WITH ins AS (
          INSERT INTO t VALUES (1) RETURNING *
        )
        SELECT 'UPDATE foo', "MERGE bar", $$DELETE baz$$ FROM ins;
      `;
      const stripped = stripCommentsAndLiterals(sql);
      assert(!stripped.includes('/* comment with INSERT */'));
      assert(!stripped.includes('UPDATE foo'));
      assert(!stripped.includes('DELETE baz'));
      // The actual DML 'INSERT' in the CTE body is preserved so cursor check knows it mutates data
      assert(/\bINSERT\b/i.test(stripped));
    });

    it('identifies pure read-only queries as cursor eligible', () => {
      const pureSelect = 'SELECT * FROM users WHERE active = true';
      const stripped = stripCommentsAndLiterals(pureSelect);
      const isEligible = /^\s*(SELECT|VALUES|TABLE)\b/i.test(stripped) ||
        (/^\s*WITH\b/i.test(stripped) && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(stripped));
      assert.strictEqual(isEligible, true);
    });

    it('disallows data-modifying CTEs from cursor execution', () => {
      const dmlCte = 'WITH ins AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM ins';
      const stripped = stripCommentsAndLiterals(dmlCte);
      const isEligible = /^\s*(SELECT|VALUES|TABLE)\b/i.test(stripped) ||
        (/^\s*WITH\b/i.test(stripped) && !/\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(stripped));
      assert.strictEqual(isEligible, false);
    });
  });
});
