# Eternal Systems — Implementation Roadmap

This document tracks what is built, what is designed but not yet built, and
what is next for the Eternal Systems stack. See `docs/eternal-systems.md` for
the full design and `src/eternal/` for the runtime implementation.

---

## Status: what is implemented

### Layer 1 — Values Corpus (partial)

- `src/eternal/values-reader.ts` reads a values corpus file from disk.
- `src/eternal/defaults.ts` ships a default EternalSpec with inactivity
  thresholds and a baseline escalation map.
- No automated enforcement of corpus rules yet — the corpus is readable but
  not yet wired into conductor decision scoring.

### Layer 3 — Operational Continuity (partial)

**Inactivity watcher** (`src/eternal/inactivity-watcher.ts`)

- Computes elapsed days since `last_activity_at`.
- Transitions `normal → conservative → estate` when thresholds are crossed.
- Fires once at daemon boot then every hour via `src/daemon/scheduling.ts`.
- Calls `notifyTrustee()` on every transition to conservative or estate mode.

**Conservative / estate mode**

- `src/eternal/state.ts` persists mode in the `eternal_state` SQLite table
  (migration 148).
- `src/autonomy/conductor.ts` reads the eternal state on every tick; skips
  autonomous work when mode is conservative or estate.

**Escalation map** (`src/eternal/escalation.ts`)

- `requiresTrusteeApproval(decisionType, amountCents, rules)` — pure function
  that evaluates the operator's EscalationRule set.
- Wired into `conductorTick`: if the top-ranked phase maps to a
  `requiresTrustee: true` decision type, the conductor writes a founder inbox
  question and returns early instead of running the arc autonomously.

**Trustee notifications** (`src/eternal/notifications.ts`)

- `notifyTrustee(db, mode, reason)` — stub that persists a row to
  `eternal_notifications` (migration 149) and emits a structured WARN log.
- Transport layer (email, SMS, webhook) is intentionally out of scope for now.

**CLI**

- `ohwow eternal status` — print current mode, last activity, days since active.
- `ohwow eternal conservative` — manually enter conservative mode.
- `ohwow eternal normal` — restore normal mode.
- `ohwow eternal init` — interactive wizard; writes `eternal.config.json` to
  the workspace data directory.

**API**

- `GET /api/eternal/state` — runtime HTTP endpoint returning the current
  EternalState (mode, timestamps, reason).

**Cloud dashboard** (`ohwow.fun`)

- `ConservativeModeIndicator` — amber banner in the DashboardShell that
  appears when the connected runtime reports conservative or estate mode.
  Polls `GET /api/eternal/state` every 60 seconds.

---

## What is designed but not built

### Layer 2 — Financial Autonomy

Design lives in `~/Documents/ohwow/eternal/layers/layer2-financial.md`
(private reference). Covers:

- Treasury allocation rules (what the runtime can spend autonomously, at what
  thresholds, in what categories).
- Integration with the expense tracking tables already in the database.
- Automated budget roll-up and overage detection.

No runtime implementation exists yet.

### Layer 4 — Relational Continuity

Design covers contact SLAs: the runtime should notice when high-value contacts
have not received a touchpoint in N days and surface that as an escalation
rather than letting relationships decay silently during an inactivity period.

No runtime implementation exists yet.

### Layer 5 — Legal Wrapper

Design covers the mechanism by which a trustee can assume operational control
of the runtime's outputs (deal pipeline, outbound communications, financial
commitments) in the event of an estate-mode transition.

No runtime implementation exists yet.

---

## What is next

In rough priority order:

1. **Trustee notifications transport** — wire a real delivery mechanism
   (email via Resend, SMS via Twilio, or webhook) to `notifyTrustee()`.
   The stub row + WARN log is sufficient for audit but not for real alerting.

2. **`eternal.config.json` loading** — `ohwow eternal init` writes the file
   but nothing reads it yet. The daemon should load it at boot and override
   `DEFAULT_ETERNAL_SPEC` so operator-configured thresholds take effect.

3. **Escalation map in dashboard** — the cloud dashboard should show the
   operator's current escalation map and let them edit it. Currently the map
   lives only in `eternal.config.json` or the compiled default.

4. **Layer 2 financial autonomy** — integrate the escalation map with the
   expense/budget tables so the runtime can enforce spend thresholds without
   manual intervention.

5. **Layer 4 relational SLAs** — connect the inactivity watcher to the
   contact graph so high-value relationship decay surfaces as an escalation
   during conservative mode.

6. **Layer 5 legal wrapper** — design and implement the trustee control
   handoff mechanism.
