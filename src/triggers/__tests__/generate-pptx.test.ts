/**
 * generate_pptx dispatcher tests. Builds a small deck in-memory and asserts
 * the emitted buffer is a real ZIP with the expected PPTX internals, without
 * writing to disk.
 */
import { describe, it, expect } from 'vitest';
import { generatePptxDispatcher } from '../dispatchers/generate-pptx.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps; // dispatcher only touches deps when auto_save=true
const trigger = { id: 'test-trigger', name: 'test' } as LocalTrigger;

describe('generatePptxDispatcher', () => {
  it('produces a valid PPTX buffer for a 2-slide spec', async () => {
    const config = {
      title: 'Test Deck',
      author: 'Tester',
      slides: [
        { title: 'A', bullets: ['alpha one'] },
        { title: 'B', bullets: ['beta one'] },
      ],
      auto_save: false,
    };

    const output = await generatePptxDispatcher.execute(config, {}, deps, trigger);

    expect(output.slide_count).toBe(2);
    expect(typeof output.pptx_base64).toBe('string');

    const buffer = Buffer.from(output.pptx_base64 as string, 'base64');
    // ZIP magic number: PK\x03\x04
    expect(buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    // The PPTX zip must contain the main presentation part; its filename
    // appears in the zip central directory as ASCII text.
    expect(buffer.includes(Buffer.from('ppt/presentation.xml'))).toBe(true);
  });
});
