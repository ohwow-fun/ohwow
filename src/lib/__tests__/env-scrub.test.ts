import { describe, it, expect } from 'vitest';
import { scrubBashOutput } from '../env-scrub.js';

describe('scrubBashOutput', () => {
  it('redacts Fly.io FlyV1 tokens', () => {
    const input =
      'FLY_API_TOKEN=FlyV1 fm2_lJPECAAAAAAAEnqTxBDbHZ7ObYi/AreemhYLEEOzwrVodHRwczovL2FwaS5mbHkuaW8vdjGUAJLOABd0gx8Lk7lo,fm2_lJPETuvN/jTP5Y5Bu4VigMgCZiqLOA6opRBgG7Tb6C8ylRV5SD63Egn9lhRqY07kRnWvthBJu20PCri9FMoRsjz';
    const out = scrubBashOutput(input);
    expect(out).not.toContain('fm2_');
    expect(out).toContain('[REDACTED:FLY_TOKEN]');
  });

  it('redacts anthropic api keys', () => {
    const input = 'export ANTHROPIC_API_KEY=sk-ant-api03-abcDEFghi_jkl-MNOpqr0123456789_-stuVWXYZ';
    expect(scrubBashOutput(input)).toContain('[REDACTED:ANTHROPIC_KEY]');
  });

  it('redacts openai sk- keys', () => {
    const input = 'OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEF';
    expect(scrubBashOutput(input)).toContain('[REDACTED:OPENAI_KEY]');
  });

  it('redacts github personal access tokens', () => {
    const input = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
    expect(scrubBashOutput(input)).toContain('[REDACTED:GITHUB_TOKEN]');
  });

  it('redacts postgres credentials in URIs', () => {
    const input = 'postgresql://jesus:s3cret-pass@db.supabase.co:5432/postgres';
    const out = scrubBashOutput(input);
    expect(out).not.toContain('s3cret-pass');
    expect(out).toContain('jesus:[REDACTED:URI_CREDENTIAL]@');
  });

  it('redacts supabase JWTs', () => {
    const input =
      'SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstuv';
    expect(scrubBashOutput(input)).toContain('[REDACTED:JWT]');
  });

  it('redacts aws access key ids', () => {
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    expect(scrubBashOutput(input)).toContain('[REDACTED:AWS_KEY_ID]');
  });

  it('leaves benign text untouched', () => {
    const input = 'Hello world, 1234 files changed, 56 insertions(+), 78 deletions(-).';
    expect(scrubBashOutput(input)).toBe(input);
  });

  it('handles empty input', () => {
    expect(scrubBashOutput('')).toBe('');
  });
});
