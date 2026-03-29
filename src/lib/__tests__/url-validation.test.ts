import { describe, it, expect } from 'vitest';
import { validatePublicUrl, isPrivateOrLocalIP } from '../url-validation.js';

describe('validatePublicUrl', () => {
  it('accepts valid public URLs', () => {
    expect(validatePublicUrl('https://example.com/api').valid).toBe(true);
    expect(validatePublicUrl('https://mcp.acme.io:8443/v1').valid).toBe(true);
  });

  it('blocks localhost/loopback', () => {
    expect(validatePublicUrl('http://127.0.0.1:3000').valid).toBe(false);
    expect(validatePublicUrl('http://localhost:8080').valid).toBe(false);
    expect(validatePublicUrl('http://[::1]:3000').valid).toBe(false);
  });

  it('blocks private network ranges', () => {
    expect(validatePublicUrl('http://10.0.0.1/api').valid).toBe(false);
    expect(validatePublicUrl('http://172.16.0.1/api').valid).toBe(false);
    expect(validatePublicUrl('http://192.168.1.1/api').valid).toBe(false);
  });

  it('blocks cloud metadata endpoints', () => {
    expect(validatePublicUrl('http://169.254.169.254/latest/meta-data').valid).toBe(false);
    expect(validatePublicUrl('http://metadata.google.internal/computeMetadata').valid).toBe(false);
  });

  it('blocks non-HTTP protocols', () => {
    expect(validatePublicUrl('ftp://example.com').valid).toBe(false);
    expect(validatePublicUrl('file:///etc/passwd').valid).toBe(false);
  });

  it('rejects empty/invalid input', () => {
    expect(validatePublicUrl('').valid).toBe(false);
    expect(validatePublicUrl('not-a-url').valid).toBe(false);
  });
});

describe('isPrivateOrLocalIP', () => {
  it('returns true for loopback addresses', () => {
    expect(isPrivateOrLocalIP('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIP('::1')).toBe(true);
  });

  it('returns true for private IPv4 ranges', () => {
    expect(isPrivateOrLocalIP('10.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIP('172.16.0.1')).toBe(true);
    expect(isPrivateOrLocalIP('192.168.1.100')).toBe(true);
  });

  it('returns true for IPv4-mapped IPv6 addresses', () => {
    expect(isPrivateOrLocalIP('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIP('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIP('::ffff:192.168.0.1')).toBe(true);
  });

  it('returns true for IPv6 private prefixes', () => {
    expect(isPrivateOrLocalIP('fc00::1')).toBe(true);
    expect(isPrivateOrLocalIP('fd00::1')).toBe(true);
    expect(isPrivateOrLocalIP('fe80::1')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateOrLocalIP('8.8.8.8')).toBe(false);
    expect(isPrivateOrLocalIP('1.1.1.1')).toBe(false);
    expect(isPrivateOrLocalIP('203.0.113.1')).toBe(false);
  });

  it('returns false for undefined/empty', () => {
    expect(isPrivateOrLocalIP(undefined)).toBe(false);
    expect(isPrivateOrLocalIP('')).toBe(false);
  });
});
