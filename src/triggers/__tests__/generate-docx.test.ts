/**
 * generate_docx dispatcher tests. Builds a small Word doc in-memory and asserts
 * the emitted buffer is a real ZIP with the expected DOCX internals, without
 * writing to disk.
 */
import { describe, it, expect } from 'vitest';
import { generateDocxDispatcher } from '../dispatchers/generate-docx.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps; // dispatcher only touches deps when auto_save=true
const trigger = { id: 'test-trigger', name: 'test' } as LocalTrigger;

describe('generateDocxDispatcher', () => {
  it('produces a valid DOCX buffer for a 3-block spec', async () => {
    const config = {
      title: 'Test Document',
      author: 'Tester',
      blocks: [
        { type: 'heading', level: 1, text: 'Title' },
        {
          type: 'paragraph',
          runs: [
            { text: 'hello ' },
            { text: 'world', bold: true },
          ],
        },
        { type: 'bullets', items: ['one', 'two'] },
      ],
      auto_save: false,
    };

    const output = await generateDocxDispatcher.execute(config, {}, deps, trigger);

    expect(output.block_count).toBe(3);
    expect(typeof output.docx_base64).toBe('string');

    const buffer = Buffer.from(output.docx_base64 as string, 'base64');
    // ZIP magic number: PK\x03\x04
    expect(buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    // The DOCX zip must contain the main document part; its filename appears
    // in the zip central directory as ASCII text.
    expect(buffer.includes(Buffer.from('word/document.xml'))).toBe(true);
  });
});
