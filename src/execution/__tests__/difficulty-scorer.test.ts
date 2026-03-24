import { describe, it, expect } from 'vitest';
import { scoreDifficulty } from '../difficulty-scorer.js';

describe('scoreDifficulty', () => {
  it('returns simple for short task with few tools', () => {
    const result = scoreDifficulty({
      taskDescription: 'Send an email',
      toolCount: 1,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    expect(result).toBe('simple');
  });

  it('returns complex for long task with many tools and integrations', () => {
    const words = Array(201).fill('word').join(' ');
    const result = scoreDifficulty({
      taskDescription: words,
      toolCount: 6,
      hasIntegrations: true,
      hasBrowserTools: false,
    });
    expect(result).toBe('complex');
  });

  it('scores higher with complexity keywords', () => {
    const result = scoreDifficulty({
      taskDescription: 'Analyze the sales data and produce a report',
      toolCount: 3,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    // toolCount >= 3 → +1, complexity keyword "analyze" → +1, wordCount < 50 → -1 = score 1 → moderate
    expect(result).toBe('moderate');
  });

  it('reduces score with simplicity keywords', () => {
    // Without simplicity keyword: toolCount 3 → +1, wordCount < 50 → -1 = score 0 → simple
    // With simplicity keyword: same + -1 = score -1 → simple
    const result = scoreDifficulty({
      taskDescription: 'List all the items in the database',
      toolCount: 3,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    expect(result).toBe('simple');
  });

  it('handles null taskDescription without crashing', () => {
    const result = scoreDifficulty({
      taskDescription: null,
      toolCount: 1,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    // null → '', wordCount 0 < 50 → -1, toolCount 1 <= 2 → -1, score = -2 → simple
    expect(result).toBe('simple');
  });

  it('handles empty string taskDescription', () => {
    const result = scoreDifficulty({
      taskDescription: '',
      toolCount: 1,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    expect(result).toBe('simple');
  });

  it('increases score when hasBrowserTools is true', () => {
    // wordCount < 50 → -1, toolCount 3 → +1, browserTools → +1 = score 1 → moderate
    const result = scoreDifficulty({
      taskDescription: 'Do a quick task',
      toolCount: 3,
      hasIntegrations: false,
      hasBrowserTools: true,
    });
    expect(result).toBe('moderate');
  });

  it('increases score when hasIntegrations is true', () => {
    // wordCount < 50 → -1, toolCount 3 → +1, integrations → +1 = score 1 → moderate
    const result = scoreDifficulty({
      taskDescription: 'Do a quick task',
      toolCount: 3,
      hasIntegrations: true,
      hasBrowserTools: false,
    });
    expect(result).toBe('moderate');
  });

  it('partially cancels when both complexity and simplicity keywords present', () => {
    // "analyze" → +1, "list" → -1, cancel out
    // wordCount < 50 → -1, toolCount 1 → -1 = score -2 → simple
    const result = scoreDifficulty({
      taskDescription: 'List and analyze the data',
      toolCount: 1,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    expect(result).toBe('simple');
  });

  it('returns moderate at score boundary of 1', () => {
    // wordCount < 50 → -1, toolCount >= 3 → +1, integrations → +1 = score 1 → moderate
    const result = scoreDifficulty({
      taskDescription: 'Run this task now',
      toolCount: 3,
      hasIntegrations: true,
      hasBrowserTools: false,
    });
    expect(result).toBe('moderate');
  });

  it('returns moderate at score boundary of 2', () => {
    // wordCount < 50 → -1, toolCount >= 3 → +1, integrations → +1, browserTools → +1 = score 2 → moderate
    const result = scoreDifficulty({
      taskDescription: 'Run this task now',
      toolCount: 3,
      hasIntegrations: true,
      hasBrowserTools: true,
    });
    expect(result).toBe('moderate');
  });

  it('returns complex at score boundary of 3', () => {
    // wordCount < 50 → -1, toolCount >= 6 → +2, integrations → +1, browserTools → +1 = score 3 → complex
    const result = scoreDifficulty({
      taskDescription: 'Run this task now',
      toolCount: 6,
      hasIntegrations: true,
      hasBrowserTools: true,
    });
    expect(result).toBe('complex');
  });

  it('returns simple at score 0', () => {
    // wordCount < 50 → -1, toolCount >= 3 → +1 = score 0 → simple
    const result = scoreDifficulty({
      taskDescription: 'Do something with the data',
      toolCount: 3,
      hasIntegrations: false,
      hasBrowserTools: false,
    });
    expect(result).toBe('simple');
  });
});
