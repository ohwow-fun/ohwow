/**
 * TUI Journey Simulator
 *
 * Renders every major screen and state using ink-testing-library and prints the
 * visual output to stdout. Run with:
 *
 *   npx tsx scripts/tui-journey.tsx
 *
 * No daemon, no database, no network required — pure component rendering.
 */

import React from 'react';
import { render } from 'ink-testing-library';

// Onboarding steps
import { SplashStep } from '../src/tui/screens/onboarding/SplashStep.js';
import { TierChoiceStep } from '../src/tui/screens/onboarding/TierChoiceStep.js';
import { FirstMomentStep } from '../src/tui/screens/onboarding/FirstMomentStep.js';
import { AgentDiscoveryStep } from '../src/tui/screens/onboarding/AgentDiscoveryStep.js';
import { AgentSelectionStep } from '../src/tui/screens/onboarding/AgentSelectionStep.js';
import { ReadyStep } from '../src/tui/screens/onboarding/ReadyStep.js';

// Main screens
import { AgentsList } from '../src/tui/screens/agents-list.js';
import { TasksList } from '../src/tui/screens/tasks-list.js';
import { TodayBoard } from '../src/tui/screens/dashboard/index.js';

// Components
import { KeyHints } from '../src/tui/components/key-hints.js';
import { AgentCard } from '../src/tui/components/agent-card.js';
import { SectionNav } from '../src/tui/components/section-nav.js';
import { Section } from '../src/tui/types.js';
import type { TeamSubTab, WorkSubTab } from '../src/tui/components/section-nav.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const COLS = 80;

function header(title: string, journey: string) {
  const line = '─'.repeat(COLS);
  console.log('\n' + line);
  console.log(`  📍 ${journey}  ›  ${title}`);
  console.log(line);
}

function capture(element: React.ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const frame = lastFrame() ?? '(empty)';
  unmount();
  return frame;
}

function show(title: string, journey: string, element: React.ReactElement) {
  header(title, journey);
  console.log(capture(element));
}

// ─── mock data ───────────────────────────────────────────────────────────────

const MOCK_PRESETS = [
  {
    id: 'sales',
    name: 'Sales Agent',
    role: 'Sales Representative',
    description: 'Qualifies leads, follows up on deals, drafts outreach emails.',
    systemPrompt: '',
    recommended: true,
  },
  {
    id: 'marketing',
    name: 'Marketing Agent',
    role: 'Marketing Manager',
    description: 'Creates content, manages campaigns, tracks performance metrics.',
    systemPrompt: '',
    recommended: true,
  },
  {
    id: 'support',
    name: 'Support Agent',
    role: 'Customer Support',
    description: 'Handles customer questions, triages issues, drafts replies.',
    systemPrompt: '',
    recommended: false,
  },
  {
    id: 'ops',
    name: 'Ops Agent',
    role: 'Operations Manager',
    description: 'Tracks KPIs, schedules meetings, keeps the team on track.',
    systemPrompt: '',
    recommended: false,
  },
];

const MOCK_AGENTS = [
  { id: 'a1', name: 'Sales Agent', role: 'Sales Representative', status: 'idle', stats: { total_tasks: 42, cost_cents: 380 } },
  { id: 'a2', name: 'Marketing Agent', role: 'Marketing Manager', status: 'working', stats: { total_tasks: 17, cost_cents: 150 } },
  { id: 'a3', name: 'Support Agent', role: 'Customer Support', status: 'idle', stats: { total_tasks: 93, cost_cents: 820 } },
  { id: 'a4', name: 'Ops Agent', role: 'Operations Manager', status: 'error', stats: { total_tasks: 5, cost_cents: 40 } },
];

const MOCK_TASKS = [
  { id: 't1', agent_id: 'a1', title: 'Qualify leads from HubSpot export', status: 'completed', tokens_used: 1200, priority: 'high', created_at: new Date(Date.now() - 3_600_000).toISOString() },
  { id: 't2', agent_id: 'a2', title: 'Write Q2 launch email sequence', status: 'in_progress', tokens_used: 800, priority: 'urgent', created_at: new Date(Date.now() - 1_200_000).toISOString() },
  { id: 't3', agent_id: 'a3', title: 'Reply to 14 open support tickets', status: 'needs_approval', tokens_used: 2400, priority: 'normal', created_at: new Date(Date.now() - 600_000).toISOString() },
  { id: 't4', agent_id: 'a1', title: 'Draft follow-up for cold outreach batch', status: 'pending', tokens_used: null, priority: 'normal', created_at: new Date(Date.now() - 180_000).toISOString() },
  { id: 't5', agent_id: 'a4', title: 'Compile weekly KPI report', status: 'failed', tokens_used: 200, priority: 'low', created_at: new Date(Date.now() - 86_400_000).toISOString() },
];

