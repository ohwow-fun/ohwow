import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGhlSignature } from '../signature.js';

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyGhlSignature', () => {
  const secret = 'test-webhook-secret';
  const body = '{"type":"contact.create","data":{"id":"123"}}';

  it('returns true for valid HMAC-SHA256 signature', () => {
    const signature = sign(body, secret);
    expect(verifyGhlSignature(body, signature, secret)).toBe(true);
  });

  it('returns false for tampered body', () => {
    const signature = sign(body, secret);
    expect(verifyGhlSignature(body + 'tampered', signature, secret)).toBe(false);
  });

  it('returns false for tampered signature', () => {
    expect(verifyGhlSignature(body, 'invalid-hex-signature', secret)).toBe(false);
  });

  it('returns false when secret is missing', () => {
    const signature = sign(body, secret);
    expect(verifyGhlSignature(body, signature, undefined)).toBe(false);
  });

  it('returns false when signature header is missing', () => {
    expect(verifyGhlSignature(body, undefined, secret)).toBe(false);
  });

  it('works with Buffer rawBody input', () => {
    const bufBody = Buffer.from(body);
    const signature = sign(body, secret);
    expect(verifyGhlSignature(bufBody, signature, secret)).toBe(true);
  });

  it('returns false when signature has different length (catches timingSafeEqual length mismatch)', () => {
    expect(verifyGhlSignature(body, 'short', secret)).toBe(false);
  });
});
