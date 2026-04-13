import { describe, it, expect } from 'vitest';
import { buildLocalSystemPrompt, buildLocalPlatformAddendum, buildCompactDynamicContext, buildCompactStaticInstructionsForIntent, buildStaticInstructionsForIntent, buildDynamicContext, buildMicroStaticInstructions, buildMicroDynamicContext, type BuildLocalSystemPromptArgs } from '../system-prompt.js';

// ─── Fixtures ───

function baseArgs(overrides: Partial<BuildLocalSystemPromptArgs> = {}): BuildLocalSystemPromptArgs {
  return {
    agents: [
      { id: 'a1', name: 'Scout', role: 'Sales', status: 'idle' },
      { id: 'a2', name: 'Writer', role: 'Content', status: 'active' },
    ],
    business: { name: 'TestCo', type: 'SaaS' },
    dashboardContext: { pendingApprovals: 2, activeAgents: 1 },
    ...overrides,
  };
}

// ─── Tests ───

describe('buildLocalSystemPrompt', () => {
  it('includes business name in the opening line', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).toContain('operations partner for TestCo');
  });

  it('falls back to "the business" when business is null', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({ business: null }));
    expect(prompt).toContain('operations partner for the business');
  });

  it('lists agents with name, role, status, and id', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).toContain('- Scout (Sales) [idle] [id: a1]');
    expect(prompt).toContain('- Writer (Content) [active] [id: a2]');
  });

  it('appends agent stats when provided', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      agents: [
        {
          id: 'a1', name: 'Scout', role: 'Sales', status: 'idle',
          stats: { successRate: 95, avgDuration: 12, totalTasks: 40 },
        },
      ],
    }));
    expect(prompt).toContain('95% success');
    expect(prompt).toContain('avg 12s');
    expect(prompt).toContain('40 tasks');
  });

  it('renders memory section when orchestratorMemory is provided', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      orchestratorMemory: 'User prefers email updates on Mondays.',
    }));
    expect(prompt).toContain('## Your Memory');
    expect(prompt).toContain('User prefers email updates on Mondays.');
  });

  it('omits memory section when orchestratorMemory is undefined', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).not.toContain('## Your Memory');
  });

  it('injects copywriting rules unconditionally for the root orchestrator', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).toContain('## Copywriting Rules');
    expect(prompt).toContain('No dashes as sentence connectors');
    expect(prompt).toContain('No development-time claims');
  });

  it('compact dynamic context carries the terse copywriting rules variant', () => {
    const compact = buildCompactDynamicContext(baseArgs());
    expect(compact).toContain('## Copywriting');
    expect(compact).toContain('No dashes as sentence connectors');
  });

  it('the COPYWRITING_RULES block itself contains no em-dashes or en-dashes', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    const startIdx = prompt.indexOf('## Copywriting Rules');
    expect(startIdx).toBeGreaterThan(-1);
    const rulesBlock = prompt.slice(startIdx, startIdx + 2500);
    expect(rulesBlock).not.toMatch(/\u2014/);
    expect(rulesBlock).not.toMatch(/\u2013/);
  });

  it('renders business context with growth stage label', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      business: { name: 'GrowthCo', type: 'Agency', growthStage: 5 },
    }));
    expect(prompt).toContain('## Business Context');
    expect(prompt).toContain('Growth stage: Growing (5/9)');
  });

  it('renders monthly revenue formatted as dollars', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      business: { name: 'RevCo', type: 'eComm', monthlyRevenueCents: 1250000 },
    }));
    expect(prompt).toContain('Monthly revenue: $12,500');
  });

  it('omits revenue line when monthlyRevenueCents is 0', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      business: { name: 'FreeCo', type: 'Open Source', monthlyRevenueCents: 0 },
    }));
    expect(prompt).not.toContain('Monthly revenue');
  });

  it('renders growth goals', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      business: { name: 'GoalCo', type: 'SaaS', growthGoals: ['MRR $10k', 'Launch v2'] },
    }));
    expect(prompt).toContain('Growth goals: MRR $10k, Launch v2');
  });

  it('renders Today\'s Pulse section with momentum', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      businessPulse: {
        tasksCompletedToday: 8,
        tasksCompletedYesterday: 5,
        totalLeads: 20,
        totalCustomers: 10,
        totalContacts: 50,
        recentContactEvents: 3,
      },
    }));
    expect(prompt).toContain("## Today's Pulse");
    expect(prompt).toContain('Tasks completed today: 8');
    expect(prompt).toContain('Ahead of yesterday (8 vs 5)');
    expect(prompt).toContain('Pipeline: 20 leads');
  });

  it('renders matching pace momentum when today equals yesterday', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      businessPulse: {
        tasksCompletedToday: 5,
        tasksCompletedYesterday: 5,
        totalLeads: 0, totalCustomers: 0, totalContacts: 0, recentContactEvents: 0,
      },
    }));
    expect(prompt).toContain("Matching yesterday's pace (5)");
  });

  it('renders projects list', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      projects: [
        { id: 'p1', name: 'Launch Campaign', status: 'active', taskCount: 3 },
      ],
    }));
    expect(prompt).toContain('Launch Campaign (active)');
    expect(prompt).toContain('3 tasks');
  });

  it('shows fallback when no projects', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({ projects: [] }));
    expect(prompt).toContain('No projects yet.');
  });

  it('renders A2A connections section', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      a2aConnections: [
        { name: 'ExternalBot', skills: ['data analysis', 'report generation'] },
      ],
    }));
    expect(prompt).toContain('## External Agent Connections (A2A)');
    expect(prompt).toContain('ExternalBot: data analysis, report generation');
  });

  it('renders WhatsApp integration section when channel connected', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      connectedChannels: ['whatsapp'] as BuildLocalSystemPromptArgs['connectedChannels'],
    }));
    expect(prompt).toContain('## WhatsApp Integration');
    expect(prompt).toContain('send_whatsapp_message');
  });

  it('renders Telegram integration section when channel connected', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      connectedChannels: ['telegram'] as BuildLocalSystemPromptArgs['connectedChannels'],
    }));
    expect(prompt).toContain('## Telegram Integration');
    expect(prompt).toContain('send_telegram_message');
  });

  it('shows WhatsApp as available but not connected when no channels connected', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).toContain('## WhatsApp');
    expect(prompt).toContain('not connected');
    expect(prompt).not.toContain('## Telegram Integration');
  });

  it('includes current date and time', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    // Should contain a date string and time string
    expect(prompt).toMatch(/Date: \w+, \w+ \d+, \d{4}/);
    expect(prompt).toMatch(/Time: \d{2}:\d{2}/);
  });

  it('includes core sections: Daily Reps, Proactive Behavior, Plans', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).toContain('## Daily Reps Philosophy');
    expect(prompt).toContain('## Proactive Behavior');
    expect(prompt).toContain('## Plans');
  });

  it('shows "No agents created yet" when agent list is empty', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({ agents: [] }));
    expect(prompt).toContain('No agents created yet');
  });
});

