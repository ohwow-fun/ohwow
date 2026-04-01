import { describe, it, expect, beforeEach } from 'vitest';
import { decayAffects, computeAffectState } from '../affect-decay.js';
import { matchSomaticMarkers, createContextHash, summarizeSomaticWarnings } from '../somatic-markers.js';
import { AffectEngine } from '../affect-engine.js';
import type { AffectReading, SomaticMarker } from '../types.js';

describe('affect-decay', () => {
  it('should decay readings over time', () => {
    const now = Date.now();
    const readings: AffectReading[] = [{
      type: 'frustration',
      intensity: 1.0,
      valence: -0.7,
      arousal: 0.7,
      trigger: 'test',
      decayRate: 0.01,
      timestamp: now - 60_000, // 60 seconds ago
    }];

    const decayed = decayAffects(readings, now);
    expect(decayed.length).toBe(1);
    expect(decayed[0].intensity).toBeLessThan(1.0);
    expect(decayed[0].intensity).toBeGreaterThan(0);
  });

  it('should remove readings below intensity floor', () => {
    const now = Date.now();
    const readings: AffectReading[] = [{
      type: 'excitement',
      intensity: 0.1,
      valence: 0.7,
      arousal: 0.9,
      trigger: 'test',
      decayRate: 1.0, // very fast decay
      timestamp: now - 10_000,
    }];

    const decayed = decayAffects(readings, now);
    expect(decayed.length).toBe(0);
  });

  it('should compute weighted affect state', () => {
    const now = Date.now();
    const readings: AffectReading[] = [
      { type: 'frustration', intensity: 0.8, valence: -0.7, arousal: 0.7, trigger: 'a', decayRate: 0.001, timestamp: now },
      { type: 'curiosity', intensity: 0.3, valence: 0.3, arousal: 0.6, trigger: 'b', decayRate: 0.001, timestamp: now },
    ];

    const state = computeAffectState(readings, now);
    expect(state.dominant).toBe('frustration');
    expect(state.valence).toBeLessThan(0); // weighted toward frustration
    expect(state.affects.length).toBe(2);
  });

  it('should return neutral state when no readings', () => {
    const state = computeAffectState([], Date.now());
    expect(state.dominant).toBe('satisfaction');
    expect(state.valence).toBe(0);
    expect(state.affects.length).toBe(0);
  });
});

describe('somatic-markers', () => {
  it('should match exact context hash with highest relevance', () => {
    const markers: SomaticMarker[] = [
      { id: '1', contextHash: 'abc', affect: 'frustration', valence: -0.7, intensity: 0.8, outcome: 'negative', toolName: 'search', createdAt: '' },
      { id: '2', contextHash: 'def', affect: 'satisfaction', valence: 0.8, intensity: 0.5, outcome: 'positive', toolName: 'search', createdAt: '' },
    ];

    const matches = matchSomaticMarkers('abc', 'search', markers);
    expect(matches.length).toBe(2);
    expect(matches[0].relevance).toBe(1.0);
    expect(matches[0].marker.id).toBe('1');
  });

  it('should match by tool name with lower relevance', () => {
    const markers: SomaticMarker[] = [
      { id: '1', contextHash: 'xyz', affect: 'frustration', valence: -0.7, intensity: 0.8, outcome: 'negative', toolName: 'search', createdAt: '' },
    ];

    const matches = matchSomaticMarkers('different', 'search', markers);
    expect(matches.length).toBe(1);
    expect(matches[0].relevance).toBe(0.4);
  });

  it('should create deterministic context hashes', () => {
    const hash1 = createContextHash('search', 'find user');
    const hash2 = createContextHash('search', 'find user');
    const hash3 = createContextHash('search', 'find product');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });

  it('should summarize negative somatic warnings', () => {
    const matches = [
      { marker: { id: '1', contextHash: 'a', affect: 'frustration' as const, valence: -0.7, intensity: 0.8, outcome: 'negative' as const, toolName: 'search', createdAt: '' }, relevance: 1.0 },
    ];

    const summary = summarizeSomaticWarnings(matches);
    expect(summary).toContain('search');
    expect(summary).toContain('frustration');
  });

  it('should return null when no negative markers', () => {
    const matches = [
      { marker: { id: '1', contextHash: 'a', affect: 'satisfaction' as const, valence: 0.8, intensity: 0.5, outcome: 'positive' as const, toolName: 'search', createdAt: '' }, relevance: 1.0 },
    ];

    const summary = summarizeSomaticWarnings(matches);
    expect(summary).toBeNull();
  });
});

describe('AffectEngine', () => {
  let engine: AffectEngine;

  beforeEach(() => {
    engine = new AffectEngine(null, 'test-workspace');
  });

  it('should register affects and update state', () => {
    engine.feel('frustration', 'tool failed', 0.8);
    const state = engine.getState();
    expect(state.dominant).toBe('frustration');
    expect(state.valence).toBeLessThan(0);
  });

  it('should handle multiple affects with weighted dominance', () => {
    engine.feel('satisfaction', 'task done', 0.3);
    engine.feel('frustration', 'error', 0.9);
    const state = engine.getState();
    expect(state.dominant).toBe('frustration');
  });

  it('should process tool success as satisfaction', async () => {
    await engine.processToolResult('search', 'find data', true);
    const state = engine.getState();
    expect(state.affects.some(a => a.type === 'satisfaction')).toBe(true);
  });

  it('should process tool failure as frustration', async () => {
    await engine.processToolResult('search', 'find data', false);
    const state = engine.getState();
    expect(state.affects.some(a => a.type === 'frustration')).toBe(true);
  });

  it('should escalate repeated failures to anxiety', async () => {
    await engine.processToolResult('search', 'find data', false);
    await engine.processToolResult('api_call', 'send request', false);
    await engine.processToolResult('scrape', 'get page', false);
    const state = engine.getState();
    expect(state.affects.some(a => a.type === 'anxiety')).toBe(true);
  });

  it('should build prompt context for significant affects', () => {
    engine.feel('anxiety', 'repeated failures', 0.8);
    const ctx = engine.buildPromptContext();
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('anxiety');
  });

  it('should return null prompt context when neutral', () => {
    const ctx = engine.buildPromptContext();
    expect(ctx).toBeNull();
  });
});
