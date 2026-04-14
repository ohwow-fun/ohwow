import { describe, it, expect } from 'vitest';
import { validateReadOnlyCommand } from '../investigate-shell.js';

describe('validateReadOnlyCommand', () => {
  describe('accepts read-only shapes', () => {
    const acceptCases: Array<[string, string]> = [
      ['sqlite3 SELECT', 'sqlite3 /tmp/runtime.db "SELECT COUNT(*) FROM agent_workforce_deliverables"'],
      ['sqlite3 WITH CTE', 'sqlite3 /tmp/runtime.db "WITH recent AS (SELECT * FROM foo) SELECT * FROM recent"'],
      ['sqlite3 .schema', 'sqlite3 /tmp/runtime.db ".schema agent_workforce_deliverables"'],
      ['sqlite3 .tables', 'sqlite3 /tmp/runtime.db ".tables"'],
      ['ripgrep', 'rg "created_at" src/orchestrator'],
      ['grep', 'grep -n "deliverable_type" src/'],
      ['find', 'find src -name "*.ts" -type f'],
      ['head', 'head -5 src/orchestrator/tools/deliverables.ts'],
      ['tail', 'tail -20 /tmp/daemon.log'],
      ['cat', 'cat src/orchestrator/tools/deliverables.ts'],
      ['wc', 'wc -l src/orchestrator/tools/deliverables.ts'],
      ['ls', 'ls src/orchestrator/tools'],
      ['stat', 'stat src/orchestrator/tools/deliverables.ts'],
      ['file', 'file src/orchestrator/tools/deliverables.ts'],
      ['jq', 'jq .cloudModel /Users/jesus/.ohwow/config.json'],
      ['awk', 'awk -F, "{print $1}" /tmp/data.csv'],
      ['sed print', 'sed -n "1,10p" src/orchestrator/tools/deliverables.ts'],
    ];

    for (const [name, command] of acceptCases) {
      it(name, () => {
        const result = validateReadOnlyCommand(command);
        expect(result.allowed, `${name}: ${result.reason ?? ''}`).toBe(true);
      });
    }
  });

  describe('rejects mutations', () => {
    const rejectCases: Array<[string, string, RegExp]> = [
      ['rm', 'rm -rf /tmp/bad', /`rm`/],
      ['mv', 'mv /tmp/a /tmp/b', /`mv`/],
      ['cp', 'cp /tmp/a /tmp/b', /`cp`/],
      ['chmod', 'chmod +x /tmp/bin', /`chmod`/],
      ['sed -i', 'sed -i "s/foo/bar/" file.txt', /sed -i/i],
      ['sqlite3 DELETE', 'sqlite3 /tmp/db.sqlite "DELETE FROM agent_workforce_deliverables"', /(DML\/DDL|read-only)/],
      ['sqlite3 UPDATE', 'sqlite3 /tmp/db.sqlite "UPDATE agents SET status=\'foo\'"', /(DML\/DDL|read-only)/],
      ['sqlite3 DROP', 'sqlite3 /tmp/db.sqlite "DROP TABLE foo"', /(DML\/DDL|read-only)/],
    ];

    for (const [name, command, expectedReason] of rejectCases) {
      it(name, () => {
        const result = validateReadOnlyCommand(command);
        expect(result.allowed).toBe(false);
        expect(result.reason).toMatch(expectedReason);
      });
    }
  });

  describe('rejects shell composition', () => {
    const compositionCases: Array<[string, string]> = [
      ['pipeline', 'cat /tmp/log | grep ERROR'],
      ['logical-and', 'ls && rm -rf /tmp/bad'],
      ['command separator', 'ls ; rm -rf /tmp/bad'],
      ['redirect out', 'cat /tmp/a > /tmp/b'],
      ['redirect append', 'cat /tmp/a >> /tmp/b'],
      ['redirect in', 'wc -l < /tmp/a'],
      ['command substitution', 'cat $(ls /tmp)'],
      ['backticks', 'cat `ls /tmp`'],
    ];

    for (const [name, command] of compositionCases) {
      it(name, () => {
        const result = validateReadOnlyCommand(command);
        expect(result.allowed).toBe(false);
      });
    }
  });

  describe('edge cases', () => {
    it('empty string rejected', () => {
      expect(validateReadOnlyCommand('')).toEqual({ allowed: false, reason: 'command is empty' });
    });
    it('whitespace-only rejected', () => {
      expect(validateReadOnlyCommand('   ').allowed).toBe(false);
    });
    it('unknown head rejected (bash invoke)', () => {
      expect(validateReadOnlyCommand('bash -c "echo hi"').allowed).toBe(false);
    });
    it('unknown head rejected (curl)', () => {
      // curl is read-side but we exclude it — investigations shouldn't
      // reach outside the local filesystem + DB. If the need comes up,
      // we'll add it explicitly.
      expect(validateReadOnlyCommand('curl https://example.com').allowed).toBe(false);
    });
    it('unknown head rejected (node -e, explicitly excluded)', () => {
      // node -e / python -c are intentionally excluded so the chain
      // gate doesn't collide with interpreter statement separators.
      expect(validateReadOnlyCommand('node -e "console.log(1)"').allowed).toBe(false);
    });
    it('unknown head rejected (python -c, explicitly excluded)', () => {
      expect(validateReadOnlyCommand('python3 -c "print(1)"').allowed).toBe(false);
    });
    it('leading whitespace tolerated', () => {
      // The validator trims before checking — common model formatting.
      expect(validateReadOnlyCommand('  rg pattern src/').allowed).toBe(true);
    });
  });
});
