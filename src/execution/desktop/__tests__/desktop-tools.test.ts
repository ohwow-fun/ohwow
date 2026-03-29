import { describe, it, expect } from 'vitest';
import {
  formatDesktopToolResult,
  isDesktopTool,
} from '../desktop-tools.js';
import {
  scaleToPhysical,
  scaleToPhysicalForDisplay,
  calculateScaledDimensions,
} from '../screenshot-capture.js';
import type { DesktopActionResult, DisplayInfo } from '../desktop-types.js';

describe('desktop-tools', () => {
  describe('isDesktopTool', () => {
    it('recognizes all desktop tools', () => {
      expect(isDesktopTool('desktop_screenshot')).toBe(true);
      expect(isDesktopTool('desktop_click')).toBe(true);
      expect(isDesktopTool('desktop_type')).toBe(true);
      expect(isDesktopTool('desktop_key')).toBe(true);
      expect(isDesktopTool('desktop_scroll')).toBe(true);
      expect(isDesktopTool('desktop_drag')).toBe(true);
      expect(isDesktopTool('desktop_wait')).toBe(true);
    });

    it('rejects non-desktop tools', () => {
      expect(isDesktopTool('web_search')).toBe(false);
      expect(isDesktopTool('request_desktop')).toBe(false);
    });
  });

  describe('formatDesktopToolResult', () => {
    it('formats error results', () => {
      const result: DesktopActionResult = {
        success: false,
        type: 'left_click',
        error: 'Something went wrong',
      };
      const blocks = formatDesktopToolResult(result);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].text).toContain('Something went wrong');
    });

    it('formats successful screenshot result with image block', () => {
      const result: DesktopActionResult = {
        success: true,
        type: 'screenshot',
        screenshot: 'base64data',
        scaledWidth: 1280,
        scaledHeight: 800,
      };
      const blocks = formatDesktopToolResult(result);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      expect(blocks[0].text).toBe('Screenshot captured.');
      expect(blocks[1].type).toBe('image');
    });

    it('includes typewrite description', () => {
      const result: DesktopActionResult = {
        success: true,
        type: 'typewrite',
        screenshot: 'base64data',
        scaledWidth: 1280,
        scaledHeight: 800,
      };
      const blocks = formatDesktopToolResult(result);
      expect(blocks[0].text).toBe('Text typed (character-by-character).');
    });

    it('does NOT render preActionScreenshot as image block', () => {
      const result: DesktopActionResult = {
        success: true,
        type: 'left_click',
        screenshot: 'post-action-base64',
        preActionScreenshot: 'pre-action-base64',
        scaledWidth: 1280,
        scaledHeight: 800,
      };
      const blocks = formatDesktopToolResult(result);
      // Should have text + image + dimensions = 3 blocks
      // The pre-action screenshot should NOT appear as an image block
      const imageBlocks = blocks.filter(b => b.type === 'image');
      expect(imageBlocks).toHaveLength(1);
      // Verify the image is the post-action one
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((imageBlocks[0] as any).source.data).toBe('post-action-base64');
    });

    it('includes display layout in dimension text', () => {
      const result: DesktopActionResult = {
        success: true,
        type: 'screenshot',
        screenshot: 'data',
        scaledWidth: 1280,
        scaledHeight: 800,
        displayLayout: 'Display layout: [1] Built-in Retina Display',
      };
      const blocks = formatDesktopToolResult(result);
      const dimBlock = blocks.find(b => b.text?.includes('Screen dimensions'));
      expect(dimBlock?.text).toContain('Display layout');
    });
  });
});

describe('coordinate scaling', () => {
  describe('calculateScaledDimensions', () => {
    it('preserves original if within max', () => {
      const result = calculateScaledDimensions(800, 600, 1280);
      expect(result).toEqual({ scaledWidth: 800, scaledHeight: 600 });
    });

    it('scales down preserving aspect ratio', () => {
      const result = calculateScaledDimensions(2560, 1600, 1280);
      expect(result.scaledWidth).toBe(1280);
      expect(result.scaledHeight).toBe(800);
    });

    it('scales based on longest edge (height)', () => {
      const result = calculateScaledDimensions(1080, 1920, 1280);
      expect(result.scaledHeight).toBe(1280);
      expect(result.scaledWidth).toBe(720);
    });
  });

  describe('scaleToPhysical', () => {
    it('maps scaled coords back to physical space', () => {
      // Scaled image is 1280x800, physical is 2560x1600
      const result = scaleToPhysical(640, 400, 1280, 800, 2560, 1600);
      expect(result.x).toBe(1280);
      expect(result.y).toBe(800);
    });

    it('handles corner coordinates', () => {
      const result = scaleToPhysical(0, 0, 1280, 800, 2560, 1600);
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('handles max coordinates', () => {
      const result = scaleToPhysical(1280, 800, 1280, 800, 2560, 1600);
      expect(result.x).toBe(2560);
      expect(result.y).toBe(1600);
    });
  });

  describe('scaleToPhysicalForDisplay', () => {
    const retinaDisplay: DisplayInfo = {
      displayNumber: 1,
      name: 'Built-in Retina Display',
      isPrimary: true,
      physicalWidth: 2560,
      physicalHeight: 1600,
      logicalWidth: 1280,
      logicalHeight: 800,
      scaleFactor: 2,
      originX: 0,
      originY: 0,
    };

    const secondDisplay: DisplayInfo = {
      displayNumber: 2,
      name: 'External',
      isPrimary: false,
      physicalWidth: 1920,
      physicalHeight: 1080,
      logicalWidth: 1920,
      logicalHeight: 1080,
      scaleFactor: 1,
      originX: 1280,
      originY: 0,
    };

    it('maps to logical coordinates for Retina primary display', () => {
      // Screenshot scaled to 1280x800, Retina display 2560x1600 physical
      // nut.js uses logical coords, so divide by scaleFactor
      const result = scaleToPhysicalForDisplay(640, 400, 1280, 800, retinaDisplay);
      // scaleX = 2560/1280 = 2, scaleY = 1600/800 = 2
      // x = 0 + (640 * 2) / 2 = 640, y = 0 + (400 * 2) / 2 = 400
      expect(result.x).toBe(640);
      expect(result.y).toBe(400);
    });

    it('accounts for display origin offset', () => {
      // Second display at originX=1280
      const result = scaleToPhysicalForDisplay(0, 0, 1280, 720, secondDisplay);
      // scaleX = 1920/1280 = 1.5, scaleY = 1080/720 = 1.5
      // x = 1280 + (0 * 1.5) / 1 = 1280
      expect(result.x).toBe(1280);
      expect(result.y).toBe(0);
    });

    it('maps center of second display correctly', () => {
      const result = scaleToPhysicalForDisplay(640, 360, 1280, 720, secondDisplay);
      // scaleX = 1920/1280 = 1.5, scaleY = 1080/720 = 1.5
      // x = 1280 + (640 * 1.5) / 1 = 1280 + 960 = 2240
      // y = 0 + (360 * 1.5) / 1 = 540
      expect(result.x).toBe(2240);
      expect(result.y).toBe(540);
    });
  });
});
