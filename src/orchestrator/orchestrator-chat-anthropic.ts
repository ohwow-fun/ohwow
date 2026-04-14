/**
 * Anthropic chat loop — the ~760-LOC inline body of LocalOrchestrator.runChat's
 * Anthropic branch, lifted into a standalone async generator. Invoked from
 * the dispatcher via `yield* this.runAnthropicChat(...)` where
 * `runAnthropicChat` is bound as a class field so `this` is still the
 * orchestrator instance at call time.
 *
 * The `this: LocalOrchestrator` parameter makes TypeScript treat the
 * function body as if it were a method on the class: private-field access,
 * getter reads, mutable field writes, and method calls all stay legal with
 * zero interface boilerplate. The `LocalOrchestrator` import is type-only
 * to avoid a runtime circular dependency — the orchestrator imports this
 * module, and this module only needs the class for type annotations.
 *
 * **Scaffold only (B7a).** The body moves in the next commit (B7b); this
 * commit exists so the scaffold can be reverted cleanly if the type cycle
 * bites unexpectedly.
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { LocalOrchestrator } from './local-orchestrator.js';
import type { ChannelChatOptions, OrchestratorEvent } from './orchestrator-types.js';

// eslint-disable-next-line require-yield -- B7a scaffold; body + yields land in B7b.
export async function* runAnthropicChat(
  this: LocalOrchestrator,
  _userMessage: string,
  _sessionId: string,
  _options?: ChannelChatOptions,
  _seedMessages?: MessageParam[],
): AsyncGenerator<OrchestratorEvent> {
  // Body moves here in B7b. Until then, this scaffold has no yields and
  // is never invoked — the dispatcher in runChat still runs the inline
  // Anthropic block exactly as it did before Phase B7 started. The
  // `void this` statement keeps the `this:` parameter live for type-
  // checkers without an access.
  void this;
}
