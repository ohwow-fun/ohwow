import { describe, it, expect } from 'vitest';
import { resolveStagehandCredentials } from '../local-browser.service.js';

describe('resolveStagehandCredentials', () => {
  it('prefers Anthropic from process.env over everything else', () => {
    const result = resolveStagehandCredentials(
      { ANTHROPIC_API_KEY: 'sk-ant-env' } as NodeJS.ProcessEnv,
      { openRouterApiKey: 'sk-or-file', openaiApiKey: 'sk-openai-file' },
    );
    expect(result).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      apiKey: 'sk-ant-env',
    });
  });

  it('falls back to Anthropic in runtime config when env has nothing', () => {
    const result = resolveStagehandCredentials(
      {} as NodeJS.ProcessEnv,
      { anthropicApiKey: 'sk-ant-file' },
    );
    expect(result.model).toBe('anthropic/claude-sonnet-4-5');
    expect(result.apiKey).toBe('sk-ant-file');
    expect(result.baseURL).toBeUndefined();
  });

  it('routes OpenRouter keys through the OpenAI provider with a base URL override', () => {
    // The launch-eve regression: user had only openRouterApiKey in
    // ~/.ohwow/config.json, Stagehand init logged apiKey: MISSING on
    // every boot because the resolver only looked at process.env and
    // didn't know how to map OpenRouter (an unsupported Stagehand
    // provider name) onto the OpenAI wire-compatible backend it is.
    const result = resolveStagehandCredentials(
      {} as NodeJS.ProcessEnv,
      { openRouterApiKey: 'sk-or-v1-test' },
    );
    expect(result.model).toBe('openai/gpt-4o-mini');
    expect(result.apiKey).toBe('sk-or-v1-test');
    expect(result.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('returns an empty apiKey (and no baseURL) when nothing is configured', () => {
    const result = resolveStagehandCredentials(
      {} as NodeJS.ProcessEnv,
      {},
    );
    expect(result.apiKey).toBe('');
    expect(result.baseURL).toBeUndefined();
  });

  it('env OPENROUTER_API_KEY also routes through the base URL override', () => {
    const result = resolveStagehandCredentials(
      { OPENROUTER_API_KEY: 'sk-or-env' } as NodeJS.ProcessEnv,
      {},
    );
    expect(result.apiKey).toBe('sk-or-env');
    expect(result.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('OpenAI key beats OpenRouter when both are present', () => {
    const result = resolveStagehandCredentials(
      { OPENAI_API_KEY: 'sk-openai-env' } as NodeJS.ProcessEnv,
      { openRouterApiKey: 'sk-or-file' },
    );
    expect(result.model).toBe('openai/gpt-4o-mini');
    expect(result.apiKey).toBe('sk-openai-env');
    expect(result.baseURL).toBeUndefined();
  });
});
