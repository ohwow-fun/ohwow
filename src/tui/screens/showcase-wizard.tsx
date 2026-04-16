/**
 * Showcase Wizard — scanner edition.
 *
 * Fast, entertaining first-impression flow for `ohwow showcase <target>`.
 * Splash is a 400ms reveal (no Enter gate); research is a parallel probe
 * fleet rendered as a dense "scanner" with in-place glyph flips and a
 * live stats ticker. Proposal still gates on y/n because we're about to
 * write to the DB.
 */

import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type Database from 'better-sqlite3';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type {
  ShowcaseOutcome,
  ShowcasePlan,
  ShowcaseResult,
  ShowcaseTarget,
} from '../../showcase/types.js';
import { runResearch, type ProbeEvent, type ProbeStats } from '../../showcase/research.js';
import { buildPlan } from '../../showcase/plan.js';
import { applyShowcase } from '../../showcase/setup.js';
import { KeyHints } from '../components/key-hints.js';

type Step = 'splash' | 'research' | 'proposal' | 'executing' | 'done' | 'error';

interface ShowcaseWizardProps {
  db: DatabaseAdapter;
  /** Raw sqlite handle — used to wrap the four apply-inserts in a transaction. */
  rawDb?: Database.Database;
  workspaceId: string;
  workspaceName: string;
  dashboardUrl: string;
  ollamaModel?: string;
  target: ShowcaseTarget;
}

// ── Scanner state (reducer) ─────────────────────────────────────────────

interface ProbeRow {
  id: string;
  label: string;
  status: ProbeEvent['status'];
  detail?: string;
  elapsedMs?: number;
  order: number;
}

interface ScannerState {
  rows: Map<string, ProbeRow>;
  order: string[];
  stats: ProbeStats;
  summary?: string;
}

const EMPTY_STATS: ProbeStats = {
  pagesScanned: 0,
  charsRead: 0,
  linksFound: 0,
  headingsFound: 0,
  dbHits: 0,
};

function scannerReducer(state: ScannerState, event: ProbeEvent): ScannerState {
  if (event.id === '__summary__') {
    return { ...state, summary: event.detail };
  }
  const rows = new Map(state.rows);
  const existing = rows.get(event.id);
  const order = existing ? state.order : [...state.order, event.id];
  rows.set(event.id, {
    id: event.id,
    label: event.label,
    status: event.status,
    detail: event.detail ?? existing?.detail,
    elapsedMs: event.elapsedMs ?? existing?.elapsedMs,
    order: existing?.order ?? order.length - 1,
  });
  const stats: ProbeStats = { ...state.stats };
  if (event.stats) {
    const s = stats as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(event.stats)) {
      if (typeof v === 'number') {
        s[k] = (s[k] ?? 0) + v;
      }
    }
  }
  return { rows, order, stats, summary: state.summary };
}

const GLYPH: Record<ProbeEvent['status'], string> = {
  running: '⧖',
  ok: '✓',
  fail: '✗',
  info: '◆',
};

const GLYPH_COLOR: Record<ProbeEvent['status'], string> = {
  running: 'yellow',
  ok: 'green',
  fail: 'red',
  info: 'cyan',
};

// ── Main component ──────────────────────────────────────────────────────

