/**
 * Onboarding Step 5: Agent Discovery
 * AI chat interface for agent recommendations (or preset fallback if no model).
 */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { KeyHints } from '../../components/key-hints.js';
import type { AgentPreset } from '../../data/agent-presets.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentDiscoveryStepProps {
  modelAvailable: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  chatStreaming: boolean;
  recommendedAgents: AgentPreset[];
  presets: AgentPreset[];
}

export function AgentDiscoveryStep({
  modelAvailable,
  chatMessages,
  chatInput,
  chatStreaming,
  recommendedAgents,
  presets,
}: AgentDiscoveryStepProps) {
  if (!modelAvailable) {
    // Fallback: show preset recommendations
    return (
      <Box flexDirection="column">
        <Text bold>Your recommended agents</Text>
        <Text color="gray">Based on your business type. You can adjust on the next screen.</Text>

        <Box flexDirection="column" marginTop={1}>
          {presets.map(agent => (
            <Box key={agent.id} marginBottom={1} flexDirection="column">
              <Box>
                <Text color={agent.recommended ? 'cyan' : 'gray'}>
                  {agent.recommended ? '★ ' : '  '}
                </Text>
                <Text bold color="white">{agent.name}</Text>
                <Text color="gray"> — {agent.role}</Text>
              </Box>
              <Box marginLeft={4}>
                <Text color="gray" dimColor>{agent.description}</Text>
              </Box>
            </Box>
          ))}
        </Box>

        <Box marginTop={1}>
          <KeyHints hints={[
            { key: 'Enter', label: 'Continue to selection' },
            { key: 'Esc', label: 'Back' },
          ]} />
        </Box>
      </Box>
    );
  }

  // AI chat mode
  return (
    <Box flexDirection="column">
      <Text bold>Meet your AI advisor</Text>
      <Text color="gray">Chat to get personalized agent recommendations.</Text>

      {/* Chat messages */}
      <Box flexDirection="column" marginTop={1}>
        {chatMessages.map((msg, i) => (
          <Box key={i} marginBottom={1}>
            <Text color={msg.role === 'user' ? 'cyan' : 'green'}>
              {msg.role === 'user' ? 'You' : 'AI'}:{' '}
            </Text>
            <Text wrap="wrap">{msg.content}</Text>
          </Box>
        ))}
        {chatStreaming && (
          <Box>
            <Text color="green">AI: </Text>
            <Text color="gray">thinking...</Text>
          </Box>
        )}
      </Box>

      {/* Recommended agents (if any found) */}
      {recommendedAgents.length > 0 && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          <Text bold color="green">Recommended agents:</Text>
          {recommendedAgents.map(a => (
            <Text key={a.id} color="white">  ★ {a.name} — {a.role}</Text>
          ))}
        </Box>
      )}

      {/* Chat input */}
      {!chatStreaming && (
        <Box marginTop={1}>
          <Text color="cyan">{'> '}</Text>
          <TextInput
            value={chatInput}
            onChange={() => {}}
            placeholder="Tell the AI about your priorities..."
          />
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints hints={[
          { key: 'Enter', label: chatMessages.length >= 4 ? 'Continue to selection' : 'Send' },
          { key: 'Tab', label: 'Skip to selection' },
          { key: 'Esc', label: 'Back' },
        ]} />
      </Box>
    </Box>
  );
}