const MOCK_AGENT_HEALTH = [
  { name: 'Sales Agent', role: 'Sales Representative', status: 'idle' as const, taskCount: 42, costCents: 380 },
  { name: 'Marketing Agent', role: 'Marketing Manager', status: 'working' as const, taskCount: 17, costCents: 150 },
  { name: 'Support Agent', role: 'Customer Support', status: 'idle' as const, taskCount: 93, costCents: 820 },
];

const MOCK_SELECTED_MODEL = {
  tag: 'mistral:7b',
  label: 'Mistral 7B',
  description: 'Fast general-purpose model',
  sizeGb: 4.1,
  ramGb: 8,
  tier: 'fast' as const,
  recommended: true,
  downloadUrl: '',
};

// ─── Journey 1: First-time onboarding ─────────────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 1  ›  First-time Onboarding  (new user, no config)');
console.log('═'.repeat(COLS));

show('Splash — First run', 'Onboarding',
  <SplashStep />
);

show('Splash — License checking', 'Onboarding',
  <SplashStep loading={true} />
);

show('Splash — License expired error', 'Onboarding',
  <SplashStep error="Your license has expired." errorKind="expired" />
);

show('Splash — Network error (offline)', 'Onboarding',
  <SplashStep error="Could not reach the cloud." errorKind="network" />
);

show('Tier Choice — Empty (waiting for key)', 'Onboarding',
  <TierChoiceStep licenseKey="" validating={false} error="" />
);

show('Tier Choice — Key being typed', 'Onboarding',
  <TierChoiceStep licenseKey="OWW-XXXXXXXX-YYY" validating={false} error="" />
);

show('Tier Choice — Validating', 'Onboarding',
  <TierChoiceStep licenseKey="OWW-XXXXXXXX-YYY" validating={true} error="" />
);

show('Tier Choice — Invalid key error', 'Onboarding',
  <TierChoiceStep licenseKey="OWW-BADKEY" validating={false} error="That key isn't valid. Double-check and try again." />
);

show('First Moment — Business name field active', 'Onboarding',
  <FirstMomentStep
    businessName=""
    firstTask=""
    activeField="businessName"
  />
);

show('First Moment — First task field active (name entered)', 'Onboarding',
  <FirstMomentStep
    businessName="Acme Corp"
    firstTask=""
    activeField="firstTask"
  />
);

show('First Moment — Both fields filled', 'Onboarding',
  <FirstMomentStep
    businessName="Acme Corp"
    firstTask="Research my top 10 competitors and summarise their pricing"
    activeField="firstTask"
  />
);

show('Agent Discovery — No model (preset fallback)', 'Onboarding',
  <AgentDiscoveryStep
    modelAvailable={false}
    chatMessages={[]}
    chatInput=""
    chatStreaming={false}
    recommendedAgents={MOCK_PRESETS.filter(p => p.recommended)}
    presets={MOCK_PRESETS}
  />
);

show('Agent Discovery — AI chat (with conversation)', 'Onboarding',
  <AgentDiscoveryStep
    modelAvailable={true}
    chatMessages={[
      { role: 'assistant', content: "Hi! Tell me about your business and I'll recommend the right agents." },
      { role: 'user', content: "I run a SaaS startup focused on sales automation." },
      { role: 'assistant', content: "Great! For a SaaS sales focus, I'd recommend a Sales Agent for outreach, a Marketing Agent for content, and a Support Agent for customer queries. Want me to add all three?" },
    ]}
    chatInput="Yes, add all three"
    chatStreaming={false}
    recommendedAgents={MOCK_PRESETS.filter(p => p.recommended)}
    presets={MOCK_PRESETS}
  />
);

show('Agent Discovery — AI streaming response', 'Onboarding',
  <AgentDiscoveryStep
    modelAvailable={true}
    chatMessages={[
      { role: 'user', content: "I run a SaaS startup focused on sales automation." },
      { role: 'assistant', content: "Based on your focus, I'd suggest..." },
    ]}
    chatInput=""
    chatStreaming={true}
    recommendedAgents={[]}
    presets={MOCK_PRESETS}
  />
);

show('Agent Selection — Interactive (new user)', 'Onboarding',
  <AgentSelectionStep
    presets={MOCK_PRESETS}
    selectedIds={new Set(['sales', 'marketing'])}
    cursorIndex={1}
    readonlyMode={false}
  />
);

show('Agent Selection — Readonly (returning user, healthy)', 'Onboarding',
  <AgentSelectionStep
    presets={MOCK_PRESETS}
    selectedIds={new Set(['sales', 'marketing', 'support'])}
    cursorIndex={0}
    readonlyMode={true}
    agentHealth={MOCK_AGENT_HEALTH}
  />
);

show('Agent Selection — Empty state (cloud, no agents)', 'Onboarding',
  <AgentSelectionStep
    presets={[]}
    selectedIds={new Set()}
    cursorIndex={0}
    emptyState={true}
  />
);

show('Ready — New user (3 agents, no model)', 'Onboarding',
  <ReadyStep
    businessName="Acme Corp"
    selectedModel={null}
    agentCount={3}
  />
);

