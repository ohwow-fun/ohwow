/**
 * 01-revenue-approval-qa-real
 *
 * Gap 14.4 smoke scenario for the real-LLM QA judge executor. One pending
 * approval drives the conductor into the revenue lens; plan + qa rounds hit
 * Haiku via the project's ModelRouter; impl stays stubbed.
 *
 * Assertions are STRUCTURAL, not byte-stable goldens:
 *   - captured_qa_return is defined
 *   - evaluation.verdict is one of passed / failed-fixed / failed-escalate
 *   - evaluation.criteria is a non-empty array
 *   - evaluation.criteria[0].criterion is a non-empty string
 *   - meter.input_tokens > 0 after the qa round fires
 *   - phase report cost_llm_cents >= 0 (present and non-negative)
 *
 * Double opt-in: the harness only runs LLM scenarios when both
 * `OHWOW_AUTONOMY_EVAL_REAL=1` AND `--real` (or `--real-only`) are
 * set on the CLI. The vitest wrapper never runs this scenario.
 */
import { defaultMakeStubExecutor } from '../../conductor.js';
import {
  makeLlmPlanExecutor,
  makeQaJudgeExecutor,
} from '../../executors/llm-executor.js';
import {
  withPlanCapture,
  withQaCapture,
  type LlmScenario,
} from '../harness-llm.js';

const APPROVAL_ID = 'ap_acme_qa';
const APPROVAL_SUBJECT =
  'approve email draft to lead@acme.com about pricing follow-up';

const scenario: LlmScenario = {
  name: '01-revenue-approval-qa-real',
  describe:
    'One pending Acme pricing approval -> revenue arc opens, plan + qa rounds hit Haiku, impl stubs, qa verdict is valid, cost_llm_cents present.',
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
      note: 'real LLM plan + qa rounds with stubbed impl',
    },
  ],
  makeExecutor: ({ effectiveModel, cappedClient, meter, planCapture, qaCapture }) => {
    const stubFallback = defaultMakeStubExecutor();
    const planExecutor = makeLlmPlanExecutor({
      model: effectiveModel,
      client: cappedClient,
      fallback: stubFallback,
      meter,
    });
    const planCaptured = withPlanCapture(planExecutor, planCapture);
    const qaExecutor = makeQaJudgeExecutor({
      model: effectiveModel,
      client: cappedClient,
      fallback: planCaptured,
      meter,
    });
    return withQaCapture(qaExecutor, qaCapture);
  },
  assertions: [
    // 1. captured_qa_return is defined.
    async (_t, ctx) => {
      if (!ctx.captured_qa_return) {
        throw new Error('expected captured_qa_return on assertion ctx');
      }
    },
    // 2. evaluation.verdict is a valid string.
    async (_t, ctx) => {
      const qa = ctx.captured_qa_return;
      if (!qa) throw new Error('qa return missing');
      const valid = ['passed', 'failed-fixed', 'failed-escalate'];
      if (!qa.evaluation || !valid.includes(qa.evaluation.verdict)) {
        throw new Error(
          `evaluation.verdict should be one of ${valid.join('/')}, got: ${String(qa.evaluation?.verdict)}`,
        );
      }
    },
    // 3. evaluation.criteria is a non-empty array.
    async (_t, ctx) => {
      const qa = ctx.captured_qa_return;
      if (!qa) throw new Error('qa return missing');
      const criteria = qa.evaluation?.criteria ?? [];
      if (criteria.length === 0) {
        throw new Error('evaluation.criteria must be a non-empty array');
      }
    },
    // 4. evaluation.criteria[0].criterion is a non-empty string.
    async (_t, ctx) => {
      const qa = ctx.captured_qa_return;
      if (!qa) throw new Error('qa return missing');
      const first = qa.evaluation?.criteria[0];
      if (!first || typeof first.criterion !== 'string' || first.criterion.trim().length === 0) {
        throw new Error(
          `evaluation.criteria[0].criterion should be a non-empty string, got: ${JSON.stringify(first)}`,
        );
      }
    },
    // 5. meter.input_tokens > 0 (proxy: qa round made at least one real call).
    async (_t, ctx) => {
      if (ctx.meter.input_tokens <= 0) {
        throw new Error(
          `expected meter.input_tokens > 0 after qa round, got ${ctx.meter.input_tokens}`,
        );
      }
    },
    // 6. phase report cost_llm_cents >= 0.
    async (_t, ctx) => {
      const reports = ctx.phase_reports ?? [];
      if (reports.length === 0) {
        throw new Error('expected at least one phase report on ctx');
      }
      const cost = reports[0].cost_llm_cents ?? -1;
      if (cost < 0) {
        throw new Error(
          `expected cost_llm_cents >= 0 on phase report, got ${cost}`,
        );
      }
    },
  ],
};

export default scenario;
