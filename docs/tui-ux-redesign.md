# TUI UX Redesign

This is the design authority for the full TUI user-journey overhaul.
Generated from a first-principles brainstorm (April 2026).
Every TRIO that touches the TUI must check this file for the ruling
on any ambiguous decision, and log deviations here.

---

## The eternal insight

ohwow is about **trust between a founder and an AI team.**
Every UX decision either builds or destroys that trust.

Trust is built when:
- the team shows you what they're doing without being asked
- you can act on something important in two keystrokes
- you know the system is healthy at a glance
- the experience feels like managing people, not operating machinery

Trust is destroyed when:
- you have to download 4 GB before seeing anything
- arrow keys stop working and you don't know why
- approvals sit unseen in a buried tab
- the product opens to a blank input asking you to say something

---

## The three-sentence redesign

**Onboarding is a task, not a wizard.** Two questions max — business name
and first task. Everything else is inferred or deferred.

**Home is a state board, not a chat window.** You open it and see the
state of your team without typing anything. Urgencies surface to you.

**Navigation is four keys.** Today, Team, Work, Settings. Number keys
`1–4` reach them from anywhere.

---

## Design principles (rules every TRIO must obey)

1. **Infrastructure is deferred.** Model selection, license key, tier
   choice, integration tokens — none of these block the first session.
   They surface contextually as the user hits limits.

2. **Chat is a tool you pick up, not the ground state.** The default
   view is the state board. Chat is entered deliberately.

3. **Approvals are always visible.** A pending approval is never behind
   a tab. It is always in the top section of the Today view.

4. **One keyboard grammar.** `j/k` navigates lists everywhere. `Enter`
   opens/confirms everywhere. `Escape` goes back exactly one level,
   nothing else. `d` dispatches a task from anywhere. `?` shows
   context help. `1-4` switches primary sections. These never change.

5. **Team management, not sysadmin.** If a decision makes the user feel
   like they're configuring software, push it to Settings or defer it.
   If it makes them feel like they're managing a team, it belongs up front.

6. **Visible state, always.** A one-line status bar at the bottom shows
   the current section, available keys, and model/daemon health. No
   invisible modes.

7. **No wizards in the post-onboarding product.** Wizards (multi-step
   overlays with a progress tracker) only exist for initial setup steps
   that genuinely can't be deferred. Post-onboarding, all configuration
   is inline in Settings.

---

## Information architecture

```
TODAY (1)              TEAM (2)           WORK (3)           SETTINGS (4)
─────────────────      ────────────────   ─────────────────  ─────────────────
Agent roster           Agent roster       Task history       Model
  ● idle               Agent detail       Task detail        Integrations
  ◉ working            Create agent       Session history    License
  ✗ error              MCP tools          Media gallery      Tunnel
                       A2A connections    Search             Webhooks
Attention queue        Contacts           Automations        MCP servers
  🔴 approvals         People                                Peers
  🟡 errors
  ✓ reviews

Dispatch rail
  d → dispatch
```

Key collapses vs current:
- Dashboard + Chat → part of TODAY (state board is home)
- Approvals tab → section inside TODAY (always visible, never buried)
- Activity tab → merged into WORK (task history + activity log = same data)
- Contacts + People → both inside TEAM
- Automations tab → inside WORK (it defines recurring work, not settings)
- Settings tab → stays as SETTINGS (4)
- All wizards (LocalModelWizard, LicenseKeyWizard, TunnelSetupWizard,
  AgentCreateWizard, McpServerWizard) → become inline sections of SETTINGS

---

## Onboarding redesign

### Before (current — 10 steps)

ExperienceChoice → Splash → TierChoice → Model → BusinessInfo →
FounderStage → AgentDiscovery → AgentSelection → IntegrationSetup → Ready

### After (target — 2 moments)

**Moment 1 (first run, ~15 seconds):**
```
What's your business called?   > Acme Corp
What should your first agent do?  > Follow up with my leads this week
                                    [Enter]
```
System: creates one agent, queues task, picks best available model,
shows state board with agent "setting up…".

**Moment 2 (contextual, never blocking):**
Surfaces as inline prompts in TODAY when the system hits a limit:
- "Add a model to work offline →" (when cloud is slow)
- "Connect HubSpot for this task →" (when agent needs a tool)
- "Add a license key to unlock more agents →" (when agent limit is hit)

### Rules for onboarding TRIOs:

- ExperienceChoiceStep is deleted, not refactored
- SplashStep keeps the ASCII art, removes everything else
- TierChoiceStep is deleted, license key moves to Settings
- ModelStep is deleted from onboarding, moves to Settings
- BusinessInfo + FounderStage are merged into one 2-field screen
- AgentDiscovery is deleted; the first task IS the discovery
- AgentSelectionStep is deleted; agents are inferred from the first task
- IntegrationSetupStep is deleted; integrations surface contextually
- ReadyStep text: "Your team is getting started." + show state board

---

