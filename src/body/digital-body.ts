/**
 * Digital Body — Formalizing the Implicit Body (Merleau-Ponty)
 *
 * "The body is not an object among other objects."
 * — Maurice Merleau-Ponty, Phenomenology of Perception
 *
 * The agent's digital body already exists: browser sessions, desktop control,
 * messaging channels, MCP servers, peer connections, filesystem access.
 * These services are currently treated as "tools" but they behave as body
 * parts: persistent, stateful, always providing background awareness.
 *
 * This module formalizes them using the Adapter pattern. Each existing
 * service gets a thin organ wrapper implementing BodyPart. The services
 * themselves remain unchanged. The DigitalBody is a unified view.
 */

import type {
  BodyPart,
  Affordance,
  UmweltDimension,
  OrganHealth,
  Proprioception,
} from './types.js';

// ============================================================================
// ORGAN ADAPTERS — Wrap existing services as BodyParts
// ============================================================================

/**
 * Generic organ adapter for services with isActive() / getStatus() pattern.
 * Subclasses provide affordances and umwelt specific to each service.
 */
abstract class BaseOrgan implements BodyPart {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly domain = 'digital' as const;

  abstract isActive(): boolean;
  abstract getAffordances(): Affordance[];
  abstract getUmwelt(): UmweltDimension[];

  getHealth(): OrganHealth {
    return this.isActive() ? 'healthy' : 'dormant';
  }
}

// --------------------------------------------------------------------------
// Browser Organ — wraps LocalBrowserService
// --------------------------------------------------------------------------

/** Minimal interface we need from LocalBrowserService (avoids tight coupling). */
export interface BrowserServiceLike {
  isActive(): boolean;
}

class BrowserOrgan extends BaseOrgan {
  readonly id = 'browser';
  readonly name = 'Web Browser';

  constructor(private service: BrowserServiceLike) { super(); }

  isActive(): boolean { return this.service.isActive(); }

  getAffordances(): Affordance[] {
    if (!this.isActive()) return [];
    return [
      { action: 'navigate', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 2000, risk: 'none', prerequisites: [] },
      { action: 'click', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 500, risk: 'low', prerequisites: ['page loaded'] },
      { action: 'extract_text', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 300, risk: 'none', prerequisites: ['page loaded'] },
      { action: 'screenshot', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 500, risk: 'none', prerequisites: ['page loaded'] },
      { action: 'fill_form', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 800, risk: 'low', prerequisites: ['page loaded'] },
    ];
  }

  getUmwelt(): UmweltDimension[] {
    if (!this.isActive()) return [];
    return [
      { modality: 'web_page', organId: this.id, currentValue: null, lastUpdated: Date.now(), updateFrequencyMs: 0 },
      { modality: 'dom_tree', organId: this.id, currentValue: null, lastUpdated: Date.now(), updateFrequencyMs: 0 },
    ];
  }
}

// --------------------------------------------------------------------------
// Desktop Organ — wraps LocalDesktopService
// --------------------------------------------------------------------------

export interface DesktopServiceLike {
  isActive(): boolean;
}

class DesktopOrgan extends BaseOrgan {
  readonly id = 'desktop';
  readonly name = 'Desktop Control';

  constructor(private service: DesktopServiceLike) { super(); }

  isActive(): boolean { return this.service.isActive(); }

  getAffordances(): Affordance[] {
    if (!this.isActive()) return [];
    return [
      { action: 'click_screen', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 200, risk: 'medium', prerequisites: [] },
      { action: 'type_text', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 500, risk: 'medium', prerequisites: [] },
      { action: 'screenshot_desktop', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 300, risk: 'none', prerequisites: [] },
      { action: 'move_mouse', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 100, risk: 'low', prerequisites: [] },
    ];
  }

  getUmwelt(): UmweltDimension[] {
    if (!this.isActive()) return [];
    return [
      { modality: 'screen_state', organId: this.id, currentValue: null, lastUpdated: Date.now(), updateFrequencyMs: 0 },
      { modality: 'cursor_position', organId: this.id, currentValue: null, lastUpdated: Date.now(), updateFrequencyMs: 0 },
    ];
  }
}

// --------------------------------------------------------------------------
// Channels Organ — wraps ChannelRegistry
// --------------------------------------------------------------------------

export interface ChannelRegistryLike {
  getConnectedTypes(): string[];
}

class ChannelsOrgan extends BaseOrgan {
  readonly id = 'channels';
  readonly name = 'Messaging Channels';

  constructor(private registry: ChannelRegistryLike) { super(); }

  isActive(): boolean { return this.registry.getConnectedTypes().length > 0; }

