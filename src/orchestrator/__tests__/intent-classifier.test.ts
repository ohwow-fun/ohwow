import { describe, it, expect } from 'vitest';
import { classifyIntent, CONFIRMATION_PATTERN } from '../intent-classifier.js';

describe('classifyIntent', () => {
  it('"hey" → intent=greeting, mode=conversational', () => {
    const result = classifyIntent('hey');
    expect(result.intent).toBe('greeting');
    expect(result.mode).toBe('conversational');
  });

  it('"good morning" → intent=greeting', () => {
    const result = classifyIntent('good morning');
    expect(result.intent).toBe('greeting');
  });

  it('"read the config file" → intent=file, sections has filesystem', () => {
    const result = classifyIntent('read the config file');
    expect(result.intent).toBe('file');
    expect(result.sections.has('filesystem')).toBe(true);
  });

  it('"run agent Scout" → intent=task, sections has agents', () => {
    const result = classifyIntent('run agent Scout');
    expect(result.intent).toBe('task');
    expect(result.sections.has('agents')).toBe(true);
  });

  it('"how are things going" → intent=status, mode=conversational', () => {
    const result = classifyIntent('how are things going');
    expect(result.intent).toBe('status');
    expect(result.mode).toBe('conversational');
  });

  it('"research competitor pricing" → intent=research', () => {
    const result = classifyIntent('research competitor pricing');
    expect(result.intent).toBe('research');
  });

  it('"find the lead John" → intent=crm', () => {
    const result = classifyIntent('find the lead John');
    expect(result.intent).toBe('crm');
  });

  it('"send whatsapp message" → intent=message', () => {
    const result = classifyIntent('send whatsapp message');
    expect(result.intent).toBe('message');
  });

  it('"open the website" → intent=browser', () => {
    const result = classifyIntent('open the website');
    expect(result.intent).toBe('browser');
  });

  it('"generate an image of a cat" → intent=media', () => {
    const result = classifyIntent('generate an image of a cat');
    expect(result.intent).toBe('media');
  });

  it('"create a strategy for Q2" → intent=plan', () => {
    const result = classifyIntent('create a strategy for Q2');
    expect(result.intent).toBe('plan');
  });

  it('random text falls back to intent=general', () => {
    const result = classifyIntent('lorem ipsum dolor sit amet');
    expect(result.intent).toBe('general');
  });

  it('"yes" with previousIntent inherits sections and sets mode=execute', () => {
    const previous = classifyIntent('research competitor pricing');
    const result = classifyIntent('yes', previous);
    expect(result.intent).toBe(previous.intent);
    expect(result.sections).toBe(previous.sections);
    expect(result.mode).toBe('execute');
    expect(result.planFirst).toBe(false);
  });

  it('"go ahead" matches CONFIRMATION_PATTERN', () => {
    expect(CONFIRMATION_PATTERN.test('go ahead')).toBe(true);
  });

  it('"set up a multi-step workflow" → planFirst=true', () => {
    const result = classifyIntent('set up a multi-step workflow');
    expect(result.planFirst).toBe(true);
  });

  it('"show me the agents" → general with explore mode', () => {
    // "agents" (plural) doesn't match task pattern which requires \bagent\b (singular)
    // Falls through to general, but EXPLORE_PATTERN matches "show" at start
    const result = classifyIntent('show me the agents');
    expect(result.intent).toBe('general');
    expect(result.mode).toBe('explore');
  });

  it('case insensitivity: "HELLO" matches greeting', () => {
    const result = classifyIntent('HELLO');
    expect(result.intent).toBe('greeting');
  });

  it('empty-ish message falls back to general', () => {
    const result = classifyIntent('   ');
    expect(result.intent).toBe('general');
  });
});
