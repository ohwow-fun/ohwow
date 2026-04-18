/**
 * generate_xlsx dispatcher tests. Builds a small workbook in-memory and asserts
 * the emitted buffer is a real ZIP with the expected XLSX internals, without
 * writing to disk.
 */
import { describe, it, expect } from 'vitest';
import { generateXlsxDispatcher } from '../dispatchers/generate-xlsx.js';
import type { DispatcherDeps } from '../action-dispatcher.js';
import type { LocalTrigger } from '../../webhooks/ghl-types.js';

const deps = {} as DispatcherDeps; // dispatcher only touches deps when auto_save=true
const trigger = { id: 'test-trigger', name: 'test' } as LocalTrigger;

describe('generateXlsxDispatcher', () => {
  it('produces a valid XLSX buffer for a 2-sheet spec', async () => {
    const config = {
      title: 'Test Workbook',
      author: 'Tester',
      sheets: [
        {
          name: 'Alpha',
          headers: ['col1', 'col2'],
          rows: [
            ['a1', 1],
            ['a2', 2],
          ],
        },
        {
          name: 'Beta',
          headers: ['col1', 'col2'],
          rows: [
            ['b1', 10],
            ['b2', 20],
          ],
        },
      ],
      auto_save: false,
    };

    const output = await generateXlsxDispatcher.execute(config, {}, deps, trigger);

    expect(output.sheet_count).toBe(2);
    expect(output.row_count).toBe(4);
    expect(typeof output.xlsx_base64).toBe('string');

    const buffer = Buffer.from(output.xlsx_base64 as string, 'base64');
    // ZIP magic number: PK\x03\x04
    expect(buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    // The XLSX zip must contain the main workbook part; its filename appears
    // in the zip central directory as ASCII text.
    expect(buffer.includes(Buffer.from('xl/workbook.xml'))).toBe(true);
  });
});