show('Ready — New user (3 agents, Mistral 7B)', 'Onboarding',
  <ReadyStep
    businessName="Acme Corp"
    selectedModel={MOCK_SELECTED_MODEL}
    agentCount={3}
  />
);

show('Ready — Returning user (health summary)', 'Onboarding',
  <ReadyStep
    businessName="Acme Corp"
    selectedModel={MOCK_SELECTED_MODEL}
    agentCount={3}
    healthSummary={{
      totalTasks: 152,
      totalCostCents: 1350,
      agentErrors: 1,
      agentCount: 3,
      modelReady: true,
      modelName: 'Mistral 7B',
    }}
  />
);

// ─── Journey 2: Returning user splash ─────────────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 2  ›  Returning User  (existing config + agents)');
console.log('═'.repeat(COLS));

show('Splash — Welcome back', 'Returning',
  <SplashStep businessName="Acme Corp" />
);

show('Splash — License invalid (device conflict)', 'Returning',
  <SplashStep
    businessName="Acme Corp"
    error="This license is already in use on another device."
    errorKind="device_conflict"
  />
);

// ─── Journey 3: Main dashboard screens ────────────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 3  ›  Dashboard Screens  (post-onboarding, live data)');
console.log('═'.repeat(COLS));

show('Agents List — 4 agents (one working, one error)', 'Dashboard › Agents',
  <AgentsList agents={MOCK_AGENTS} onSelect={() => {}} />
);

show('Agents List — Empty state', 'Dashboard › Agents',
  <AgentsList agents={[]} onSelect={() => {}} />
);

show('Tasks List — Mixed statuses', 'Dashboard › Tasks',
  <TasksList
    tasks={MOCK_TASKS}
    agents={MOCK_AGENTS.map(a => ({ id: a.id, name: a.name }))}
    onSelect={() => {}}
  />
);

show('Tasks List — Empty state', 'Dashboard › Tasks',
  <TasksList tasks={[]} agents={[]} onSelect={() => {}} />
);

// ─── Journey 4: Component gallery ─────────────────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 4  ›  Component Gallery  (individual UI atoms)');
console.log('═'.repeat(COLS));

show('Key Hints — Navigation hints', 'Components',
  <KeyHints hints={[
    { key: '↑↓', label: 'Navigate' },
    { key: 'Enter', label: 'Select' },
    { key: 'Esc', label: 'Back' },
    { key: 'c', label: 'Create' },
    { key: 'Ctrl+K', label: 'Command palette' },
  ]} />
);

show('Agent Card — Idle agent', 'Components',
  <AgentCard name="Sales Agent" role="Sales Representative" status="idle" taskCount={42} costDollars="3.80" isSelected={false} />
);

show('Agent Card — Working agent (selected)', 'Components',
  <AgentCard name="Marketing Agent" role="Marketing Manager" status="working" taskCount={17} costDollars="1.50" isSelected={true} />
);

show('Agent Card — Error agent', 'Components',
  <AgentCard name="Ops Agent" role="Operations Manager" status="error" taskCount={5} costDollars="0.40" isSelected={false} />
);

// ─── Journey 5: Today state board (TRIO-06) ─────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 5  ›  Today State Board  (TRIO-06 attention queue)');
console.log('═'.repeat(COLS));

show('Today Board — 4 agents, no db (empty attention queue)', 'Dashboard › Today',
  <TodayBoard agents={MOCK_AGENTS} db={null} />
);

show('Today Board — Empty agents, no db', 'Dashboard › Today',
  <TodayBoard agents={[]} db={null} />
);

// ─── Journey 6: 4-section nav bar (TRIO-07) ─────────────────────────────

console.log('\n\n' + '═'.repeat(COLS));
console.log('  JOURNEY 6  ›  4-Section Nav Bar  (TRIO-07)');
console.log('═'.repeat(COLS));

show('SectionNav — Today active (home)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Today} />
);

show('SectionNav — Team active (Agents)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Team} teamSubTab={'agents' as TeamSubTab} />
);

show('SectionNav — Team active (Contacts)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Team} teamSubTab={'contacts' as TeamSubTab} />
);

show('SectionNav — Team active (People)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Team} teamSubTab={'people' as TeamSubTab} />
);

show('SectionNav — Work active (Tasks)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Work} workSubTab={'tasks' as WorkSubTab} />
);

show('SectionNav — Work active (Activity)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Work} workSubTab={'activity' as WorkSubTab} />
);

show('SectionNav — Work active (Automations)', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Work} workSubTab={'automations' as WorkSubTab} />
);

show('SectionNav — Settings active', 'Dashboard › Nav',
  <SectionNav activeSection={Section.Settings} />
);

// ─── Footer ──────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(COLS));
console.log('  ✓  Simulation complete. All screens rendered successfully.');
console.log('═'.repeat(COLS) + '\n');
