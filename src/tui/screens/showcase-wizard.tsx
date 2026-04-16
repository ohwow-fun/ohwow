/**
 * Showcase Wizard
 * The interactive flow behind `ohwow showcase <target>`.
 *
 * Steps: splash → research (streaming findings) → proposal → executing → done.
 * Renders standalone (no Dashboard shell) because the CLI invokes it as a
 * one-shot terminal experience.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type {
  ShowcaseFinding,
  ShowcaseOutcome,
  ShowcasePlan,
  ShowcaseResult,
  ShowcaseTarget,
} from '../../showcase/types.js';
import { runResearch } from '../../showcase/research.js';
import { buildPlan } from '../../showcase/plan.js';
import { applyShowcase } from '../../showcase/setup.js';
import { KeyHints } from '../components/key-hints.js';

type Step = 'splash' | 'research' | 'proposal' | 'executing' | 'done' | 'error';

interface ShowcaseWizardProps {
  db: DatabaseAdapter;
  workspaceId: string;
  workspaceName: string;
  dashboardUrl: string;
  ollamaModel?: string;
  target: ShowcaseTarget;
}

const findingColor: Record<ShowcaseFinding['kind'], string> = {
  resolve: 'cyan',
  fetch: 'gray',
  title: 'white',
  description: 'white',
  snippet: 'gray',
  note: 'gray',
  warning: 'yellow',
};

const findingGlyph: Record<ShowcaseFinding['kind'], string> = {
  resolve: '◆',
  fetch: '→',
  title: '•',
  description: '•',
  snippet: '•',
  note: '·',
  warning: '!',
};

export function ShowcaseWizard({
  db,
  workspaceId,
  workspaceName,
  dashboardUrl,
  ollamaModel,
  target,
}: ShowcaseWizardProps) {
  const { exit } = useApp();

  const [step, setStep] = useState<Step>('splash');
  const [findings, setFindings] = useState<ShowcaseFinding[]>([]);
  const [result, setResult] = useState<ShowcaseResult | null>(null);
  const [plan, setPlan] = useState<ShowcasePlan | null>(null);
  const [outcome, setOutcome] = useState<ShowcaseOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guard against double-firing from Strict-Mode-ish effect semantics.
  const researchStarted = useRef(false);
  const executionStarted = useRef(false);

  useInput((input, key) => {
    if (step === 'splash' && (key.return || input === ' ')) {
      setStep('research');
      return;
    }
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

  // ── Research phase ──────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'research' || researchStarted.current) return;
    researchStarted.current = true;

    (async () => {
      try {
        const gen = runResearch(target);
        while (true) {
          const next = await gen.next();
          if (next.done) {
            const finalResult = next.value;
            setResult(finalResult);
            setPlan(buildPlan(finalResult));
            setStep('proposal');
            return;
          }
          setFindings(prev => [...prev, next.value]);
          // Breathe between bullets so the UI feels alive rather than a blob.
          await new Promise(r => setTimeout(r, 120));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, [step, target]);

  // ── Execute phase ───────────────────────────────────────────────────────
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
        });
        setOutcome(o);
        setStep('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      }
    })();
  }, [step, db, workspaceId, target, result, plan, ollamaModel]);

  const hints = useMemo(() => {
    if (step === 'splash') return [{ key: 'Enter', label: 'start' }, { key: 'Esc', label: 'cancel' }];
    if (step === 'proposal') return [{ key: 'y', label: 'apply' }, { key: 'n', label: 'cancel' }];
    if (step === 'done' || step === 'error') return [{ key: 'Enter', label: 'close' }];
    return [{ key: 'Esc', label: 'cancel' }];
  }, [step]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Banner workspaceName={workspaceName} />

      {step === 'splash' && <SplashBody target={target} />}
      {step === 'research' && <ResearchBody target={target} findings={findings} />}
      {step === 'proposal' && plan && result && (
        <ProposalBody target={target} plan={plan} findings={findings} />
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

      <Box marginTop={1}>
        <KeyHints hints={hints} />
      </Box>
    </Box>
  );
}

// ── Subcomponents ─────────────────────────────────────────────────────────

function Banner({ workspaceName }: { workspaceName: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">ohwow showcase</Text>
      <Text color="gray">workspace: {workspaceName}</Text>
    </Box>
  );
}

function SplashBody({ target }: { target: ShowcaseTarget }) {
  return (
    <Box flexDirection="column">
      <Text>Ready to research <Text bold color="cyan">{target.name}</Text> ({target.kind}) and set up a tailored agent.</Text>
      {target.url && <Text color="gray">URL: {target.url}</Text>}
      {target.company && target.kind === 'person' && <Text color="gray">Company: {target.company}</Text>}
      {target.email && <Text color="gray">Email: {target.email}</Text>}
      <Box marginTop={1}>
        <Text color="gray">Press <Text bold color="white">Enter</Text> to begin.</Text>
      </Box>
    </Box>
  );
}

function ResearchBody({ target, findings }: { target: ShowcaseTarget; findings: ShowcaseFinding[] }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow"><Spinner type="dots" /></Text>
        <Text> Researching <Text bold>{target.name}</Text>…</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {findings.map((f, i) => (
          <Text key={i} color={findingColor[f.kind]}>
            {findingGlyph[f.kind]} {f.text}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ProposalBody({
  target,
  plan,
  findings,
}: {
  target: ShowcaseTarget;
  plan: ShowcasePlan;
  findings: ShowcaseFinding[];
}) {
  const headline = findings.find(f => f.kind === 'description' || f.kind === 'title');
  return (
    <Box flexDirection="column">
      <Text bold color="green">Research complete.</Text>
      {headline && <Text color="gray">{headline.text}</Text>}

      <Box
        flexDirection="column"
        marginTop={1}
        paddingX={1}
        borderStyle="round"
        borderColor="cyan"
      >
        <Text bold color="cyan">Proposed setup</Text>
        <Box marginTop={1} flexDirection="column">
          <Text><Text color="gray">Agent    </Text>{plan.agentName} <Text color="gray">— {plan.agentRole}</Text></Text>
          <Text><Text color="gray">Project  </Text>{plan.projectName}</Text>
          <Text><Text color="gray">Goal     </Text>{plan.goalTitle}</Text>
          <Text><Text color="gray">Contact  </Text>{plan.contactName} <Text color="gray">({target.kind})</Text></Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">System prompt (preview):</Text>
          <Text>{plan.agentSystemPrompt.slice(0, 220)}{plan.agentSystemPrompt.length > 220 ? '…' : ''}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text>Apply this setup? <Text bold color="white">y</Text>/<Text bold color="white">n</Text></Text>
      </Box>
    </Box>
  );
}

function ExecutingBody({ plan }: { plan: ShowcasePlan }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow"><Spinner type="dots" /></Text>
        <Text> Creating {plan.contactName} contact, {plan.projectName} project, goal, and agent…</Text>
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
    <Box flexDirection="column">
      <Text bold color="green">✓ Done.</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text><Text color="gray">agent_id    </Text>{outcome.agentId}</Text>
        <Text><Text color="gray">project_id  </Text>{outcome.projectId}</Text>
        <Text><Text color="gray">goal_id     </Text>{outcome.goalId}</Text>
        <Text><Text color="gray">contact_id  </Text>{outcome.contactId}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">Open the dashboard:</Text>
        <Text>  {dashboardUrl}/agents</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">Use from Claude Code:</Text>
        <Text color="gray">  ohwow setup-claude-code  <Text dimColor>(once)</Text></Text>
        <Text color="gray">  then ask: "ohwow_list_agents in workspace {workspaceName}"</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Agent name: <Text color="white">{plan.agentName}</Text></Text>
      </Box>
    </Box>
  );
}

function ErrorBody({ message }: { message: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color="red">Showcase failed.</Text>
      <Text color="red">{message}</Text>
    </Box>
  );
}
