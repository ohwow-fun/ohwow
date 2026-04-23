import { describe, it, expect } from 'vitest';
import { parseResponseMeta, shouldAutoCreateDeliverable, inferTypeFromContent } from '../response-classifier.js';

describe('parseResponseMeta', () => {
  it('returns { type: null, cleanContent: original } when no header is present', () => {
    const content = 'This is a plain response with no header.';
    const result = parseResponseMeta(content);
    expect(result).toEqual({
      type: null,
      cleanContent: content,
    });
  });

  it('returns { type: "deliverable", cleanContent: stripped } when header has type=deliverable', () => {
    const content = '<!--response_meta:{"type":"deliverable"}--> This is a deliverable response.';
    const result = parseResponseMeta(content);
    expect(result.type).toBe('deliverable');
    expect(result.cleanContent).toBe('This is a deliverable response.');
  });

  it('returns { type: "informational", cleanContent: stripped } when header has type=informational', () => {
    const content = '<!--response_meta:{"type":"informational"}--> This is informational content.';
    const result = parseResponseMeta(content);
    expect(result.type).toBe('informational');
    expect(result.cleanContent).toBe('This is informational content.');
  });

  it('returns { type: null } when header JSON is malformed', () => {
    const content = '<!--response_meta:{"type":"deliverable"-- This text is broken JSON.';
    const result = parseResponseMeta(content);
    expect(result.type).toBeNull();
    expect(result.cleanContent).toBe(content);
  });

  it('returns { type: null } when header type is an unknown value', () => {
    const content = '<!--response_meta:{"type":"unknown_type"}--> Some content here.';
    const result = parseResponseMeta(content);
    expect(result.type).toBeNull();
    expect(result.cleanContent).toBe(content);
  });
});

describe('shouldAutoCreateDeliverable', () => {
  it('returns { create: false } for content shorter than 200 chars', () => {
    const content = 'This is a short response.';
    const task = { title: 'Short task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(false);
  });

  it('returns { create: false } for a heartbeat task title even with long content', () => {
    const content = 'X'.repeat(2000);
    const task = { title: 'heartbeat check' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(false);
  });

  it('returns { create: false } for a system task sourceType', () => {
    const content = 'X'.repeat(2000);
    const task = { title: 'Some task', sourceType: 'system' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(false);
  });

  it('returns { create: true } for content >500 chars with at least one structure signal (markdown header)', () => {
    const content = '# Header\n' + 'X'.repeat(492);
    const task = { title: 'Analysis task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(true);
  });

  it('returns { create: true } for content >500 chars with a code block', () => {
    const content = '```typescript\nconst x = 42;\n```\n' + 'X'.repeat(469);
    const task = { title: 'Implementation task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(true);
  });

  it('returns { create: true } for very long plain content (>1500 chars) with no structure', () => {
    const content = 'This is plain text. ' + 'X'.repeat(1500);
    const task = { title: 'Some task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(true);
  });

  it('returns { create: true } for 200-500 char content with 2+ structure signals', () => {
    const content = '# Header\n- List item\n' + 'X'.repeat(350);
    const task = { title: 'Some task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(true);
  });

  it('returns { create: false } for 200-500 char content with only 1 structure signal', () => {
    const content = '# Header\n' + 'X'.repeat(250);
    const task = { title: 'Some task' };
    const result = shouldAutoCreateDeliverable(content, task);
    expect(result.create).toBe(false);
  });
});

describe('inferTypeFromContent', () => {
  it('returns "code" when content has a fenced code block with a known language', () => {
    const content = '```typescript\nconst x = 42;\nreturn x;\n```';
    const lowerTitle = 'implement feature';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('code');
  });

  it('returns "code" when title includes "code"', () => {
    const content = 'Some plain content';
    const lowerTitle = 'write code for login';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('code');
  });

  it('returns "report" when title includes "analysis"', () => {
    const content = 'Some content here';
    const lowerTitle = 'perform analysis';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('report');
  });

  it('returns "report" when title includes "report"', () => {
    const content = 'Some content here';
    const lowerTitle = 'generate report';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('report');
  });

  it('returns "report" when content has executive summary pattern', () => {
    const content = 'Executive Summary: This is an analysis of the data.';
    const lowerTitle = 'task';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('report');
  });

  it('returns "document" as the fallback when no pattern matches', () => {
    const content = 'This is just some generic content.';
    const lowerTitle = 'generic task';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('document');
  });

  it('returns "email" when content has email patterns and title mentions email', () => {
    const content = 'Dear John,\n\nI wanted to reach out.\n\nRegards,\nAlice';
    const lowerTitle = 'send email';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('email');
  });

  it('returns "plan" when title includes "plan"', () => {
    const content = 'Some content here';
    const lowerTitle = 'create plan';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('plan');
  });

  it('returns "data" when content has table pattern', () => {
    const content = '| Header1 | Header2 |\n| --- | --- |\n| Value1 | Value2 |';
    const lowerTitle = 'some task';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('data');
  });

  it('returns "creative" when title includes "write"', () => {
    const content = 'Some content here';
    const lowerTitle = 'write blog post';
    const result = inferTypeFromContent(content, lowerTitle);
    expect(result).toBe('creative');
  });
});
