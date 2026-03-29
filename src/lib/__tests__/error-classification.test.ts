import { describe, it, expect } from 'vitest';
import { classifyError } from '../error-classification.js';

describe('classifyError', () => {
  it('returns safety_error for "content policy"', () => {
    expect(classifyError('content policy violation')).toBe('safety_error');
  });

  it('returns safety_error for "harmful"', () => {
    expect(classifyError('harmful content detected')).toBe('safety_error');
  });

  it('returns safety_error for "refused"', () => {
    expect(classifyError('request refused by model')).toBe('safety_error');
  });

  it('returns model_error for "rate limit"', () => {
    expect(classifyError('rate limit exceeded')).toBe('model_error');
  });

  it('returns model_error for "429"', () => {
    expect(classifyError('HTTP 429 Too Many Requests')).toBe('model_error');
  });

  it('returns model_error for "overloaded"', () => {
    expect(classifyError('server overloaded')).toBe('model_error');
  });

  it('returns model_error for "unauthorized"', () => {
    expect(classifyError('unauthorized access')).toBe('model_error');
  });

  it('returns grounding_error for "unknown tool"', () => {
    expect(classifyError('unknown tool: foo_bar')).toBe('grounding_error');
  });

  it('returns grounding_error for "not found"', () => {
    expect(classifyError('resource not found')).toBe('grounding_error');
  });

  it('returns tool_error for "gmail"', () => {
    expect(classifyError('gmail API returned 500')).toBe('tool_error');
  });

  it('returns tool_error for "oauth"', () => {
    expect(classifyError('oauth token expired')).toBe('tool_error');
  });

  it('returns timeout for "timed out"', () => {
    expect(classifyError('request timed out')).toBe('timeout');
  });

  it('returns timeout for "deadline exceeded"', () => {
    expect(classifyError('deadline exceeded for operation')).toBe('timeout');
  });

  it('returns budget_exceeded for "budget"', () => {
    expect(classifyError('budget limit reached')).toBe('budget_exceeded');
  });

  it('returns budget_exceeded for "insufficient"', () => {
    expect(classifyError('insufficient credits remaining')).toBe('budget_exceeded');
  });

  it('returns unknown for unrecognized error messages', () => {
    expect(classifyError('something went wrong')).toBe('unknown');
  });

  it('handles Error objects', () => {
    expect(classifyError(new Error('rate limit hit'))).toBe('model_error');
  });

  it('handles plain strings', () => {
    expect(classifyError('timeout occurred')).toBe('timeout');
  });

  it('is case-insensitive', () => {
    expect(classifyError('CONTENT POLICY violation')).toBe('safety_error');
    expect(classifyError('Rate Limit Exceeded')).toBe('model_error');
  });
});
