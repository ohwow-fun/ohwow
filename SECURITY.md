# Security Policy

## Supported Versions

Only the latest release is supported with security updates.

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

Email **security@ohwow.fun** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment (what an attacker could do)

**Response timeline:**
- 48 hours: acknowledgment
- 7 days: initial assessment
- 30 days: target for fix or mitigation

We will coordinate disclosure with you. Please do not open a public issue for security vulnerabilities.

## Scope

ohwow runs locally by default, which limits the attack surface. The areas most relevant to security are:

- **HTTP API server** (port 7700, bound to localhost by default)
- **Browser automation** (Playwright sessions)
- **Messaging integrations** (WhatsApp, Telegram)
- **MCP server connections** (external tool access)
- **Code sandbox** (isolated vm execution)

## Security Features

ohwow includes several built-in security measures:

- Sandboxed code execution (no filesystem, network, or process access)
- Approval workflows for sensitive actions (configurable autonomy levels)
- Trust levels for A2A protocol connections
- Anomaly detection for unusual agent behavior
- Action journaling for audit trails
- Filesystem guards blocking access to sensitive paths (.ssh, .gnupg, .aws, .env)

### Prompt Injection Scanning

Prompt injection scanning is **observability-only**: inputs are scanned against known patterns and matches are logged, but not blocked. This provides visibility into potential injection attempts but should not be relied upon as a defense mechanism. Treat all agent outputs as untrusted and use approval workflows for sensitive actions.
