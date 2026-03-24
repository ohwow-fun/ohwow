/**
 * Chat Panel
 * Renders the chat header, messages, input, rename mode, slash commands,
 * and the model picker overlay when active.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ChatMessages } from '../../components/chat-messages.js';
import { ChatInput } from '../../components/chat-input.js';
import { SlashCommandMenu } from '../../components/slash-command-menu.js';
import type { SlashCommand } from '../../components/slash-command-menu.js';
import { InputField } from '../../components/input-field.js';
import type { useOrchestrator } from '../../hooks/use-orchestrator.js';

type FocusZone = 'chat' | 'grid' | 'screen';

interface ChatPanelProps {
  orchestrator: ReturnType<typeof useOrchestrator>;
  inputValue: string;
  onInputChange: (v: string) => void;
  onInputSubmit: (text: string) => void;
  focusZone: FocusZone;
  showPlan: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  showSlash: boolean;
  slashCommands: SlashCommand[];
  slashIdx: number;
  modelPickerNode: React.ReactNode | null;
}

export function ChatPanel({
  orchestrator,
  inputValue,
  onInputChange,
  onInputSubmit,
  focusZone,
  showPlan,
  renaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  showSlash,
  slashCommands,
  slashIdx,
  modelPickerNode,
}: ChatPanelProps) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} marginTop={1}>
      {/* Chat header */}
      <Box marginBottom={1}>
        <Text bold>CHAT</Text>
        <Text color="cyan"> ({orchestrator.currentModel})</Text>
        {orchestrator.sessionTitle && (
          <Text color="gray"> {orchestrator.sessionTitle}</Text>
        )}
        {orchestrator.messages.length > 0 && (
          <Text color="gray"> ({orchestrator.messages.length} messages)</Text>
        )}
      </Box>

      {modelPickerNode ? (
        modelPickerNode
      ) : (
        <>
          {/* Messages */}
          <ChatMessages
            orchestrator={orchestrator}
            maxVisible={15}
            showPlan={showPlan}
          />

          {/* Chat input / Rename mode */}
          {renaming ? (
            <Box flexDirection="column">
              <Text color="cyan">Rename session:</Text>
              <InputField
                label=""
                value={renameValue}
                onChange={onRenameChange}
                onSubmit={onRenameSubmit}
                placeholder="Enter new title..."
              />
              <Text color="gray">Enter to save, Esc to cancel</Text>
            </Box>
          ) : (
            <ChatInput
              value={inputValue}
              onChange={onInputChange}
              onSubmit={onInputSubmit}
              isDisabled={orchestrator.isStreaming}
              isFocused={focusZone === 'chat' && !modelPickerNode}
            />
          )}

          {/* Slash command menu (below input) */}
          {showSlash && (
            <SlashCommandMenu
              filter={inputValue}
              commands={slashCommands}
              selectedIndex={slashIdx}
            />
          )}
        </>
      )}
    </Box>
  );
}
