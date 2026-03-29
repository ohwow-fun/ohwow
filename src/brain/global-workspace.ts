/**
 * Global Workspace — Consciousness Bus (Baars)
 *
 * "Consciousness is the gateway to the brain." — Bernard Baars
 *
 * Global Workspace Theory: specialist processors (agents, tools,
 * self-improvement modules) broadcast discoveries to a shared workspace.
 * Only the most salient items enter "conscious" (attended) processing.
 *
 * In our architecture, the Global Workspace:
 * - Receives broadcasts from agents, tools, and self-improvement modules
 * - Filters by salience (attention mechanism)
 * - Provides the brain's "conscious" context for each cognitive cycle
 * - Decays salience over time (old insights fade)
 *
 * This connects the orchestrator, engine, and self-improvement subsystem
 * into a unified knowledge flow where discoveries propagate in real-time.
 */

import type { WorkspaceItem, WorkspaceFilter } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum items in the workspace (memory guard). */
const MAX_ITEMS = 200;

/** Default salience decay rate per second. */
const SALIENCE_DECAY_PER_SECOND = 0.001;

/** Items below this salience are garbage-collected. */
const SALIENCE_FLOOR = 0.05;

// ============================================================================
// GLOBAL WORKSPACE
// ============================================================================

export class GlobalWorkspace {
  private items: WorkspaceItem[] = [];
  private subscribers: Array<{ filter: WorkspaceFilter; callback: (item: WorkspaceItem) => void }> = [];

  // --------------------------------------------------------------------------
  // BROADCAST — Specialist processors publish discoveries
  // --------------------------------------------------------------------------

  /**
   * Broadcast an item to the workspace.
   * All subscribers matching the item's properties are notified.
   */
  broadcast(item: WorkspaceItem): void {
    // Enforce capacity
    if (this.items.length >= MAX_ITEMS) {
      this.gc();
      // If still full after GC, evict lowest salience
      if (this.items.length >= MAX_ITEMS) {
        this.items.sort((a, b) => a.salience - b.salience);
        this.items.shift();
      }
    }

    this.items.push(item);

    // Notify subscribers
    for (const sub of this.subscribers) {
      if (this.matchesFilter(item, sub.filter)) {
        try { sub.callback(item); } catch { /* subscriber errors are non-fatal */ }
      }
    }
  }

  // --------------------------------------------------------------------------
  // ATTEND — The brain selects what enters conscious processing
  // --------------------------------------------------------------------------

  /**
   * Get the most salient items that fit within a token budget.
   *
   * This is the attention mechanism: not everything in the workspace
   * enters conscious processing. Only the most salient items are
   * selected, up to the budget limit.
   *
   * @param budget - Maximum number of items to return
   * @param filter - Optional filter for item types/sources
   */
  getConscious(budget: number, filter?: WorkspaceFilter): WorkspaceItem[] {
    this.decaySalience();

    let candidates = this.items;

    if (filter) {
      candidates = candidates.filter(item => this.matchesFilter(item, filter));
    }

    // Sort by salience (highest first)
    candidates.sort((a, b) => b.salience - a.salience);

    return candidates.slice(0, budget);
  }

  /**
   * Get all items from a specific source.
   */
  getFromSource(source: string): WorkspaceItem[] {
    return this.items.filter(item => item.source === source);
  }

  /**
   * Get the total number of items in the workspace.
   */
  size(): number {
    return this.items.length;
  }

  // --------------------------------------------------------------------------
  // SUBSCRIBE — Real-time notification for brain modules
  // --------------------------------------------------------------------------

  /**
   * Subscribe to workspace broadcasts.
   * Returns an unsubscribe function.
   */
  subscribe(
    filter: WorkspaceFilter,
    callback: (item: WorkspaceItem) => void,
  ): () => void {
    const entry = { filter, callback };
    this.subscribers.push(entry);

    return () => {
      const idx = this.subscribers.indexOf(entry);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  // --------------------------------------------------------------------------
  // CONVENIENCE — Common broadcast patterns
  // --------------------------------------------------------------------------

  /**
   * Broadcast a tool failure discovery.
   */
  broadcastFailure(source: string, toolName: string, context: string, salience: number = 0.7): void {
    this.broadcast({
      source,
      type: 'failure',
      content: `${toolName} failed: ${context}`,
      salience,
      timestamp: Date.now(),
      metadata: { toolName, context },
    });
  }

  /**
   * Broadcast a discovered pattern from self-improvement.
   */
  broadcastPattern(source: string, pattern: string, salience: number = 0.5): void {
    this.broadcast({
      source,
      type: 'pattern',
      content: pattern,
      salience,
      timestamp: Date.now(),
    });
  }

  /**
   * Broadcast a proactive signal.
   */
  broadcastSignal(source: string, signal: string, salience: number = 0.6): void {
    this.broadcast({
      source,
      type: 'signal',
      content: signal,
      salience,
      timestamp: Date.now(),
    });
  }

  // --------------------------------------------------------------------------
  // INTERNAL
  // --------------------------------------------------------------------------

  /**
   * Decay salience of all items based on elapsed time.
   * Older items become less salient, eventually being garbage-collected.
   */
  private decaySalience(): void {
    const now = Date.now();
    for (const item of this.items) {
      const ageSeconds = (now - item.timestamp) / 1000;
      const decay = ageSeconds * SALIENCE_DECAY_PER_SECOND;
      item.salience = Math.max(0, item.salience - decay);
    }
  }

  /**
   * Garbage-collect items below the salience floor.
   */
  private gc(): void {
    this.decaySalience();
    this.items = this.items.filter(item => item.salience > SALIENCE_FLOOR);
  }

  /**
   * Check if an item matches a subscription filter.
   */
  private matchesFilter(item: WorkspaceItem, filter: WorkspaceFilter): boolean {
    if (filter.sources && !filter.sources.includes(item.source)) return false;
    if (filter.types && !filter.types.includes(item.type)) return false;
    if (filter.minSalience && item.salience < filter.minSalience) return false;
    return true;
  }
}
