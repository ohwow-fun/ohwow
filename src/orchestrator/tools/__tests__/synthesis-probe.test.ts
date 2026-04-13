import { describe, it, expect, vi } from 'vitest';
import { collectManifest, type EvaluateOnlyPage } from '../synthesis-probe.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makePage(evaluatePayload: unknown): EvaluateOnlyPage {
  return {
    evaluate: async () => evaluatePayload,
  };
}

describe('collectManifest', () => {
  it('unwraps a well-formed payload into the SelectorManifest shape', async () => {
    const payload = {
      testidElements: [
        {
          testid: 'tweetTextarea_0',
          selector: '[data-testid="tweetTextarea_0"]',
          tag: 'div',
          role: 'textbox',
          ariaLabel: 'Post text',
          placeholder: null,
          textContent: '',
          disabled: false,
          isTextInput: true,
          isButton: false,
          rect: { x: 100, y: 200, w: 600, h: 300 },
        },
      ],
      formElements: [
        {
          selector: 'button[type="submit"]',
          tag: 'button',
          type: 'submit',
          name: null,
          placeholder: null,
          ariaLabel: null,
          disabled: false,
          rect: { x: 0, y: 0, w: 100, h: 40 },
        },
      ],
      contentEditables: [],
      observations: ['h1: Compose'],
    };

    const page = makePage(payload);
    const result = await collectManifest(page);

    expect(result.testidElements).toHaveLength(1);
    expect(result.testidElements[0].testid).toBe('tweetTextarea_0');
    expect(result.testidElements[0].isTextInput).toBe(true);
    expect(result.formElements).toHaveLength(1);
    expect(result.contentEditables).toEqual([]);
    expect(result.observations).toEqual(['h1: Compose']);
  });

  it('coerces missing arrays to empty arrays', async () => {
    const page = makePage({});
    const result = await collectManifest(page);
    expect(result.testidElements).toEqual([]);
    expect(result.formElements).toEqual([]);
    expect(result.contentEditables).toEqual([]);
    expect(result.observations).toEqual([]);
  });

  it('passes through a rich payload modelled on x.com/compose/post', async () => {
    // Realistic fixture captured manually on 2026-04-13 when we built
    // x_compose_tweet — asserts the payload shape the generator will
    // actually see.
    const payload = {
      testidElements: [
        {
          testid: 'tweetTextarea_0',
          selector: '[data-testid="tweetTextarea_0"]',
          tag: 'div',
          role: 'textbox',
          ariaLabel: null,
          placeholder: 'What is happening?!',
          textContent: '',
          disabled: false,
          isTextInput: true,
          isButton: false,
          rect: { x: 320, y: 180, w: 560, h: 200 },
        },
        {
          testid: 'tweetButton',
          selector: '[data-testid="tweetButton"]',
          tag: 'button',
          role: 'button',
          ariaLabel: 'Post',
          placeholder: null,
          textContent: 'Post',
          disabled: true,
          isTextInput: false,
          isButton: true,
          rect: { x: 840, y: 420, w: 80, h: 36 },
        },
        {
          testid: 'addButton',
          selector: '[data-testid="addButton"]',
          tag: 'button',
          role: 'button',
          ariaLabel: 'Add post',
          placeholder: null,
          textContent: '+',
          disabled: false,
          isTextInput: false,
          isButton: true,
          rect: { x: 320, y: 420, w: 30, h: 30 },
        },
      ],
      formElements: [],
      contentEditables: [
        {
          selector: 'div[contenteditable]',
          role: 'textbox',
          ariaLabel: null,
          textLength: 0,
          rect: { x: 320, y: 180, w: 560, h: 200 },
        },
      ],
      observations: ['h1: X', 'onbeforeunload handler installed'],
    };

    const result = await collectManifest(makePage(payload));
    const names = result.testidElements.map((e) => e.testid);
    expect(names).toEqual(['tweetTextarea_0', 'tweetButton', 'addButton']);
    expect(result.testidElements.find((e) => e.testid === 'tweetButton')?.disabled).toBe(true);
    expect(result.contentEditables[0].role).toBe('textbox');
    expect(result.observations).toContain('onbeforeunload handler installed');
  });
});