## Work units (TRIOs)

Each TRIO is one work unit: plan → impl → qa.
Check the box when QA completes and passes.

---

### Phase 1: Onboarding collapse

**TRIO-01** `[x]` — Remove ExperienceChoiceStep gate
- Delete `ExperienceChoiceStep.tsx` and the `experience_choice` view branch
  in `app.tsx`
- The web onboarding is a separate product; don't expose the choice in TUI
- First run goes directly to the new 2-field onboarding screen
- Files: `src/tui/app.tsx`, `src/tui/screens/onboarding/ExperienceChoiceStep.tsx`,
  `src/tui/screens/onboarding/WebOnboardingWaiter.tsx` (remove from onboarding flow)
- Test criterion: `npm run tui-journey` shows no ExperienceChoice screen;
  first-run route goes directly to SplashStep

**TRIO-02** `[x]` — Merge BusinessInfo + FounderStage → one screen
- Replace two-step sequence with a single `FirstMomentStep.tsx`
- Fields: business name (text), first task (text)
- No business type selector, no founder path enum, no description field
- Infer business type from the task text (or skip — agents learn from work)
- Files: `src/tui/screens/onboarding/BusinessInfoStep.tsx` (replace),
  `src/tui/screens/onboarding/FounderStageStep.tsx` (delete),
  `src/tui/screens/onboarding-wizard.tsx` (remove FounderStage step)
- Test criterion: `npm run tui-journey` shows one input screen with two fields;
  no business type list; no founder path list

**TRIO-03** `[x]` — Remove ModelStep from onboarding; defer model selection
- Delete ModelStep from onboarding wizard sequence
- On first run, if Anthropic API key exists in env → use claude-haiku
- If no key → queue tasks and show "model offline" in state board attention queue
- Model selection moves to Settings (see TRIO-10)
- Files: `src/tui/screens/onboarding/ModelStep.tsx` (remove from flow),
  `src/tui/screens/onboarding-wizard.tsx`, `src/tui/app.tsx`
- Test criterion: tui-journey shows no model download screen in onboarding path;
  returning user path goes direct to dashboard without model check

**TRIO-04** `[x]` d2cb19a — Remove AgentDiscovery + AgentSelection from onboarding
- Delete AgentDiscoveryStep and AgentSelectionStep from onboarding wizard
- On first run, create a single general-purpose agent named after the business
  (e.g., "Acme Agent") with the first task queued to it
- Specialised agents are created from TEAM (post-onboarding)
- Files: `src/tui/screens/onboarding/AgentDiscoveryStep.tsx` (remove from flow),
  `src/tui/screens/onboarding/AgentSelectionStep.tsx` (remove from flow),
  `src/tui/screens/onboarding/IntegrationSetupStep.tsx` (remove from flow),
  `src/tui/screens/onboarding-wizard.tsx`
- Test criterion: tui-journey shows no agent discovery chat, no checkbox list;
  ReadyStep renders "Your team is getting started."

---

### Phase 2: Today state board

**TRIO-05** `[x]` — Build Today state board shell (b410401)
- Replace the Dashboard screen (`src/tui/screens/dashboard/`) with a `Today`
  screen that has three zones in a single layout (no focus zones, no grid menu):
  - Left column (~40%): agent roster with live status + current activity line
  - Center column (~45%): attention queue (placeholder for now, wired in TRIO-06)
  - Bottom strip: dispatch rail prompt ("d to dispatch")
- Retire `GridMenuPanel` — navigation is by number keys (TRIO-09)
- Retire `ChatPanel` as the home ground state — chat mode is entered via `c` key
- Files: `src/tui/screens/dashboard/index.tsx`, `src/tui/screens/dashboard/grid-menu.tsx`
- Test criterion: tui-journey renders Today with left/center/bottom zones;
  no grid rendered; agent list visible without navigating

**TRIO-06** `[x]` — Wire approvals into Today attention queue
- Approvals appear in the top section of the center attention queue column,
  highlighted red, sorted by age (oldest first)
- Pressing `a` on a highlighted approval immediately approves it
- Pressing `r` on one opens the rejection reason input
- Approvals no longer require navigating to the Approvals tab
- The Approvals tab is kept as a detail view (full list) but is not a required
  navigation path for normal approvals
- Files: `src/tui/screens/dashboard/index.tsx` (Today center column),
  `src/tui/screens/approvals.tsx` (keep as detail view)
- Test criterion: tui-journey with mock pending approval shows red item in
  center column without navigating to Approvals tab

---

### Phase 3: Navigation IA

**TRIO-07** `[ ]` — Replace tab bar + grid with 4-section nav
- Today (1), Team (2), Work (3), Settings (4)
- Remove `TAB_SCREENS` 8-item list; replace with 4-section enum
- Remove the grid menu component from the home screen
- The old tab screens map to the new sections:
  - Dashboard + Chat → Today
  - Agents + Contacts + People + A2A → Team
  - Tasks + Activity + Sessions + MediaGallery → Work
  - Automations + Settings + all wizard screens → Settings
