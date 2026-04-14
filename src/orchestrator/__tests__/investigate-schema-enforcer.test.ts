import { describe, it, expect } from 'vitest';
import { enforceInvestigationSchema } from '../sub-orchestrator.js';

describe('enforceInvestigationSchema', () => {
  describe('valid schemas pass through', () => {
    it('accepts a well-formed fenced JSON with 2+ populated hypotheses', () => {
      const raw = [
        'Finished investigating. Here is the structured report:',
        '',
        '```json',
        JSON.stringify({
          hypotheses_considered: [
            {
              claim: 'mixed timestamp formats in created_at',
              confirm_query: 'sqlite3 runtime.db "SELECT DISTINCT substr(created_at,11,1) FROM agent_workforce_deliverables"',
              confirm_result: 'returned two distinct values: " " and "T"',
              rejected_because: null,
            },
            {
              claim: 'rows archived between capture and query',
              confirm_query: 'sqlite3 runtime.db "SELECT status, COUNT(*) FROM agent_workforce_deliverables GROUP BY status"',
              confirm_result: 'all rows status=pending_review, none archived',
              rejected_because: 'archive count is zero so drift cannot be the cause',
            },
          ],
          queries_run: ['created_at', 'deliverables since', 'lexicographic compare'],
          confirmation_searches: ['.schema agent_workforce_deliverables', 'SELECT COUNT'],
          root_cause: 'mixed timestamp formats in agent_workforce_deliverables.created_at',
          recommended_fix: {
            file: 'src/db/migrations/112-deliverables-created-at-iso.sql',
            summary: 'backfill created_at to ISO-with-Z via strftime',
            confidence: 'high',
          },
          dead_ends: [],
        }, null, 2),
        '```',
      ].join('\n');

      const result = enforceInvestigationSchema(raw);

      expect(result.parsed).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.fields.hypotheses_considered).toHaveLength(2);
      expect(result.fields.root_cause).toContain('mixed timestamp formats');
      expect(result.fields.recommended_fix?.confidence).toBe('high');
      expect(result.fields.recommended_fix?.file).toContain('112-deliverables');
    });

    it('accepts a non-fenced inline JSON object too', () => {
      const raw = `final analysis: ${JSON.stringify({
        hypotheses_considered: [
          { claim: 'A', confirm_query: 'q1', confirm_result: 'r1', rejected_because: null },
          { claim: 'B', confirm_query: 'q2', confirm_result: 'r2', rejected_because: 'lost' },
        ],
        queries_run: ['a', 'b'],
        confirmation_searches: ['c1', 'c2'],
        root_cause: 'A wins',
      })}`;
      const result = enforceInvestigationSchema(raw);
      expect(result.parsed).toBe(true);
      expect(result.fields.root_cause).toBe('A wins');
    });
  });

  describe('hard rules strip premature conclusions', () => {
    it('strips root_cause when only 1 hypothesis reported', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          { claim: 'its obvious', confirm_query: 'q', confirm_result: 'r', rejected_because: null },
        ],
        queries_run: ['q'],
        confirmation_searches: ['q'],
        root_cause: 'its obvious',
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.parsed).toBe(true);
      expect(result.fields.root_cause).toBeNull();
      expect(result.warnings.some((w) => w.includes('only 1 hypothesis'))).toBe(true);
    });

    it('strips root_cause when a hypothesis has empty confirm_query', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          { claim: 'A', confirm_query: '', confirm_result: 'r1', rejected_because: null },
          { claim: 'B', confirm_query: 'q2', confirm_result: 'r2', rejected_because: 'lost' },
        ],
        queries_run: ['q2'],
        confirmation_searches: ['q2'],
        root_cause: 'A',
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.fields.root_cause).toBeNull();
      expect(result.warnings.some((w) => w.includes('empty confirm_query'))).toBe(true);
    });

    it('strips root_cause when a hypothesis has empty confirm_result', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          { claim: 'A', confirm_query: 'q1', confirm_result: '   ', rejected_because: null },
          { claim: 'B', confirm_query: 'q2', confirm_result: 'r2', rejected_because: 'lost' },
        ],
        queries_run: ['q1', 'q2'],
        confirmation_searches: ['q1', 'q2'],
        root_cause: 'A',
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.fields.root_cause).toBeNull();
    });

    it('demotes recommended_fix confidence when root_cause is stripped', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          { claim: 'lone', confirm_query: 'q', confirm_result: 'r', rejected_because: null },
        ],
        queries_run: ['q'],
        confirmation_searches: ['q'],
        root_cause: 'lone',
        recommended_fix: { file: 'src/foo.ts', summary: 'fix it', confidence: 'high' },
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.fields.root_cause).toBeNull();
      expect(result.fields.recommended_fix?.confidence).toBe('low');
    });
  });

  describe('malformed input', () => {
    it('returns parsed=false when no JSON block is present', () => {
      const result = enforceInvestigationSchema('I think the bug is in deliverables.ts and we should fix it.');
      expect(result.parsed).toBe(false);
      expect(result.warnings[0]).toContain('did not emit');
      expect(result.fields.hypotheses_considered).toEqual([]);
      expect(result.fields.root_cause).toBeNull();
    });

    it('returns parsed=false when the JSON is syntactically broken', () => {
      const result = enforceInvestigationSchema('```json\n{ broken: not json }\n```');
      expect(result.parsed).toBe(false);
      expect(result.warnings[0]).toContain('did not parse');
    });

    it('tolerates JSON missing optional fields', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          { claim: 'A', confirm_query: 'q1', confirm_result: 'r1', rejected_because: null },
          { claim: 'B', confirm_query: 'q2', confirm_result: 'r2', rejected_because: 'lost' },
        ],
        // no queries_run, no confirmation_searches, no recommended_fix
        root_cause: 'A',
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.parsed).toBe(true);
      expect(result.fields.root_cause).toBe('A');
      expect(result.fields.queries_run).toEqual([]);
      expect(result.fields.confirmation_searches).toEqual([]);
      expect(result.fields.recommended_fix).toBeUndefined();
    });

    it('skips non-object entries in hypotheses_considered', () => {
      const raw = '```json\n' + JSON.stringify({
        hypotheses_considered: [
          null,
          'not an object',
          { claim: 'A', confirm_query: 'q1', confirm_result: 'r1', rejected_because: null },
          { claim: 'B', confirm_query: 'q2', confirm_result: 'r2', rejected_because: 'lost' },
        ],
        queries_run: ['q1', 'q2'],
        confirmation_searches: ['q1', 'q2'],
        root_cause: 'A',
      }) + '\n```';

      const result = enforceInvestigationSchema(raw);
      expect(result.fields.hypotheses_considered).toHaveLength(2);
      expect(result.fields.root_cause).toBe('A');
    });
  });
});