  getAffordances(): Affordance[] {
    const types = this.registry.getConnectedTypes();
    return types.map(type => ({
      action: `send_${type}_message`,
      organId: this.id,
      domain: 'digital' as const,
      readiness: 1,
      estimatedLatencyMs: 1000,
      risk: 'medium' as const,
      prerequisites: [`${type} connected`],
    }));
  }

  getUmwelt(): UmweltDimension[] {
    const types = this.registry.getConnectedTypes();
    return types.map(type => ({
      modality: `${type}_messages`,
      organId: this.id,
      currentValue: null,
      lastUpdated: Date.now(),
      updateFrequencyMs: 0,
    }));
  }
}

// --------------------------------------------------------------------------
// MCP Organ — wraps McpClientManager
// --------------------------------------------------------------------------

export interface McpManagerLike {
  getToolDefinitions(): Array<{ name: string; description?: string }>;
  hasTools(): boolean;
}

class McpOrgan extends BaseOrgan {
  readonly id = 'mcp';
  readonly name = 'MCP Servers';

  constructor(private manager: McpManagerLike) { super(); }

  isActive(): boolean { return this.manager.hasTools(); }

  getAffordances(): Affordance[] {
    if (!this.isActive()) return [];
    return this.manager.getToolDefinitions().map(tool => ({
      action: tool.name,
      organId: this.id,
      domain: 'digital' as const,
      readiness: 1,
      estimatedLatencyMs: 2000,
      risk: 'low' as const,
      prerequisites: ['mcp server connected'],
    }));
  }

  getUmwelt(): UmweltDimension[] {
    return [
      { modality: 'mcp_capabilities', organId: this.id, currentValue: this.manager.getToolDefinitions().length, lastUpdated: Date.now(), updateFrequencyMs: 15000 },
    ];
  }
}

// --------------------------------------------------------------------------
// Filesystem Organ — always available
// --------------------------------------------------------------------------

class FilesystemOrgan extends BaseOrgan {
  readonly id = 'filesystem';
  readonly name = 'Filesystem';

  private workingDirectory: string | undefined;

  constructor(workingDirectory?: string) {
    super();
    this.workingDirectory = workingDirectory;
  }

  isActive(): boolean { return true; } // always available

  getAffordances(): Affordance[] {
    const base: Affordance[] = [
      { action: 'read_file', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 10, risk: 'none', prerequisites: [] },
      { action: 'write_file', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 20, risk: 'medium', prerequisites: [] },
      { action: 'search_files', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 100, risk: 'none', prerequisites: [] },
    ];
    if (this.workingDirectory) {
      base.push({ action: 'list_directory', organId: this.id, domain: 'digital', readiness: 1, estimatedLatencyMs: 10, risk: 'none', prerequisites: [] });
    }
    return base;
  }

  getUmwelt(): UmweltDimension[] {
    return [
      { modality: 'file_tree', organId: this.id, currentValue: this.workingDirectory ?? '/', lastUpdated: Date.now(), updateFrequencyMs: 60000 },
    ];
  }
}

// --------------------------------------------------------------------------
// Voice Organ — wraps the voice pipeline (Auditory Modality)
// --------------------------------------------------------------------------

/**
 * Minimal interface for voice pipeline state.
 * "A WhatsApp connection is a voice. A microphone is an ear."
 * — Body README
 */
export interface VoiceServiceLike {
  isActive(): boolean;
  getState(): 'idle' | 'listening' | 'processing' | 'speaking';
  getSttProvider(): string | null;
  getTtsProvider(): string | null;
}

class VoiceOrgan extends BaseOrgan {
  readonly id = 'voice';
  readonly name = 'Voice Pipeline';

  constructor(private service: VoiceServiceLike) { super(); }

  isActive(): boolean { return this.service.isActive(); }

  getHealth(): OrganHealth {
    if (!this.service.isActive()) return 'dormant';
    const hasStt = !!this.service.getSttProvider();
    const hasTts = !!this.service.getTtsProvider();
    if (hasStt && hasTts) return 'healthy';
    if (hasStt || hasTts) return 'degraded';
    return 'failed';
  }

  getAffordances(): Affordance[] {
    const hasStt = !!this.service.getSttProvider();
    const hasTts = !!this.service.getTtsProvider();

    const affordances: Affordance[] = [];

    if (hasStt) {
      affordances.push(
        { action: 'listen', organId: this.id, domain: 'digital', readiness: this.service.getState() === 'idle' ? 1 : 0.3, estimatedLatencyMs: 500, risk: 'none', prerequisites: [] },
        { action: 'transcribe', organId: this.id, domain: 'digital', readiness: hasStt ? 0.9 : 0, estimatedLatencyMs: 2000, risk: 'none', prerequisites: ['audio_input'] },
      );
    }

    if (hasTts) {
      affordances.push(
        { action: 'speak', organId: this.id, domain: 'digital', readiness: this.service.getState() === 'idle' ? 1 : 0.3, estimatedLatencyMs: 300, risk: 'none', prerequisites: [] },
        { action: 'synthesize', organId: this.id, domain: 'digital', readiness: hasTts ? 0.9 : 0, estimatedLatencyMs: 1000, risk: 'none', prerequisites: ['text_input'] },
      );
    }

    return affordances;
  }