export function ShowcaseWizard({
  db,
  rawDb,
  workspaceId,
  workspaceName,
  dashboardUrl,
  ollamaModel,
  target,
}: ShowcaseWizardProps) {
  const { exit } = useApp();

  const [step, setStep] = useState<Step>('splash');
  const [scanner, dispatchScanner] = useReducer(scannerReducer, {
    rows: new Map(),
    order: [],
    stats: { ...EMPTY_STATS },
  });
  const [result, setResult] = useState<ShowcaseResult | null>(null);
  const [plan, setPlan] = useState<ShowcasePlan | null>(null);
  const [outcome, setOutcome] = useState<ShowcaseOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const researchStarted = useRef(false);
  const executionStarted = useRef(false);

  // Auto-advance splash → research after 400ms. No Enter gate: we want the
  // user to feel ohwow launch *at* them, not wait on input.
  useEffect(() => {
    if (step !== 'splash') return;
    const t = setTimeout(() => setStep('research'), 400);
    return () => clearTimeout(t);
  }, [step]);

  useInput((input, key) => {
    if (step === 'proposal') {
      if (input === 'y' || key.return) {
        setStep('executing');
        return;
      }
      if (input === 'n' || key.escape) {
        exit();
        return;
      }
    }
    if (step === 'done' || step === 'error') {
      if (key.return || input === 'q' || key.escape) {
        exit();
      }
    }
    if (key.escape && step !== 'executing') {
      exit();
    }
  });

  // Research — stream probe events into the scanner state.
  useEffect(() => {
    if (step !== 'research' || researchStarted.current) return;
    researchStarted.current = true;

    (async () => {
      try {
        const gen = runResearch(target, { db, workspaceId });
        while (true) {
          const next = await gen.next();
          if (next.done) {
            const finalResult = next.value;
            setResult(finalResult);
            setPlan(buildPlan(finalResult));
            // Short beat so the final "research complete · 847ms" line
            // stays on screen before the proposal card slams in.
            setTimeout(() => setStep('proposal'), 200);
            return;
          }
          dispatchScanner(next.value);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, [step, target, db, workspaceId]);

  // Execute — 4 DB inserts, near-instant.
  useEffect(() => {
    if (step !== 'executing' || executionStarted.current) return;
    if (!result || !plan) return;
    executionStarted.current = true;

    (async () => {
      try {
        const o = await applyShowcase(db, {
          workspaceId,
          target,
          result,
          plan,
          ollamaModel,
          rawDb,
        });
        setOutcome(o);
        setStep('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, [step, db, rawDb, workspaceId, target, result, plan, ollamaModel]);

  const hints = useMemo(() => {
    if (step === 'proposal') return [{ key: 'y', label: 'apply' }, { key: 'n', label: 'cancel' }];
    if (step === 'done' || step === 'error') return [{ key: 'Enter', label: 'close' }];
    if (step === 'executing') return [];
    return [{ key: 'Esc', label: 'cancel' }];
  }, [step]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header target={target} workspaceName={workspaceName} step={step} />

      {step === 'splash' && <SplashBody target={target} />}
      {(step === 'research' || step === 'proposal') && (
        <ScannerBody scanner={scanner} running={step === 'research'} />
      )}
      {step === 'proposal' && plan && (
        <ProposalBody target={target} plan={plan} result={result} />
      )}
      {step === 'executing' && plan && <ExecutingBody plan={plan} />}
      {step === 'done' && plan && outcome && (
        <DoneBody
          plan={plan}
          outcome={outcome}
          dashboardUrl={dashboardUrl}
          workspaceName={workspaceName}
        />
      )}
      {step === 'error' && <ErrorBody message={error ?? 'Unknown error'} />}

      {hints.length > 0 && (
        <Box marginTop={1}>
          <KeyHints hints={hints} />
        </Box>
      )}
    </Box>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────

function Header({
  target,
  workspaceName,
  step,
}: {
  target: ShowcaseTarget;
  workspaceName: string;
  step: Step;
}) {
  const phase =
    step === 'splash'
      ? 'booting'
      : step === 'research'
        ? 'scanning'
        : step === 'proposal'
          ? 'proposing'
          : step === 'executing'
            ? 'writing'
            : step === 'done'
              ? 'done'
              : 'error';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color="cyan">ohwow</Text>
        <Text color="gray">.showcase(</Text>
        <Text bold color="white">{target.name}</Text>
        <Text color="gray">) </Text>
        <Text color="gray">· workspace:{workspaceName}</Text>
        <Text color="gray">  </Text>
        <Text color={phase === 'error' ? 'red' : phase === 'done' ? 'green' : 'yellow'}>
          [{phase}]
        </Text>
      </Text>
    </Box>
  );
}

function SplashBody({ target }: { target: ShowcaseTarget }) {
  return (
    <Box flexDirection="column">
      <Text color="cyan">
        <Spinner type="dots" />
        <Text color="gray"> initializing scanner for </Text>
        <Text bold color="white">{target.name}</Text>
        <Text color="gray"> ({target.kind})</Text>
      </Text>
      {target.url && <Text color="gray">  url: {target.url}</Text>}
      {target.company && target.kind === 'person' && (
        <Text color="gray">  company: {target.company}</Text>
      )}
      {target.email && <Text color="gray">  email: {target.email}</Text>}
    </Box>
  );
}

function ScannerBody({
  scanner,
  running,
}: {
  scanner: ScannerState;
  running: boolean;
}) {
  const rows = scanner.order.map(id => scanner.rows.get(id)!).filter(Boolean);
  const s = scanner.stats;
  const counters: Array<[string, string | number]> = [
    ['pages', s.pagesScanned],
    ['chars', formatThousands(s.charsRead)],
    ['links', s.linksFound],
    ['h1-6', s.headingsFound],
    ['db_hits', s.dbHits],
  ];

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {rows.map(r => (
          <Box key={r.id}>
            <Text color={GLYPH_COLOR[r.status]}>{GLYPH[r.status]}</Text>
            <Text> </Text>
            <Text color={r.status === 'running' ? 'gray' : 'white'}>
              {padRight(r.label, 22)}
            </Text>
            <Text color="gray">  {r.detail ?? ''}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">{running ? '▸' : '◆'} </Text>
        {counters.map(([k, v], i) => (
          <Text key={k}>
            {i > 0 ? <Text color="gray">  ·  </Text> : null}
            <Text color="gray">{k}=</Text>
            <Text bold color="cyan">{v}</Text>
          </Text>
        ))}
        {scanner.summary && (
          <Text color="gray">  ·  {scanner.summary}</Text>
        )}
      </Box>
    </Box>
  );
}

function ProposalBody({
  target,
  plan,
  result,
}: {
  target: ShowcaseTarget;
  plan: ShowcasePlan;
  result: ShowcaseResult | null;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {result?.pageDescription && (
        <Text color="gray">{'“'}{truncateAtWord(result.pageDescription, 160)}{'”'}</Text>
      )}
      <Box
        flexDirection="column"
        marginTop={1}
        paddingX={1}
        borderStyle="round"
        borderColor="cyan"
      >
        <Text bold color="cyan">Proposed setup</Text>
        <Box marginTop={1} flexDirection="column">
          <Row label="agent"   value={plan.agentName}   aux={plan.agentRole} />
          <Row label="project" value={plan.projectName} />
          <Row label="goal"    value={plan.goalTitle} />
          <Row label="contact" value={plan.contactName} aux={target.kind} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">system prompt:</Text>
          <Text>{truncateAtWord(plan.agentSystemPrompt, 220)}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text>Apply? <Text bold color="white">y</Text>/<Text bold color="white">n</Text></Text>
      </Box>
    </Box>
  );
}

function ExecutingBody({ plan }: { plan: ShowcasePlan }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="yellow"><Spinner type="dots" /></Text>
        <Text color="gray"> writing: contact · project · goal · agent ({plan.agentName})</Text>
      </Box>
    </Box>
  );
}

function DoneBody({
  plan,
  outcome,
  dashboardUrl,
  workspaceName,
}: {
  plan: ShowcasePlan;
  outcome: ShowcaseOutcome;
  dashboardUrl: string;
  workspaceName: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">✓ live in workspace.</Text>
      <Box flexDirection="column" marginTop={1}>
        <Row label="agent"    value={outcome.agentId}   aux={plan.agentName}  mono />
        <Row label="project"  value={outcome.projectId} aux={plan.projectName} mono />
        <Row label="goal"     value={outcome.goalId}                            mono />
        <Row label="contact"  value={outcome.contactId} aux={plan.contactName} mono />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">→ dashboard:  <Text color="white">{dashboardUrl}/agents</Text></Text>
        <Text color="cyan">→ claude:     <Text color="gray">ohwow setup-claude-code</Text></Text>
        <Text color="gray">              then ask Claude: "list agents in workspace {workspaceName}"</Text>
      </Box>
    </Box>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="red">✗ showcase failed.</Text>
      <Text color="red">{message}</Text>
    </Box>
  );
}

function Row({
  label,
  value,
  aux,
  mono,
}: {
  label: string;
  value: string;
  aux?: string;
  mono?: boolean;
}) {
  return (
    <Text>
      <Text color="gray">{padRight(label, 8)}</Text>
      <Text color={mono ? 'gray' : 'white'}>{value}</Text>
      {aux && (
        <>
          <Text color="gray">  · </Text>
          <Text color="gray">{aux}</Text>
        </>
      )}
    </Text>
  );
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncateAtWord(s: string, n: number): string {
  if (s.length <= n) return s;
  const slice = s.slice(0, n);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > n * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:!?-]+$/, '') + '…';
}

function formatThousands(n: number): string {
  return n.toLocaleString('en-US');
}
