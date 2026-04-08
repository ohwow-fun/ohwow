/**
 * ChatMessage Component
 * Renders a single chat message with Claude Code-style tool call display.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ChatMessage as ChatMessageType, TurnStep } from '../hooks/use-orchestrator.js';
import { AutomationProposal } from './automation-proposal.js';
import { ToolResultView, CODE_TOOL_NAMES } from './tool-result-view.js';

/** Basic markdown-to-terminal formatting */
function formatContent(content: string): string {
  return content
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1');
}

function formatToolLabel(step: TurnStep & { kind: 'tool' }): string {
  const firstString = Object.values(step.input).find((v) => typeof v === 'string') as string | undefined;
  if (firstString) {
    if ((firstString.startsWith('/') || firstString.startsWith('~')) && firstString.length > 60) {
      return `${step.name}(${firstString.slice(0, 35)}…${firstString.slice(-25)})`;
    }
    const truncated = firstString.length > 80 ? firstString.slice(0, 80) + '…' : firstString;
    return `${step.name}(${truncated})`;
  }
  return step.name;
}

function formatElapsed(ms: number): string {
  if (ms < 60000) {
    return `${Math.floor(ms / 1000)}s`;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

interface StepsViewProps {
  steps: TurnStep[];
  elapsedMs?: number;
  tokensSoFar?: number;
}

function StepsView({ steps, elapsedMs, tokensSoFar }: StepsViewProps) {

  return (
    <>
      {steps.map((step, i) => {
        if (step.kind === 'status') {
          return (
            <Box key={i}>
              <Text color="gray" dimColor>· </Text>
              <Text color="gray" dimColor>{step.message} </Text>
              <Text color="gray" dimColor><Spinner type="dots" /></Text>
            </Box>
          );
        }

        if (step.kind === 'automation_proposal') {
          return <AutomationProposal key={i} proposal={step.proposal} />;
        }

        if (step.kind === 'screenshot') {
          return (
            <Box key={i}>
              <Text color="gray" dimColor>  Screenshot saved: </Text>
              <Text color="cyan">{step.path}</Text>
            </Box>
          );
        }

        if (step.kind === 'media_generated') {
          return (
            <Box key={i}>
              <Text color="green">  ✦ Media saved: </Text>
              <Text color="cyan">{step.path}</Text>
            </Box>
          );
        }

        if (step.kind === 'text') {
          const text = formatContent(step.content);
          if (!text) return null;
          return (
            <Text key={i} wrap="wrap">{text}</Text>
          );
        }

        // tool step — running
        if (step.status === 'running') {
          const isLast = i === steps.length - 1;
          const elapsedPart = isLast && elapsedMs != null ? formatElapsed(elapsedMs) : null;
          const tokensPart = isLast && tokensSoFar != null && tokensSoFar > 0 ? `↓ ${formatTokens(tokensSoFar)} tokens` : null;
          return (
            <Box key={i}>
              <Text color="gray" dimColor>· </Text>
              <Text color="gray" dimColor>{formatToolLabel(step)}… </Text>
              {elapsedPart && <Text color="gray" dimColor>({elapsedPart}{tokensPart ? ` · ${tokensPart}` : ''} · </Text>}
              {isLast && (
                <>
                  {elapsedPart ? null : <Text color="gray" dimColor>(</Text>}
                  <Text color="gray" dimColor><Spinner type="dots" /></Text>
                  <Text color="gray" dimColor>)</Text>
                </>
              )}
              {elapsedPart && <Text color="gray" dimColor>)</Text>}
            </Box>
          );
        }

        // tool step — done
        if (step.status === 'done') {
          const isCodeTool = CODE_TOOL_NAMES.has(step.name);
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Text color="green">● </Text>
                <Text>{formatToolLabel(step)}</Text>
              </Box>
              {isCodeTool && (
                <ToolResultView
                  toolName={step.name}
                  input={step.input}
                  result={step.result}
                  status={step.status}
                />
              )}
            </Box>
          );
        }

        // tool step — error
        return (
          <Box key={i}>
            <Text color="red">● </Text>
            <Text color="red">{formatToolLabel(step)}</Text>
            {step.error && <Text color="red"> — {step.error}</Text>}
          </Box>
        );
      })}
    </>
  );
}

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="cyan" dimColor>▸ </Text>
          <Text color="cyan" wrap="wrap">{formatContent(message.content)}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.steps ? (
        <StepsView steps={message.steps} />
      ) : (
        <Text wrap="wrap">{formatContent(message.content)}</Text>
      )}
    </Box>
  );
}

interface StreamingMessageProps {
  steps: TurnStep[];
  elapsedMs?: number;
  tokensSoFar?: number;
}

export function StreamingMessage({ steps, elapsedMs, tokensSoFar }: StreamingMessageProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {steps.length > 0 ? (
        <StepsView steps={steps} elapsedMs={elapsedMs} tokensSoFar={tokensSoFar} />
      ) : (
        <Box>
          <Text color="gray" dimColor>· </Text>
          <Text color="gray" dimColor>Thinking</Text>
          <Text color="gray" dimColor><Spinner type="dots" /></Text>
        </Box>
      )}
    </Box>
  );
}
