/**
 * ChatMessages Component
 * Renders the scrollable message list for the orchestrator chat.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { OrchestratorState, PlanTask } from '../hooks/use-orchestrator.js';
import { ChatMessage, StreamingMessage } from './chat-message.js';

function PlanTaskRow({ task }: { task: PlanTask }) {
  if (task.status === 'done') {
    return (
      <Box>
        <Text color="green">{'✓ '}</Text>
        <Text color="green">{task.title}</Text>
      </Box>
    );
  }
  if (task.status === 'in_progress') {
    return (
      <Box>
        <Text color="yellow">{'■ '}</Text>
        <Text color="yellow">{task.title}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color="gray" dimColor>{'□ '}</Text>
      <Text color="gray" dimColor>{task.title}</Text>
    </Box>
  );
}

interface ChatMessagesProps {
  orchestrator: OrchestratorState;
  maxVisible?: number;
  showPlan?: boolean;
}

export function ChatMessages({ orchestrator, maxVisible = 15, showPlan = true }: ChatMessagesProps) {
  const allItems: Array<{ type: 'message'; index: number } | { type: 'streaming' }> = [];
  for (let i = 0; i < orchestrator.messages.length; i++) {
    allItems.push({ type: 'message', index: i });
  }
  if (orchestrator.isStreaming) {
    allItems.push({ type: 'streaming' });
  }

  const scrollOffset = Math.max(0, allItems.length - maxVisible);
  const visibleItems = allItems.slice(scrollOffset, scrollOffset + maxVisible);

  const hasPlan = orchestrator.planTasks.length > 0;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {orchestrator.messages.length === 0 && !orchestrator.isStreaming && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="gray">Ask me anything about your agents, tasks, or workspace.</Text>
          <Text color="gray">Examples:</Text>
          <Text color="gray">{'  \u2022 "What agents do I have?"'}</Text>
          <Text color="gray">{'  \u2022 "Run the content writer to draft a blog post"'}</Text>
          <Text color="gray">{'  \u2022 "Show me pending approvals"'}</Text>
          <Text color="gray">{'  \u2022 "What\'s the status of my workspace?"'}</Text>
        </Box>
      )}

      {scrollOffset > 0 && (
        <Text color="gray">  {'↑'} {scrollOffset} more</Text>
      )}

      {visibleItems.map((item) => {
        if (item.type === 'message') {
          return (
            <ChatMessage
              key={item.index}
              message={orchestrator.messages[item.index]}
            />
          );
        }
        return (
          <StreamingMessage
            key="streaming"
            steps={orchestrator.streamingSteps}
            elapsedMs={orchestrator.streamingElapsedMs}
            tokensSoFar={orchestrator.lastTokens.output}
          />
        );
      })}

      {scrollOffset + maxVisible < allItems.length && (
        <Text color="gray">  {'↓'} {allItems.length - scrollOffset - maxVisible} more</Text>
      )}

      {hasPlan && showPlan && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginTop={1}
        >
          {orchestrator.planTasks.map(task => (
            <PlanTaskRow key={task.id} task={task} />
          ))}
        </Box>
      )}

      {orchestrator.error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {orchestrator.error}</Text>
        </Box>
      )}
    </Box>
  );
}
