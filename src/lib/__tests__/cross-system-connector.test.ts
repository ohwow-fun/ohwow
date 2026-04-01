import { describe, it, expect, vi, beforeEach } from 'vitest';
import { connectSystems, type CrossSystemDeps } from '../cross-system-connector.js';
import { GlobalWorkspace } from '../../brain/global-workspace.js';
import type { WorkspaceItem } from '../../brain/types.js';

// ---------------------------------------------------------------------------
// Helpers: minimal mocks for each system
// ---------------------------------------------------------------------------

function mockEndocrine() {
  return {
    stimulate: vi.fn(),
    tick: vi.fn(),
    getProfile: vi.fn(),
    getLevel: vi.fn(),
  };
}

function mockNarrative() {
  return {
    recordEvent: vi.fn().mockResolvedValue({ id: 'ep1' }),
    getState: vi.fn(),
  };
}

function broadcastAffect(
  workspace: GlobalWorkspace,
  affectType: string,
  intensity: number,
  salience = 0.7,
) {
  workspace.broadcast({
    source: 'affect-engine',
    type: 'affect' as WorkspaceItem['type'],
    content: `${affectType} at ${intensity}`,
    salience,
    timestamp: Date.now(),
    metadata: { affectType, intensity },
  });
}

function broadcastImmune(
  workspace: GlobalWorkspace,
  alertLevel: string,
  salience = 0.7,
) {
  workspace.broadcast({
    source: 'immune-system',
    type: 'immune' as WorkspaceItem['type'],
    content: `immune alert: ${alertLevel}`,
    salience,
    timestamp: Date.now(),
    metadata: { alertLevel },
  });
}