describe('buildLocalPlatformAddendum', () => {
  it('returns Telegram context for telegram platform', () => {
    const result = buildLocalPlatformAddendum('telegram');
    expect(result).toContain('Telegram Context');
    expect(result).toContain('4000 characters');
  });

  it('returns WhatsApp context for whatsapp platform', () => {
    const result = buildLocalPlatformAddendum('whatsapp');
    expect(result).toContain('WhatsApp Context');
    expect(result).toContain('3000 characters');
  });

  it('returns voice context for voice platform', () => {
    const result = buildLocalPlatformAddendum('voice');
    expect(result).toContain('Voice Context');
    expect(result).toContain('2-3 sentences');
  });

  it('returns empty string for tui platform', () => {
    const result = buildLocalPlatformAddendum('tui');
    expect(result).toBe('');
  });

  it('returns empty string for undefined platform', () => {
    const result = buildLocalPlatformAddendum(undefined);
    expect(result).toBe('');
  });
});

describe('buildLocalSystemPrompt edge cases', () => {
  it('renders agent stats with zero success rate', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      agents: [{
        id: 'a1', name: 'Broken', role: 'Test', status: 'idle',
        stats: { successRate: 0, avgDuration: 0, totalTasks: 0 },
      }],
    }));
    expect(prompt).toContain('0% success');
    expect(prompt).toContain('0 tasks');
  });

  it('renders prompt with empty business context', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({ business: null }));
    expect(prompt).not.toContain('## Business Context');
  });

  it('renders both WhatsApp and Telegram when both connected', () => {
    const prompt = buildLocalSystemPrompt(baseArgs({
      connectedChannels: ['whatsapp', 'telegram'] as BuildLocalSystemPromptArgs['connectedChannels'],
    }));
    expect(prompt).toContain('## WhatsApp Integration');
    expect(prompt).toContain('## Telegram Integration');
  });

  it('contains no unresolved template variables', () => {
    const prompt = buildLocalSystemPrompt(baseArgs());
    expect(prompt).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

describe('compact prompt variants', () => {
  it('compact static instructions are shorter than full version', () => {
    const sections = new Set(['pulse', 'agents', 'filesystem', 'browser']);
    const full = buildStaticInstructionsForIntent(sections);
    const compact = buildCompactStaticInstructionsForIntent(sections);
    expect(compact.length).toBeLessThan(full.length);
    // Should be at least 40% shorter
    expect(compact.length).toBeLessThan(full.length * 0.6);
  });

  it('compact static instructions still contain critical rules', () => {
    const sections = new Set(['agents', 'filesystem']);
    const compact = buildCompactStaticInstructionsForIntent(sections);
    expect(compact).toContain('NEVER fabricate');
    expect(compact).toContain('tool_call');
  });

  it('compact dynamic context is shorter than full version', () => {
    const args = baseArgs({
      businessPulse: {
        tasksCompletedToday: 5, tasksCompletedYesterday: 3,
        totalLeads: 10, totalCustomers: 5, totalContacts: 20, recentContactEvents: 3,
      },
      connectedChannels: ['whatsapp'] as BuildLocalSystemPromptArgs['connectedChannels'],
      workingDirectory: '/home/user/project',
    });
    const full = buildDynamicContext(args);
    const compact = buildCompactDynamicContext(args);
    expect(compact.length).toBeLessThan(full.length);
    // Should be significantly shorter
    expect(compact.length).toBeLessThan(full.length * 0.5);
  });

  it('compact dynamic context still includes business name and agents', () => {
    const compact = buildCompactDynamicContext(baseArgs());
    expect(compact).toContain('TestCo');
    expect(compact).toContain('Scout');
    expect(compact).toContain('Writer');
  });

  it('compact dynamic context omits WhatsApp formatting reference', () => {
    const compact = buildCompactDynamicContext(baseArgs({
      connectedChannels: ['whatsapp'] as BuildLocalSystemPromptArgs['connectedChannels'],
    }));
    expect(compact).not.toContain('WhatsApp formatting reference');
    expect(compact).not.toContain('surround text with asterisks');
  });
});

describe('micro prompt tier', () => {
  it('micro static instructions are under 400 tokens (~1600 chars)', () => {
    const micro = buildMicroStaticInstructions();
    expect(micro.length).toBeLessThan(1600);
  });

  it('micro static instructions contain tool call example', () => {
    const micro = buildMicroStaticInstructions();
    expect(micro).toContain('tool_call');
    expect(micro).toContain('list_agents');
  });

  it('micro static instructions are shorter than compact', () => {
    const sections = new Set(['agents', 'filesystem', 'browser']);
    const compact = buildCompactStaticInstructionsForIntent(sections);
    const micro = buildMicroStaticInstructions();
    expect(micro.length).toBeLessThan(compact.length * 0.5);
  });

  it('micro dynamic context is shorter than compact', () => {
    const args = baseArgs({ workingDirectory: '/home/user/project' });
    const compact = buildCompactDynamicContext(args);
    const micro = buildMicroDynamicContext(args);
    expect(micro.length).toBeLessThan(compact.length);
  });

  it('micro dynamic context includes business name and agents', () => {
    const micro = buildMicroDynamicContext(baseArgs());
    expect(micro).toContain('TestCo');
    expect(micro).toContain('Scout');
    expect(micro).toContain('Writer');
  });
});
