/**
 * Workflow Generator - Prompt template for AI-powered workflow creation
 * Takes available agents + user description → structured workflow definition
 *
 * Copied from src/lib/agents/prompts/workflow-generator.ts (pure function, zero deps)
 */

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  department?: string;
}

export interface IntegrationSummary {
  provider: string;
  name: string;
  connected: boolean;
}

export function buildWorkflowGeneratorPrompt(
  agents: AgentSummary[],
  userDescription: string,
  integrations?: IntegrationSummary[]
): string {
  const agentList = agents
    .map((a) => `- ${a.name} (ID: ${a.id}) — Role: ${a.role}${a.department ? `, Dept: ${a.department}` : ''}`)
    .join('\n');

  const integrationSection = integrations && integrations.length > 0
    ? `\n## Available Integrations
${integrations.map((i) => `- ${i.name} (provider: ${i.provider}) — ${i.connected ? '✅ Connected' : '❌ Not connected'}`).join('\n')}

When the user's description implies actions that require integrations (sending email, uploading files, etc.), include the appropriate provider name(s) in the step's "required_integrations" array. This helps the UI prompt users to connect missing integrations before running.\n`
    : '';

  return `You are a workflow architect. Given a user's description and available agents, create a multi-step workflow.

## Available Agents
${agentList}
${integrationSection}
## User's Workflow Description
"${userDescription}"

## Instructions
1. Break the workflow into 2-6 steps
2. Assign each step to the most suitable agent based on their role
3. Use clear, specific action descriptions
4. If a step involves using an integration (sending email, uploading to Dropbox, etc.), include the provider name in "required_integrations" for that step
5. **Use parallel branches when steps are independent.** Steps with depends_on: [] run immediately. Steps that don't need each other's output should run in parallel. Use a merge step (depends on multiple prior steps) when you need to combine results.
6. **Include SIPOC metadata** for each step: supplier_indices (which prior step indices feed into this one), expected_input/output descriptions, output_format, and customer_indices (which later steps consume this output)

## Parallelism Patterns
- **Sequential chain**: step 0 → step 1 → step 2 (each depends on the previous)
- **Fan-out**: steps 0, 1, 2 all have depends_on: [] (run in parallel)
- **Fan-in / merge**: step 3 has depends_on: [0, 1, 2] (waits for all three, receives combined outputs)
- **Diamond**: step 0 → steps 1, 2 in parallel → step 3 merges both

## Response Format (JSON only, no markdown)
{
  "name": "Concise workflow name",
  "description": "One-sentence description of what this workflow does",
  "variables": [
    {
      "name": "variable_name",
      "description": "What this variable is for",
      "default_value": "optional default"
    }
  ],
  "steps": [
    {
      "agent_id": "uuid-of-agent",
      "agent_name": "Agent Name",
      "action": "Specific task description using {{variable_name}} for dynamic input",
      "input_mapping": "What input this step receives (e.g., 'user_input' for first step, 'output_of_step_0' for subsequent)",
      "depends_on": [],
      "required_integrations": [],
      "sipoc": {
        "supplier_indices": [],
        "expected_input": "user_input",
        "expected_output": "Description of what this step produces",
        "output_format": "markdown",
        "customer_indices": [1, 2]
      }
    },
    {
      "agent_id": "uuid-of-research-agent",
      "agent_name": "Research Agent",
      "action": "Research task that can run in parallel with step 2",
      "input_mapping": "user_input",
      "depends_on": [],
      "required_integrations": []
    },
    {
      "agent_id": "uuid-of-analysis-agent",
      "agent_name": "Analysis Agent",
      "action": "Analysis task that runs in parallel with step 1",
      "input_mapping": "user_input",
      "depends_on": [],
      "required_integrations": []
    },
    {
      "agent_id": "uuid-of-writer-agent",
      "agent_name": "Writer Agent",
      "action": "Combine research and analysis into final output",
      "input_mapping": "output_of_step_1,output_of_step_2",
      "depends_on": [1, 2],
      "required_integrations": ["gmail"]
    }
  ]
}

Rules:
- Steps with depends_on: [] run immediately (in parallel if multiple)
- Steps with depends_on: [X, Y] wait for steps X and Y, then receive both outputs as context
- For simple sequential workflows, each step depends on the previous: depends_on: [0], depends_on: [1], etc.
- **Prefer parallel branches** when steps can work independently (e.g., research + analysis before synthesis)
- If no agent fits a step, pick the closest match
- Keep actions specific and results-oriented
- Only use agents from the available list above
- If the workflow description mentions specific topics, names, or values that might change between runs, extract them as variables using {{variable_name}} syntax in step actions
- Variables array can be empty if the workflow doesn't need dynamic input
- required_integrations should contain provider names (e.g., "gmail", "dropbox") only when the step needs to use that integration
- If no integrations are needed for a step, omit required_integrations or set it to an empty array`;
}
