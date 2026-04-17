/**
 * Registry for in-process tick handlers that schedule-type automations
 * can invoke via the run_internal dispatcher. Complements shell_script
 * for work that would be expensive or clumsy to extract into a standalone
 * Node script (e.g. scheduler classes with deep runtime dependencies like
 * a model router, a channel registry, or a singleton scraper lane).
 *
 * Handlers are registered at daemon boot with their deps already bound
 * so the dispatcher only needs to pass the action's config payload.
 * Registration is idempotent — re-registering a handler overwrites the
 * prior binding, which is what you want across hot-reloads in tests.
 *
 * Singleton-shaped: the daemon owns one registry for its lifetime.
 * Tests can call resetInternalHandlerRegistry() in beforeEach to start
 * fresh without wrestling with module state.
 */

export interface InternalHandlerContext {
  /** Arbitrary config payload from the automation step. Handler validates. */
  config: Record<string, unknown>;
}

export type InternalHandler = (ctx: InternalHandlerContext) => Promise<Record<string, unknown>>;

const handlers = new Map<string, InternalHandler>();

/** Register (or replace) an in-process tick handler under `name`. */
export function registerInternalHandler(name: string, handler: InternalHandler): void {
  handlers.set(name, handler);
}

/** Look up a previously registered handler, or undefined if none. */
export function getInternalHandler(name: string): InternalHandler | undefined {
  return handlers.get(name);
}

/** List all registered handler names — used by the dispatcher for diagnostics. */
export function listInternalHandlers(): string[] {
  return Array.from(handlers.keys()).sort();
}

/** Clear the registry. Tests only — don't call from production code. */
export function resetInternalHandlerRegistry(): void {
  handlers.clear();
}
