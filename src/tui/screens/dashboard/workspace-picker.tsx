/**
 * Workspace Picker Overlay
 *
 * Triggered by the /workspace slash command. Lists every local workspace
 * (default + every entry under ~/.ohwow/workspaces) with mode + running
 * status, lets the user pick one with arrow keys, and reports the choice
 * back to the caller. The actual switching (write pointer + start daemon
 * + relaunch TUI) is handled by the parent so this component stays pure.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTerminalSize } from '../../hooks/use-terminal-size.js';
import {
  resolveActiveWorkspace,
  listWorkspaces,
  workspaceLayoutFor,
  readWorkspaceConfig,
  portForWorkspace,
  DEFAULT_WORKSPACE,
} from '../../../config.js';
import { isDaemonRunning } from '../../../daemon/lifecycle.js';

export interface WorkspacePickerProps {
  /** Called with the selected workspace name on Enter. */
  onSelect: (name: string) => void;
  /** Called on Escape. */
  onClose: () => void;
  /** Whether to capture keyboard input (false during transitions). */
  isActive: boolean;
}

interface WorkspaceRow {
  name: string;
  mode: 'default' | 'local-only' | 'cloud';
  displayName?: string;
  running: boolean;
  pid?: number;
  port: number | null;
  isCurrent: boolean;
}

export function WorkspacePicker({ onSelect, onClose, isActive }: WorkspacePickerProps) {
  const [rows, setRows] = useState<WorkspaceRow[]>([]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const termCols = useTerminalSize();
  const pickerWidth = Math.min(72, termCols - 4);

  const currentName = useMemo(() => resolveActiveWorkspace().name, []);

  // Load workspace list + status on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = Array.from(new Set([...listWorkspaces(), DEFAULT_WORKSPACE])).sort();
      const built: WorkspaceRow[] = [];
      for (const name of all) {
        const cfg = readWorkspaceConfig(name);
        const port = portForWorkspace(name);
        const layout = workspaceLayoutFor(name);
        let running = false;
        let pid: number | undefined;
        if (port !== null) {
          try {
            const status = await isDaemonRunning(layout.dataDir, port);
            running = status.running;
            pid = status.pid;
          } catch {
            // ignore
          }
        }
        built.push({
          name,
          mode: cfg ? cfg.mode : 'default',
          displayName: cfg?.displayName,
          running,
          pid,
          port,
          isCurrent: name === currentName,
        });
      }
      if (!cancelled) {
        setRows(built);
        // Pre-select current workspace
        const currentIdx = built.findIndex((r) => r.isCurrent);
        setIdx(currentIdx >= 0 ? currentIdx : 0);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentName]);

  useInput(
    (input, key) => {
      if (loading) return;
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow || input === 'k') {
        setIdx((i) => (i > 0 ? i - 1 : rows.length - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setIdx((i) => (i < rows.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const target = rows[idx];
        if (target) onSelect(target.name);
        return;
      }
    },
    { isActive: isActive && !loading },
  );

  if (loading) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
        <Text color="gray">Loading workspaces…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="magenta"
        paddingX={2}
        paddingY={1}
        width={pickerWidth}
      >
        <Box marginBottom={1}>
          <Text bold color="magenta">Switch workspace</Text>
        </Box>
        {rows.map((row, i) => {
          const selected = i === idx;
          const pointer = row.isCurrent ? '◉' : '○';
          const modeLabel = (() => {
            if (row.mode === 'default') return 'default';
            if (row.mode === 'local-only') return 'local-only';
            return row.displayName ? `cloud: ${row.displayName}` : 'cloud';
          })();
          const statusLabel = row.running
            ? `running on :${row.port}`
            : row.port !== null
              ? 'idle'
              : 'no port yet';
          return (
            <Box key={row.name}>
              <Text color={selected ? 'cyan' : row.isCurrent ? 'magenta' : 'gray'} bold={selected}>
                {selected ? '> ' : '  '}
                {pointer} {row.name.padEnd(24)}
              </Text>
              <Text color="gray" dimColor>
                {' '}
                ({modeLabel}, {statusLabel})
              </Text>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            ↑/↓ navigate · enter switch · esc cancel
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Note: switching restarts the TUI process. Other workspace daemons keep running.
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
