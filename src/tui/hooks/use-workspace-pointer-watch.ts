/**
 * useWorkspacePointerWatch Hook
 * Watches ~/.ohwow/current-workspace for writes from other sessions and fires
 * a callback when the pointer diverges from the workspace this TUI is bound to.
 */

import { useEffect, useRef } from 'react';
import { watch, type FSWatcher } from 'fs';
import { basename } from 'path';
import { logger } from '../../lib/logger.js';
import {
  DEFAULT_CONFIG_DIR,
  WORKSPACE_POINTER_FILE,
  readWorkspacePointer,
} from '../../config.js';

const POINTER_BASENAME = basename(WORKSPACE_POINTER_FILE);
const DEBOUNCE_MS = 150;

export function useWorkspacePointerWatch(
  currentWorkspaceName: string,
  onExternalChange: (newName: string) => void,
): void {
  const onChangeRef = useRef(onExternalChange);
  onChangeRef.current = onExternalChange;

  useEffect(() => {
    let watcher: FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastNotified: string | null = null;

    const handle = () => {
      const pointer = readWorkspacePointer();
      if (!pointer) return;
      if (pointer === currentWorkspaceName) return;
      if (pointer === lastNotified) return;
      lastNotified = pointer;
      onChangeRef.current(pointer);
    };

    try {
      watcher = watch(DEFAULT_CONFIG_DIR, { persistent: false }, (_eventType, fileName) => {
        if (!fileName || fileName !== POINTER_BASENAME) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(handle, DEBOUNCE_MS);
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, dir: DEFAULT_CONFIG_DIR },
        '[use-workspace-pointer-watch] could not start fs.watch',
      );
    }

    return () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    };
  }, [currentWorkspaceName]);
}
