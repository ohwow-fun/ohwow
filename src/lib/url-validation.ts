/**
 * URL validation for workspace outbound requests.
 * Guards against SSRF by blocking private/internal IPs and cloud metadata endpoints.
 */

const MAX_URL_LENGTH = 2048;

/** Private/internal IPv4 ranges that must be blocked */
const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // link-local
  /^0\./, // 0.0.0.0/8
];

/** Specific IPs/hostnames for cloud metadata services */
const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '169.254.169.254',
  'metadata.google.internal',
]);

/** IPv6 private prefixes */
const PRIVATE_IPV6_PREFIXES = ['fc00:', 'fd00:', 'fe80:', '::1'];

function isPrivateHostname(hostname: string): boolean {
  if (BLOCKED_HOSTS.has(hostname.toLowerCase())) return true;

  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;

  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(bare)) return true;
  }

  const lower = bare.toLowerCase();
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  return false;
}

export type UrlValidationResult =
  | { valid: true; parsed: URL }
  | { valid: false; error: string };

/**
 * Validate a URL to block SSRF attacks.
 * Blocks private IPs, cloud metadata endpoints, and non-HTTP(S) protocols.
 */
export function validatePublicUrl(url: string): UrlValidationResult {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return { valid: false, error: 'URLs pointing to internal or private networks are not allowed' };
  }

  return { valid: true, parsed };
}

/**
 * Validate that a URL is a localhost URL (for Ollama and similar local services).
 */
/**
 * Check if an IP address is private or local (for restricting endpoints to LAN-only access).
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses (::ffff:x.x.x.x).
 */
export function isPrivateOrLocalIP(ip: string | undefined): boolean {
  if (!ip) return false;

  // Normalize IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1 → 127.0.0.1)
  let normalized = ip;
  const ffmpMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ffmpMatch) {
    normalized = ffmpMatch[1];
  }

  // Check blocked hosts
  if (BLOCKED_HOSTS.has(normalized)) return true;

  // Check IPv4 private ranges
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  // Check IPv6 private prefixes
  const lower = normalized.toLowerCase();
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (lower.startsWith(prefix) || lower === '::1') return true;
  }

  return false;
}

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}