- Files: `src/tui/types.ts` (new Section enum alongside Screen),
  `src/tui/screens/dashboard/index.tsx` (section switching logic),
  nav bar component
- Test criterion: tui-journey shows 4-section nav bar; pressing 1-4 switches
  sections without going through the grid

**TRIO-08** `[x]` — Merge Contacts + People → Team; Activity → Work (SHA: 908aa47)
- `Contacts` and `People` both appear under TEAM as subsections
- `Activity` merges into WORK as a "history" view alongside Tasks
- `Automations` moves from tab to WORK section
- Deduplicates the "what has happened" narrative across Activity + Tasks
- Files: `src/tui/screens/contacts-list.tsx`, `src/tui/screens/people.tsx`,
  `src/tui/screens/activity-log.tsx`, `src/tui/screens/tasks-list.tsx`,
  section routing in `dashboard/index.tsx`
- Test criterion: no standalone Contacts tab or People tab in the nav;
  both accessible via Team (2) subsections

---

### Phase 4: Keyboard grammar

**TRIO-09** `[x]` — Implement universal keyboard grammar + status bar (SHA: 3332272)
- Every screen registers its available keys in a central registry
- A status bar at the bottom of every view renders:
  `[TODAY] j/k:nav  Enter:open  Esc:back  d:dispatch  ?:help`
- It updates as the user navigates into different screens/sections
- `j/k` navigate lists on all screens (replace mixed arrow-key/j-k patterns)
- `Escape` is strictly back/cancel — it never clears input (use Ctrl+U for that)
- Files: `src/tui/components/key-hints.tsx` (evolve into status bar),
  per-screen key registrations, `dashboard/index.tsx`
- Test criterion: tui-journey renders status bar on every screen;
  Escape handler audit passes (no Escape-clears-input patterns remain)

**TRIO-10** `[x]` — Universal dispatch from anywhere (`d` key)
- Pressing `d` from any screen opens a floating dispatch overlay:
  `Dispatch: [____________] @agent (optional)`
- Pressing Enter queues the task and closes the overlay
- Pressing Escape closes without queuing
- Focus returns to wherever the user was
- Files: new `src/tui/components/dispatch-overlay.tsx`,
  global key handler in `dashboard/index.tsx`
- Test criterion: tui-journey shows dispatch overlay renders independently
  of which screen is active; d key is tested from Today, Team, and Work

---

### Phase 5: Post-onboarding landing

**TRIO-11** `[ ]` — Post-onboarding: land on Today with first agent live
- After `handleOnboardingComplete`, navigate to Today (not blank chat)
- Today shows the newly-created agent with status "setting up…" or the
  first task already queued in the attention queue
- Remove the `needsOnboarding` nudge banner (replace with Today attention
  item "Finish setting up your team →" if config is incomplete)
- Files: `src/tui/app.tsx` (handleOnboardingComplete),
  `src/tui/screens/dashboard/index.tsx` (remove needsOnboarding banner)
- Test criterion: tui-journey ReadyStep → Today transition shows agent
  in roster, not blank chat; no "you haven't onboarded" banner present

---

## Progress tracker

| TRIO | Description | Status | SHA |
|------|-------------|--------|-----|
| TRIO-01 | Remove ExperienceChoiceStep | done | 7870792 |
| TRIO-02 | Merge BusinessInfo + FounderStage | done | 2a676a2 |
| TRIO-03 | Remove ModelStep from onboarding | done | b005231 |
| TRIO-04 | Remove AgentDiscovery + AgentSelection | done | d2cb19a |
| TRIO-05 | Build Today state board shell | done | b410401 |
| TRIO-06 | Wire approvals into Today | done | 2091af7 |
| TRIO-07 | 4-section nav (replace tab + grid) | done | 5551565 |
| TRIO-08 | Merge Contacts + People; Activity → Work | done | 908aa47 |
| TRIO-09 | Universal keyboard grammar + status bar | done | 3332272 |
| TRIO-10 | Universal dispatch overlay (d key) | done | 4429770 |
| TRIO-11 | Post-onboarding Today landing | pending | — |

---

## Deviation log

If a TRIO's impl or qa round finds a hard constraint that prevents
following the design above, log it here before deviating.

Format:
```
TRIO-XX deviation: [what was planned] → [what was actually done] — [reason]
```

(empty — no deviations yet)

---

## References

- Brainstorm session: conversation with Jesus, 2026-04-21
- Journey simulator: `scripts/tui-journey.tsx` (run: `npm run tui-journey`)
- Current screen enum: `src/tui/types.ts`
- Onboarding wizard: `src/tui/screens/onboarding-wizard.tsx`
- Dashboard: `src/tui/screens/dashboard/index.tsx` (1821 lines)
- be-ohwow ledger: `~/Documents/ohwow/ohwow.fun/e2e/helpers/ux-audit/progress/`
