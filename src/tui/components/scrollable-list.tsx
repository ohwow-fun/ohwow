/**
 * ScrollableList Component
 * Generic list with j/k navigation and selection.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface ScrollableListProps<T> {
  items: T[];
  renderItem: (item: T, index: number, isSelected: boolean) => React.ReactNode;
  onSelect?: (item: T) => void;
  onSelectedIndexChange?: (index: number) => void;
  maxVisible?: number;
  emptyMessage?: string;
}

export function ScrollableList<T>({
  items,
  renderItem,
  onSelect,
  onSelectedIndexChange,
  maxVisible = 15,
  emptyMessage = 'No items',
}: ScrollableListProps<T>) {
  const [rawSelectedIndex, setSelectedIndex] = useState(0);
  const [rawScrollOffset, setScrollOffset] = useState(0);

  // Derive clamped values so we never go out of bounds when items shrink
  const selectedIndex = items.length === 0 ? 0 : Math.min(rawSelectedIndex, items.length - 1);
  const scrollOffset = items.length === 0 ? 0 : Math.min(rawScrollOffset, Math.max(0, items.length - maxVisible));

  useInput((input, key) => {
    if (items.length === 0) return;

    if (input === 'j' || key.downArrow) {
      const next = Math.min(selectedIndex + 1, items.length - 1);
      setSelectedIndex(next);
      onSelectedIndexChange?.(next);
      if (next >= scrollOffset + maxVisible) {
        setScrollOffset(next - maxVisible + 1);
      }
    }

    if (input === 'k' || key.upArrow) {
      const next = Math.max(selectedIndex - 1, 0);
      setSelectedIndex(next);
      onSelectedIndexChange?.(next);
      if (next < scrollOffset) {
        setScrollOffset(next);
      }
    }

    if (key.return && onSelect) {
      onSelect(items[selectedIndex]);
    }
  });

  if (items.length === 0) {
    return <Text color="gray">{emptyMessage}</Text>;
  }

  const visibleItems = items.slice(scrollOffset, scrollOffset + maxVisible);
  const showTopIndicator = scrollOffset > 0;
  const showBottomIndicator = scrollOffset + maxVisible < items.length;

  return (
    <Box flexDirection="column">
      {showTopIndicator && <Text color="gray">  ↑ {scrollOffset} more</Text>}
      {visibleItems.map((item, i) => {
        const realIndex = scrollOffset + i;
        const isSelected = realIndex === selectedIndex;
        return (
          <Box key={realIndex}>
            <Text color={isSelected ? 'cyan' : 'gray'}>{isSelected ? '▸ ' : '  '}</Text>
            {renderItem(item, realIndex, isSelected)}
          </Box>
        );
      })}
      {showBottomIndicator && <Text color="gray">  ↓ {items.length - scrollOffset - maxVisible} more</Text>}
    </Box>
  );
}
