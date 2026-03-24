import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationService, type CreateAutomationInput } from '../automation-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTriggerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'auto-1',
    name: 'Test Automation',
    description: 'A test',
    source: 'ghl',
    event_type: 'contact.created',
    conditions: '{}',
    action_type: 'run_agent',
    action_config: '{}',
    actions: '[]',
    enabled: 1,
    cooldown_seconds: 60,
    last_fired_at: null,
    fire_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    webhook_token: null,
    trigger_type: 'webhook',
    trigger_config: '{"source":"ghl","event_type":"contact.created"}',
    definition: JSON.stringify({
      steps: [
        { id: 'step_1', step_type: 'run_agent', agent_id: 'a1', prompt: 'Do something' },
      ],
    }),
    variables: null,
    node_positions: null,
    sample_payload: null,
    sample_fields: null,
    status: 'active',
    ...overrides,
  };
}

function mockDb(overrides: { data?: unknown; error?: unknown } = {}) {
  const result = { data: overrides.data ?? null, error: overrides.error ?? null };
  const terminal = () => ({ ...result });
  const chain: any = {};
  for (const method of ['select', 'eq', 'neq', 'order', 'limit', 'in', 'is']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockImplementation(() => Promise.resolve(terminal()));
  chain.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(terminal()));
  chain.then = vi.fn().mockImplementation((resolve: (v: unknown) => void) => resolve(terminal()));
  chain.insert = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(terminal()),
    }),
  });
  chain.update = vi.fn().mockReturnValue(chain);

  return {
    from: vi.fn().mockReturnValue(chain),
    _chain: chain,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutomationService', () => {
  let db: ReturnType<typeof mockDb>;
  let service: AutomationService;

  beforeEach(() => {
    db = mockDb();
    service = new AutomationService(db as any, 'ws-1');
  });

  // ---- list() -------------------------------------------------------------

  describe('list()', () => {
    it('returns automations from DB, filtering out archived rows', async () => {
      const activeRow = makeTriggerRow({ id: 'auto-1', status: 'active' });
      const archivedRow = makeTriggerRow({ id: 'auto-2', status: 'archived' });

      db = mockDb({ data: [activeRow, archivedRow] });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.list();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('auto-1');
      expect(result[0].status).toBe('active');
      expect(db.from).toHaveBeenCalledWith('local_triggers');
    });

    it('returns empty array when no data', async () => {
      db = mockDb({ data: null });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.list();

      expect(result).toEqual([]);
    });
  });

  // ---- getById() ----------------------------------------------------------

  describe('getById()', () => {
    it('returns an automation for a valid id', async () => {
      const row = makeTriggerRow();
      db = mockDb({ data: row });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.getById('auto-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('auto-1');
      expect(result!.name).toBe('Test Automation');
      expect(result!.workspace_id).toBe('ws-1');
      expect(result!.enabled).toBe(true);
      expect(result!.trigger_type).toBe('webhook');
      expect(result!.steps).toHaveLength(1);
      expect(result!.steps[0].step_type).toBe('run_agent');
    });

    it('returns null when not found', async () => {
      db = mockDb({ data: null });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.getById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ---- create() -----------------------------------------------------------

  describe('create()', () => {
    it('inserts a row and returns the automation', async () => {
      const createdRow = makeTriggerRow({ id: 'new-1', name: 'New Automation' });
      db = mockDb({ data: createdRow });
      service = new AutomationService(db as any, 'ws-1');

      const input: CreateAutomationInput = {
        name: 'New Automation',
        trigger_type: 'webhook',
        trigger_config: { source: 'ghl', event_type: 'contact.created' },
        steps: [{ id: 'step_1', step_type: 'run_agent', agent_id: 'a1', prompt: 'Do it' }],
      };

      const result = await service.create(input);

      expect(result.id).toBe('new-1');
      expect(result.name).toBe('New Automation');
      expect(db.from).toHaveBeenCalledWith('local_triggers');
    });

    it('sets status to active on creation', async () => {
      const createdRow = makeTriggerRow({ status: 'active' });
      db = mockDb({ data: createdRow });
      service = new AutomationService(db as any, 'ws-1');

      const input: CreateAutomationInput = {
        name: 'Test',
        trigger_type: 'webhook',
        steps: [{ id: 'step_1', step_type: 'run_agent' }],
      };

      const result = await service.create(input);

      expect(result.status).toBe('active');

      // Verify the insert was called with status: 'active'
      const insertCall = db._chain.insert.mock.calls[0][0];
      expect(insertCall.status).toBe('active');
    });

    it('generates webhook_token for custom event type', async () => {
      const createdRow = makeTriggerRow({ event_type: 'custom', webhook_token: 'abc123' });
      db = mockDb({ data: createdRow });
      service = new AutomationService(db as any, 'ws-1');

      const input: CreateAutomationInput = {
        name: 'Custom Hook',
        trigger_type: 'webhook',
        event_type: 'custom',
        steps: [{ id: 'step_1', step_type: 'run_agent' }],
      };

      await service.create(input);

      const insertCall = db._chain.insert.mock.calls[0][0];
      expect(insertCall.webhook_token).toBeDefined();
      expect(typeof insertCall.webhook_token).toBe('string');
      expect(insertCall.webhook_token.length).toBeGreaterThan(0);
    });
  });

  // ---- update() -----------------------------------------------------------

  describe('update()', () => {
    it('updates name and returns updated automation', async () => {
      // getById is called twice: once to check existence, once to return result
      const row = makeTriggerRow({ name: 'Updated Name' });
      db = mockDb({ data: row });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.update('auto-1', { name: 'Updated Name' });

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Updated Name');
    });

    it('toggles enabled and sets status accordingly', async () => {
      const row = makeTriggerRow({ enabled: 0, status: 'paused' });
      db = mockDb({ data: row });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.update('auto-1', { enabled: false });

      expect(result).not.toBeNull();
      // Verify the update call includes the right enabled/status values
      const updateCall = db._chain.update.mock.calls[0][0];
      expect(updateCall.enabled).toBe(0);
      expect(updateCall.status).toBe('paused');
    });

    it('returns null when automation does not exist', async () => {
      db = mockDb({ data: null });
      service = new AutomationService(db as any, 'ws-1');

      const result = await service.update('nonexistent', { name: 'Nope' });

      expect(result).toBeNull();
    });
  });

  // ---- delete() -----------------------------------------------------------

  describe('delete()', () => {
    it('soft-deletes by setting status to archived and enabled to 0', async () => {
      db = mockDb();
      service = new AutomationService(db as any, 'ws-1');

      await service.delete('auto-1');

      expect(db.from).toHaveBeenCalledWith('local_triggers');
      const updateCall = db._chain.update.mock.calls[0][0];
      expect(updateCall.status).toBe('archived');
      expect(updateCall.enabled).toBe(0);
      expect(updateCall.updated_at).toBeDefined();
    });
  });
});
