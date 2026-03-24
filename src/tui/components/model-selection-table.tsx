/**
 * ModelSelectionTable Component
 * Table-style model selector with aligned columns, wrapping ScrollableList.
 */

import React from 'react';
import { Text } from 'ink';
import { ScrollableList } from './scrollable-list.js';
import { isModelInstalled, estimateDownloadMinutes } from '../../lib/ollama-models.js';
import type { OllamaModelInfo } from '../../lib/ollama-models.js';

interface ModelSelectionTableProps {
  models: OllamaModelInfo[];
  installedModels: string[];
  onSelect: (model: OllamaModelInfo) => void;
  maxVisible?: number;
}

/** Extract context window string from features array (e.g. "256K"). */
function extractContext(features: string[]): string {
  const ctx = features.find(f => f.endsWith('context'));
  if (!ctx) return '';
  return ctx.replace(' context', '');
}

/** Pad or truncate a string to a fixed width. */
function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

export function ModelSelectionTable({
  models,
  installedModels,
  onSelect,
  maxVisible = 10,
}: ModelSelectionTableProps) {
  return (
    <ScrollableList<OllamaModelInfo>
      items={models}
      maxVisible={maxVisible}
      onSelect={onSelect}
      renderItem={(model, _index, isSelected) => {
        const installed = isModelInstalled(model.tag, installedModels);
        const marker = model.recommended ? '★' : installed ? '✓' : ' ';
        const markerColor = model.recommended ? 'yellow' : installed ? 'green' : undefined;

        const name = pad(model.label, 24);
        const size = pad(`${model.sizeGB} GB`, 10);
        const ctx = pad(extractContext(model.features), 8);

        const badges: string[] = [];
        if (model.toolCalling) badges.push('[tools]');
        if (model.vision) badges.push('[vision]');
        const badgeStr = pad(badges.join(' '), 18);

        const time = installed ? 'ready' : `~${estimateDownloadMinutes(model.sizeGB)} min`;

        return (
          <Text bold={isSelected} color={isSelected ? 'cyan' : undefined}>
            <Text color={markerColor}>{marker}</Text>
            {' '}
            {name}
            <Text color="gray">{size}</Text>
            <Text color="gray">{ctx}</Text>
            <Text color={model.vision ? 'magenta' : model.toolCalling ? 'blue' : 'gray'}>{badgeStr}</Text>
            <Text color={installed ? 'green' : 'gray'}>{time}</Text>
          </Text>
        );
      }}
    />
  );
}
