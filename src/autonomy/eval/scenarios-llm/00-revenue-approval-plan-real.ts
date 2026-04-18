/**
 * 00-revenue-approval-plan-real
 *
 * The Phase 6.9 smoke scenario for the real-LLM plan executor. One
 * pending approval drives the conductor into the revenue lens; the
 * plan round hits Haiku via the project's ModelRouter; impl + qa stay
 * stubbed (Phase 6.9 is plan-only).
 *
 * Assertions are STRUCTURAL, not byte-stable goldens. The model can
 * vary phrasing run-to-run; what we lock in is:
 *   - exactly one arc opened + closed
 *   - exactly one phase report, mode revenue, status phase-closed
 *   - the plan round returned status='continue' with a non-empty,
 *     reasonably-long next_round_brief
 *   - the plan summary references the seeded approval (acme/email/
 *     pricing/the id) so we can trust the model is reading the brief
 *   - cost_llm_cents > 0 on the phase report (meter plumbed through)
 *   - meter input + output token counts are non-zero
 *
 * Double opt-in: the harness only runs LLM scenarios when both
 * `OHWOW_AUTONOMY_EVAL_REAL=1` AND `--real` (or `--real-only`) are
 * set on the CLI. The vitest wrapper never runs this scenario.
 */
import type { LlmScenario } from '../harness-llm.js';

const APPROVAL_ID = 'ap_acme';
const APPROVAL_SUBJECT =
  'approve email draft to lead@acme.com about pricing follow-up';

const MATCH_TOKENS = ['acme', 'email', 'pricing', APPROVAL_ID];

const scenario: LlmScenario = {
  name: '00-revenue-approval-plan-real',
  describe:
    'One pending Acme pricing approval -> revenue arc opens, plan round hits Haiku, impl+qa stub-pass, arc closes one phase, cost_llm_cents > 0.',
  initial_seed: {
    approvals: [
      {
        id: APPROVAL_ID,
        subject: APPROVAL_SUBJECT,
        age_hours: 4,
        mode: 'revenue',
      },
    ],
    business_vitals: {
      mrr_cents: 15000,
      pipeline_count: 1,
      pending_approvals_count: 1,
    },
  },
  steps: [
    {
      kind: 'tick',
      note: 'real LLM plan round + stubbed impl/qa',
    },
  ],
  assertions: [
    // 1. Exactly one arc opened and closed.
    async (t) => {
      if (t.finals.open_arcs !== 0) {
        throw new Error(
          `expected 0 open arcs, got ${t.finals.open_arcs}`,
        );
      }
      if (t.finals.closed_arcs !== 1) {
        throw new Error(
          `expected 1 closed arc, got ${t.finals.closed_arcs}`,
        );
      }
      if (t.finals.aborted_arcs !== 0) {
        throw new Error(
          `expected 0 aborted arcs, got ${t.finals.aborted_arcs}`,
        );
      }
    },
    // 2. Exactly one phase report, mode revenue, status phase-closed.
    async (t) => {
      const phases = t.steps[0]?.arc_summary?.phases ?? [];
      if (phases.length !== 1) {
        throw new Error(
          `expected exactly 1 phase, got ${phases.length}`,
        );
      }
      const only = phases[0];
      if (only.mode !== 'revenue') {
        throw new Error(`phase mode should be revenue, got ${only.mode}`);
      }
      if (only.status !== 'phase-closed') {
        throw new Error(
          `phase status should be phase-closed, got ${only.status}`,
        );
      }
    },
    // 3. Plan round status === 'continue' (LlmScenario surfaces this via
    //    the captured plan return; harness threads it through).
    async (_t, ctx) => {
      const plan = ctx.captured_plan_return;
      if (!plan) {
        throw new Error('expected captured plan return on assertion ctx');
      }
      if (plan.status !== 'continue') {
        throw new Error(
          `expected plan status=continue, got ${plan.status}`,
        );
      }
    },
    // 4. next_round_brief non-empty and >= 40 chars.
    async (_t, ctx) => {
      const plan = ctx.captured_plan_return;
      if (!plan) throw new Error('plan return missing');
      const brief = plan.next_round_brief ?? '';
      if (brief.trim().length < 40) {
        throw new Error(
          `next_round_brief should be >= 40 chars, got ${brief.length}: ${brief}`,
        );
      }
    },
    // 5. Plan summary <= 5 lines.
    async (_t, ctx) => {
      const plan = ctx.captured_plan_return;
      if (!plan) throw new Error('plan return missing');
      const lines = plan.summary.split('\n');
      if (lines.length > 5) {
        throw new Error(
          `plan summary should be <= 5 lines, got ${lines.length}: ${plan.summary}`,
        );
      }
    },
    // 6. Plan summary references the approval (acme/email/pricing/id).
    async (_t, ctx) => {
      const plan = ctx.captured_plan_return;
      if (!plan) throw new Error('plan return missing');
      const text = (
        plan.summary +
        '\n' +
        (plan.next_round_brief ?? '')
      ).toLowerCase();
      const hit = MATCH_TOKENS.some((tok) =>
        text.includes(tok.toLowerCase()),
      );
      if (!hit) {
        throw new Error(
          `plan summary+brief should mention one of ${MATCH_TOKENS.join('/')}; got: ${text}`,
        );
      }
    },
    // 7. cost_llm_cents > 0 on the phase report.
    async (_t, ctx) => {
      const reports = ctx.phase_reports ?? [];
      if (reports.length === 0) {
        throw new Error('expected at least one phase report on ctx');
      }
      const cost = reports[0].cost_llm_cents ?? 0;
      if (cost <= 0) {
        throw new Error(
          `expected cost_llm_cents > 0 on phase report, got ${cost}`,
        );
      }
    },
    // 8. meter.input_tokens > 0 && meter.output_tokens > 0.
    async (_t, ctx) => {
      const m = ctx.meter;
      if (!m) throw new Error('expected meter on assertion ctx');
      if (m.input_tokens <= 0) {
        throw new Error(`expected meter.input_tokens > 0, got ${m.input_tokens}`);
      }
      if (m.output_tokens <= 0) {
        throw new Error(
          `expected meter.output_tokens > 0, got ${m.output_tokens}`,
        );
      }
    },
  ],
};

export default scenario;
