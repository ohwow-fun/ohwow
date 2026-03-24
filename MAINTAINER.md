# Maintainer Operations Guide

How to run ohwow as an open-source project. Day-to-day operations, not code conventions (those live in [CLAUDE.md](./CLAUDE.md) and [CONTRIBUTING.md](./CONTRIBUTING.md)).

## Branch Protection (Do This First)

Go to **GitHub > Settings > Branches > Add rule** for `main`:

- Require pull request reviews before merging (1 reviewer minimum, even for yourself)
- Require status checks to pass (select `dco` and `check` from CI)
- Do not allow bypassing (locks even you out of force-pushing)
- Dismiss stale pull request approvals when new commits are pushed

Never push to main directly. Always work on a branch, open a PR, let CI pass, then merge.

## Daily Workflow

1. Someone opens an issue or PR
2. Triage it (label it, respond within 48-72h per [GOVERNANCE.md](./GOVERNANCE.md))
3. If it's a PR: review code, check CI passes, merge via GitHub UI
4. If it's a feature request: label `enhancement`, discuss, decide
5. If it's a bug: label `bug`, prioritize, fix or wait for a community PR

## Issue Labels

Create these on GitHub (Issues > Labels):

| Label | Purpose |
|-------|---------|
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `documentation` | Docs only |
| `good first issue` | Low-complexity, well-scoped. GitHub surfaces these to newcomers. |
| `help wanted` | You'd welcome a community PR |
| `question` | Needs clarification, not a bug or feature |
| `wontfix` | Intentionally closing without action |
| `duplicate` | Already tracked elsewhere |
| `breaking change` | Will require users to update their setup |
| `security` | Security-related (use sparingly, prefer private advisories) |

Tag 2-3 issues as `good first issue` before launch so newcomers have somewhere to start.

## Releases

The release workflow (`.github/workflows/release.yml`) publishes to npm on version tags.

```bash
# 1. Update CHANGELOG.md with what changed
# 2. Bump version
npm version patch   # or minor, or major

# 3. Push the tag (triggers the release workflow)
git push origin main --tags
```

### Semantic Versioning

While pre-1.0 (`0.x.x`), breaking changes are expected. Once you hit `1.0.0`:

- **patch** (0.0.x): bug fixes only
- **minor** (0.x.0): new features, backward compatible
- **major** (x.0.0): breaking changes

## Handling Contributions

When someone opens their first PR:

1. Thank them. This matters more than you think.
2. Check that CI passes and DCO is signed.
3. Review the code for quality, security, and alignment with the architecture.
4. Leave constructive comments. Be specific: "could you rename this to X" not "this naming is bad."
5. Approve and merge, or request changes with clear instructions.

Never ghost a contributor. Even if you're busy, drop a comment: "Saw this, will review this week." The [GOVERNANCE.md](./GOVERNANCE.md) promises 72h on PRs. Honor it or update the SLA.

## When You Disagree With a Request

GOVERNANCE.md says you're BDFL (Benevolent Dictator For Life). That means you have final say. But:

- Explain your reasoning publicly
- Be open to being wrong
- "I see the value but it doesn't fit the project direction" is a valid response
- Close issues you won't do with `wontfix` and a brief explanation

## Security Reports

The [SECURITY.md](./SECURITY.md) defines a disclosure process. When you get one:

1. Acknowledge within 48h (as promised in the policy)
2. Fix in private (don't discuss in public issues)
3. Release a patch
4. Credit the reporter (unless they want anonymity)
5. Publish a security advisory on GitHub (Settings > Security > Advisories)

## Discord Structure

### Channels

| Channel | Purpose |
|---------|---------|
| `#announcements` | Releases, breaking changes, important updates. Lock it so only you can post. |
| `#general` | Casual chat |
| `#help` | "How do I..." questions. Keeps #general usable. |
| `#bugs` | Bug reports that aren't ready for GitHub issues yet |
| `#feature-ideas` | Discussion before someone writes an RFC |
| `#contributions` | For people working on PRs, asking about the codebase |
| `#showcase` | People sharing what they built with ohwow |
| `#github-feed` | Automated feed of new issues, PRs, and releases |

### Roles

- **Maintainer**: full permissions (you)
- **Contributor**: people who've had a PR merged. Give them a color. Recognition matters.
- **Community**: default role for everyone else

### Rules (pin in #announcements or a welcome channel)

1. Be kind (link the [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md))
2. Bug reports go on GitHub, not Discord (Discord messages get lost)
3. Search before asking
4. No DMs to maintainers for support (keep it public so others benefit)

### Bots

- **GitHub integration**: posts new issues, PRs, and releases to `#github-feed`
- **MEE6 or Carl-bot**: auto-role assignment, welcome messages, moderation

### The Most Important Discord Rule

Redirect to GitHub. Discord is for discussion. GitHub is for decisions. When someone reports a bug in Discord, say: "That's a real bug. Can you open an issue on GitHub so we can track it?" This keeps your project history in one place.

## Pre-Launch Checklist

- [ ] Enable branch protection on `main` in GitHub Settings
- [ ] Create issue labels (see table above)
- [ ] Set up Discord channels
- [ ] Add the GitHub integration to Discord
- [ ] Pin CONTRIBUTING.md link in Discord `#contributions`
- [ ] Tag 2-3 issues as `good first issue`
- [ ] Enable GitHub Discussions (Settings > Features) for async Q&A