  getUmwelt(): UmweltDimension[] {
    return [
      { modality: 'acoustic_input', organId: this.id, currentValue: this.service.getState(), lastUpdated: Date.now(), updateFrequencyMs: 2000 },
      { modality: 'speech_output', organId: this.id, currentValue: { stt: this.service.getSttProvider(), tts: this.service.getTtsProvider() }, lastUpdated: Date.now(), updateFrequencyMs: 10000 },
    ];
  }
}

// ============================================================================
// DIGITAL BODY — Unified organ collection
// ============================================================================

/** Options for constructing the digital body from existing services. */
export interface DigitalBodyOptions {
  browser?: BrowserServiceLike;
  desktop?: DesktopServiceLike;
  channels?: ChannelRegistryLike;
  mcp?: McpManagerLike;
  workingDirectory?: string;
  voice?: VoiceServiceLike;
}

/**
 * The agent's digital body: a unified view of all digital organs.
 *
 * Construct it by passing existing services. Each becomes an organ.
 * Zero services = empty body (backward compatible).
 */
export class DigitalBody {
  private organs: Map<string, BodyPart> = new Map();

  constructor(options?: DigitalBodyOptions) {
    // Always have filesystem
    this.organs.set('filesystem', new FilesystemOrgan(options?.workingDirectory));

    // Wrap optional services as organs
    if (options?.browser) this.organs.set('browser', new BrowserOrgan(options.browser));
    if (options?.desktop) this.organs.set('desktop', new DesktopOrgan(options.desktop));
    if (options?.channels) this.organs.set('channels', new ChannelsOrgan(options.channels));
    if (options?.mcp) this.organs.set('mcp', new McpOrgan(options.mcp));
    if (options?.voice) this.organs.set('voice', new VoiceOrgan(options.voice));
  }

  /** Get all organs. */
  getOrgans(): BodyPart[] {
    return Array.from(this.organs.values());
  }

  /** Get a specific organ by ID. */
  getOrgan(id: string): BodyPart | undefined {
    return this.organs.get(id);
  }

  /** Add or replace an organ (e.g., when browser activates mid-session). */
  setOrgan(id: string, organ: BodyPart): void {
    this.organs.set(id, organ);
  }

  /** Remove an organ (e.g., when a service disconnects). */
  removeOrgan(id: string): void {
    this.organs.delete(id);
  }

  /** Get all affordances across all organs. */
  getAllAffordances(): Affordance[] {
    const affordances: Affordance[] = [];
    for (const organ of this.organs.values()) {
      if (organ.isActive()) {
        affordances.push(...organ.getAffordances());
      }
    }
    return affordances;
  }

  /** Get the combined Umwelt across all organs. */
  getUmwelt(): UmweltDimension[] {
    const dimensions: UmweltDimension[] = [];
    for (const organ of this.organs.values()) {
      if (organ.isActive()) {
        dimensions.push(...organ.getUmwelt());
      }
    }
    return dimensions;
  }

  /** Build a proprioceptive snapshot (Merleau-Ponty's body schema). */
  getProprioception(): Proprioception {
    return {
      organs: Array.from(this.organs.values()).map(o => ({
        id: o.id,
        name: o.name,
        domain: o.domain,
        health: o.getHealth(),
      })),
      affordances: this.getAllAffordances(),
      umwelt: this.getUmwelt(),
      resources: {},
      timestamp: Date.now(),
    };
  }
}

// ============================================================================
// FACTORY — Create organ adapters from service-like interfaces
// ============================================================================

/** Create a BrowserOrgan from any service with isActive(). */
export function createBrowserOrgan(service: BrowserServiceLike): BodyPart {
  return new BrowserOrgan(service);
}

/** Create a DesktopOrgan from any service with isActive(). */
export function createDesktopOrgan(service: DesktopServiceLike): BodyPart {
  return new DesktopOrgan(service);
}

/** Create a ChannelsOrgan from any registry with getConnectedTypes(). */
export function createChannelsOrgan(registry: ChannelRegistryLike): BodyPart {
  return new ChannelsOrgan(registry);
}

/** Create an McpOrgan from any manager with getToolDefinitions(). */
export function createMcpOrgan(manager: McpManagerLike): BodyPart {
  return new McpOrgan(manager);
}

/** Create a VoiceOrgan from any service implementing VoiceServiceLike. */
export function createVoiceOrgan(service: VoiceServiceLike): BodyPart {
  return new VoiceOrgan(service);
}
