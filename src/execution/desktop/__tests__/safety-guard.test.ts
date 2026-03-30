import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process for getFrontmostApp (uses execSync osascript)
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import {
  checkActionSafety,
  classifyActionRisk,
  isLikelyTerminal,
} from '../safety-guard.js';
import type { DesktopAction } from '../desktop-types.js';

const mockExecSync = vi.mocked(execSync);

describe('safety-guard', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure tests run as if on macOS so getFrontmostApp() doesn't bail early
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('classifyActionRisk', () => {
    it('classifies read-only actions as low risk', () => {
      expect(classifyActionRisk({ type: 'screenshot' } as DesktopAction)).toBe('low');
      expect(classifyActionRisk({ type: 'wait', duration: 100 } as DesktopAction)).toBe('low');
      expect(classifyActionRisk({ type: 'mouse_move', x: 0, y: 0 } as DesktopAction)).toBe('low');
    });

    it('classifies click actions as medium risk', () => {
      expect(classifyActionRisk({ type: 'left_click', x: 0, y: 0 } as DesktopAction)).toBe('medium');
      expect(classifyActionRisk({ type: 'right_click', x: 0, y: 0 } as DesktopAction)).toBe('medium');
      expect(classifyActionRisk({ type: 'double_click', x: 0, y: 0 } as DesktopAction)).toBe('medium');
      expect(classifyActionRisk({ type: 'scroll', x: 0, y: 0, direction: 'down', amount: 3 } as DesktopAction)).toBe('medium');
    });

    it('classifies type_text as high risk', () => {
      expect(classifyActionRisk({ type: 'type_text', text: 'hello' } as DesktopAction)).toBe('high');
    });

    it('classifies typewrite as high risk', () => {
      expect(classifyActionRisk({ type: 'typewrite', text: 'hello' } as DesktopAction)).toBe('high');
    });

    it('classifies key press as high risk', () => {
      expect(classifyActionRisk({ type: 'key', key: 'cmd+c' } as DesktopAction)).toBe('high');
    });
  });

  describe('checkActionSafety with terminal focused', () => {
    beforeEach(() => {
      // Simulate Terminal.app being focused
      mockExecSync.mockReturnValue('terminal\n');
    });

    it('blocks type_text in terminal', () => {
      const result = checkActionSafety({ type: 'type_text', text: 'rm -rf /' } as DesktopAction);
      expect(result.allowed).toBe(false);
      expect(result.blocked).toContain('terminal');
    });

    it('blocks typewrite in terminal', () => {
      const result = checkActionSafety({ type: 'typewrite', text: 'dangerous' } as DesktopAction);
      expect(result.allowed).toBe(false);
      expect(result.blocked).toContain('terminal');
    });

    it('blocks Enter key in terminal', () => {
      const result = checkActionSafety({ type: 'key', key: 'enter' } as DesktopAction);
      expect(result.allowed).toBe(false);
      expect(result.blocked).toContain('terminal');
    });
  });

  describe('checkActionSafety with non-terminal focused', () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue('google chrome\n');
    });

    it('allows type_text in non-terminal apps', () => {
      const result = checkActionSafety({ type: 'type_text', text: 'hello' } as DesktopAction);
      expect(result.allowed).toBe(true);
    });

    it('allows typewrite in non-terminal apps', () => {
      const result = checkActionSafety({ type: 'typewrite', text: 'hello' } as DesktopAction);
      expect(result.allowed).toBe(true);
    });
  });

  describe('dangerous key combos', () => {
    beforeEach(() => {
      mockExecSync.mockReturnValue('google chrome\n');
    });

    it('blocks force quit combo', () => {
      const result = checkActionSafety({ type: 'key', key: 'cmd+option+escape' } as DesktopAction);
      expect(result.allowed).toBe(false);
      expect(result.blocked).toContain('blocked');
    });

    it('warns on cmd+q', () => {
      const result = checkActionSafety({ type: 'key', key: 'cmd+q' } as DesktopAction);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeDefined();
    });

    it('allows normal key combos', () => {
      const result = checkActionSafety({ type: 'key', key: 'cmd+c' } as DesktopAction);
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('isLikelyTerminal', () => {
    it('recognizes known terminal apps', () => {
      expect(isLikelyTerminal('terminal')).toBe(true);
      expect(isLikelyTerminal('iterm2')).toBe(true);
      expect(isLikelyTerminal('warp')).toBe(true);
      expect(isLikelyTerminal('kitty')).toBe(true);
      expect(isLikelyTerminal('ghostty')).toBe(true);
    });

    it('does not flag non-terminal apps', () => {
      // Mock bundle ID query for unknown apps
      mockExecSync.mockReturnValue('com.google.Chrome\n');
      expect(isLikelyTerminal('google chrome')).toBe(false);
    });
  });
});
