import { describe, it, expect } from 'vitest';
import { MeshCoordinator } from '../mesh-coordinator.js';

describe('MeshCoordinator', () => {
  const makePeer = (machineId: string, name = 'peer') => ({
    id: `id-${machineId}`,
    name,
    machineId,
    status: 'connected',
  });

  describe('isPrimary', () => {
    it('returns true for solo device', () => {
      const coord = new MeshCoordinator('aa:bb:cc');
      expect(coord.isPrimary).toBe(true);
    });

    it('returns true when this device has the lowest MAC', () => {
      const coord = new MeshCoordinator('aa:00:00');
      coord.updatePeers([makePeer('bb:00:00'), makePeer('cc:00:00')]);
      expect(coord.isPrimary).toBe(true);
    });

    it('returns false when another device has a lower MAC', () => {
      const coord = new MeshCoordinator('cc:00:00');
      coord.updatePeers([makePeer('aa:00:00')]);
      expect(coord.isPrimary).toBe(false);
    });

    it('filters out disconnected peers', () => {
      const coord = new MeshCoordinator('bb:00:00');
      coord.updatePeers([{ id: '1', name: 'p', machineId: 'aa:00:00', status: 'disconnected' }]);
      // Disconnected peer filtered out, so only self remains
      expect(coord.isPrimary).toBe(true);
    });
  });

  describe('primaryMachineId', () => {
    it('returns own ID when solo', () => {
      const coord = new MeshCoordinator('dd:ee:ff');
      expect(coord.primaryMachineId).toBe('dd:ee:ff');
    });

    it('returns lowest MAC among all devices', () => {
      const coord = new MeshCoordinator('cc:00:00');
      coord.updatePeers([makePeer('aa:00:00'), makePeer('bb:00:00')]);
      expect(coord.primaryMachineId).toBe('aa:00:00');
    });
  });

  describe('primaryPeer', () => {
    it('returns null when this device is primary', () => {
      const coord = new MeshCoordinator('aa:00:00');
      coord.updatePeers([makePeer('bb:00:00')]);
      expect(coord.primaryPeer).toBeNull();
    });

    it('returns the primary peer object when not primary', () => {
      const coord = new MeshCoordinator('cc:00:00');
      coord.updatePeers([makePeer('aa:00:00', 'leader'), makePeer('bb:00:00')]);
      const primary = coord.primaryPeer;
      expect(primary).not.toBeNull();
      expect(primary!.machineId).toBe('aa:00:00');
      expect(primary!.name).toBe('leader');
    });

    it('returns null when solo', () => {
      const coord = new MeshCoordinator('aa:00:00');
      expect(coord.primaryPeer).toBeNull();
    });
  });

  describe('deviceCount', () => {
    it('returns 1 for solo device', () => {
      const coord = new MeshCoordinator('aa:00:00');
      expect(coord.deviceCount).toBe(1);
    });

    it('returns total including self', () => {
      const coord = new MeshCoordinator('aa:00:00');
      coord.updatePeers([makePeer('bb:00:00'), makePeer('cc:00:00')]);
      expect(coord.deviceCount).toBe(3);
    });

    it('only counts connected peers', () => {
      const coord = new MeshCoordinator('aa:00:00');
      coord.updatePeers([
        makePeer('bb:00:00'),
        { id: '2', name: 'p', machineId: 'cc:00:00', status: 'disconnected' },
      ]);
      expect(coord.deviceCount).toBe(2);
    });
  });
});