function broadcastHomeostasisWarning(
  workspace: GlobalWorkspace,
  deviation: number,
  salience = 0.5,
) {
  workspace.broadcast({
    source: 'homeostasis-controller',
    type: 'warning',
    content: `homeostasis deviation ${deviation}`,
    salience,
    timestamp: Date.now(),
    metadata: { deviation },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('connectSystems', () => {
  let workspace: GlobalWorkspace;

  beforeEach(() => {
    workspace = new GlobalWorkspace();
  });

  // ---- Affect -> Endocrine ----

  it('frustration (intensity > 0.6) triggers cortisol', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'frustration', 0.8);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'cortisol', delta: 0.15, source: 'affect' }),
    );
  });

  it('frustration below threshold does not trigger cortisol', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'frustration', 0.4);

    expect(endocrine.stimulate).not.toHaveBeenCalled();
  });

  it('anxiety triggers cortisol + adrenaline', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'anxiety', 0.7);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'cortisol', delta: 0.2 }),
    );
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'adrenaline', delta: 0.1 }),
    );
  });

  it('satisfaction triggers dopamine', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'satisfaction', 0.6);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'dopamine', delta: 0.1, source: 'affect' }),
    );
  });

  it('pride triggers dopamine + serotonin', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'pride', 0.7);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'dopamine', delta: 0.15 }),
    );
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'serotonin', delta: 0.05 }),
    );
  });

  it('excitement triggers adrenaline + dopamine', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastAffect(workspace, 'excitement', 0.8);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'adrenaline', delta: 0.15 }),
    );
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'dopamine', delta: 0.1 }),
    );
  });

  // ---- Immune -> Endocrine ----

  it('immune threat triggers cortisol + adrenaline', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      immune: {} as CrossSystemDeps['immune'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastImmune(workspace, 'elevated');

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'cortisol', delta: 0.2, source: 'immune' }),
    );
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'adrenaline', delta: 0.15 }),
    );
  });

  it('immune quarantine triggers higher cortisol', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      immune: {} as CrossSystemDeps['immune'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastImmune(workspace, 'quarantine');

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'cortisol', delta: 0.3 }),
    );
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'adrenaline', delta: 0.2 }),
    );
  });

  // ---- Homeostasis -> Endocrine ----

  it('homeostasis deviation > 0.5 triggers cortisol', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      homeostasis: {} as CrossSystemDeps['homeostasis'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastHomeostasisWarning(workspace, 0.7);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'cortisol', delta: 0.1, source: 'homeostasis' }),
    );
  });

  it('homeostasis deviation < 0.2 triggers serotonin (recovery)', () => {
    const endocrine = mockEndocrine();
    connectSystems({
      workspace,
      homeostasis: {} as CrossSystemDeps['homeostasis'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    broadcastHomeostasisWarning(workspace, 0.1);

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'serotonin', delta: 0.1, source: 'homeostasis' }),
    );
  });

  // ---- Affect -> Narrative ----

  it('high-affect events create narrative events', () => {
    const narrative = mockNarrative();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      narrative: narrative as unknown as CrossSystemDeps['narrative'],
    });

    broadcastAffect(workspace, 'triumph', 0.9);

    expect(narrative.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        significance: 0.9,
        affect: 'triumph',
      }),
    );
  });

  it('moderate affect does not create narrative events', () => {
    const narrative = mockNarrative();
    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      narrative: narrative as unknown as CrossSystemDeps['narrative'],
    });

    broadcastAffect(workspace, 'curiosity', 0.5);

    expect(narrative.recordEvent).not.toHaveBeenCalled();
  });

  // ---- Growth patterns -> Narrative ----

  it('growth transition patterns create narrative events', () => {
    const narrative = mockNarrative();
    connectSystems({
      workspace,
      narrative: narrative as unknown as CrossSystemDeps['narrative'],
    });

    workspace.broadcast({
      source: 'self-improvement',
      type: 'pattern',
      content: 'Growth stage transition: novice -> competent',
      salience: 0.6,
      timestamp: Date.now(),
    });

    expect(narrative.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Growth transition'),
        significance: 0.8,
      }),
    );
  });

  // ---- Unsubscribe ----

  it('unsubscribe cleans up all subscriptions', () => {
    const endocrine = mockEndocrine();
    const narrative = mockNarrative();

    const disconnect = connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
      immune: {} as CrossSystemDeps['immune'],
      homeostasis: {} as CrossSystemDeps['homeostasis'],
      narrative: narrative as unknown as CrossSystemDeps['narrative'],
    });

    disconnect();

    // After disconnect, new broadcasts should not trigger handlers
    broadcastAffect(workspace, 'frustration', 0.9);
    broadcastImmune(workspace, 'quarantine');

    expect(endocrine.stimulate).not.toHaveBeenCalled();
    expect(narrative.recordEvent).not.toHaveBeenCalled();
  });

  // ---- Missing dependencies ----

  it('handles missing dependencies gracefully', () => {
    // Only workspace provided, no optional systems
    const disconnect = connectSystems({ workspace });

    // Should not throw
    workspace.broadcast({
      source: 'affect-engine',
      type: 'affect' as WorkspaceItem['type'],
      content: 'frustration at 0.9',
      salience: 0.8,
      timestamp: Date.now(),
      metadata: { affectType: 'frustration', intensity: 0.9 },
    });

    disconnect();
  });

  it('wires affect->endocrine without narrative when narrative is missing', () => {
    const endocrine = mockEndocrine();

    connectSystems({
      workspace,
      affect: {} as CrossSystemDeps['affect'],
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
      // no narrative
    });

    broadcastAffect(workspace, 'satisfaction', 0.8);

    // Endocrine should still work
    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'dopamine', delta: 0.1 }),
    );
  });

  // ---- Collaboration -> Oxytocin ----

  it('peer discovery triggers oxytocin', () => {
    const endocrine = mockEndocrine();

    connectSystems({
      workspace,
      endocrine: endocrine as unknown as CrossSystemDeps['endocrine'],
    });

    workspace.broadcast({
      source: 'peer-agent',
      type: 'discovery',
      content: 'discovered shared pattern',
      salience: 0.6,
      timestamp: Date.now(),
    });

    expect(endocrine.stimulate).toHaveBeenCalledWith(
      expect.objectContaining({ hormone: 'oxytocin', delta: 0.1 }),
    );
  });
});
