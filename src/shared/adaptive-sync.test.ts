// Tests for AdaptiveSyncController - Latency compensation and sync algorithms
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AdaptiveSyncController, DEFAULT_SYNC_CONFIG } from './adaptive-sync.js';

describe('AdaptiveSyncController', () => {
  let controller: AdaptiveSyncController;

  beforeEach(() => {
    controller = new AdaptiveSyncController();
    vi.useFakeTimers();
  });

  afterEach(() => {
    controller.destroy();
    vi.useRealTimers();
  });

  describe('Latency Calculation', () => {
    it('should calculate positive latency correctly', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const eventTimestamp = now - 100; // Event sent 100ms ago
      const latency = controller.calculateLatency(eventTimestamp);

      expect(latency).toBe(100);
    });

    it('should clamp latency to max compensation', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const eventTimestamp = now - 5000; // Very old event (5s)
      const latency = controller.calculateLatency(eventTimestamp);

      expect(latency).toBeLessThanOrEqual(DEFAULT_SYNC_CONFIG.maxLatencyCompensation);
    });

    it('should handle negative latency (clock skew) and adjust offset', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Simulate remote clock ahead by 500ms
      const eventTimestamp = now + 500;
      const latency = controller.calculateLatency(eventTimestamp);

      // Should be clamped to >= 0 after adjustment
      expect(latency).toBeGreaterThanOrEqual(0);

      // Clock offset should be updated
      const stats = controller.getStats();
      expect(stats.clockOffset).toBeLessThan(0); // Negative offset to compensate
    });

    it('should track average latency', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Send multiple events with different latencies
      controller.calculateLatency(now - 50);
      controller.calculateLatency(now - 100);
      controller.calculateLatency(now - 150);

      const avgLatency = controller.getAverageLatency();
      expect(avgLatency).toBe(100); // (50 + 100 + 150) / 3
    });

    it('should return 0 for no samples', () => {
      expect(controller.getAverageLatency()).toBe(0);
    });
  });

  describe('Latency Compensation', () => {
    it('should compensate target time for playback during PLAY', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const targetTime = 10.0; // 10 seconds
      const eventTimestamp = now - 200; // 200ms latency

      const compensated = controller.compensateForLatency(targetTime, eventTimestamp, true);

      // Should add 0.2s to account for playback during transit
      expect(compensated).toBeCloseTo(10.2, 1);
    });

    it('should NOT compensate when paused', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const targetTime = 10.0;
      const eventTimestamp = now - 200;

      const compensated = controller.compensateForLatency(targetTime, eventTimestamp, false);

      // Should NOT add compensation when paused
      expect(compensated).toBe(10.0);
    });

    it('should not compensate for very small latency', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const targetTime = 10.0;
      const eventTimestamp = now - 5; // Only 5ms latency (below minLatencyCompensation)

      const compensated = controller.compensateForLatency(targetTime, eventTimestamp, true);

      expect(compensated).toBe(10.0);
    });
  });

  describe('Sync Action Calculation', () => {
    it('should return "none" for negligible drift (<30ms)', () => {
      const action = controller.calculateSyncAction(10.0, 10.02, true); // 20ms drift
      expect(action.type).toBe('none');
    });

    it('should return speed adjustment for small drift (30-300ms)', () => {
      const action = controller.calculateSyncAction(10.0, 10.15, true); // 150ms drift - we're behind

      expect(action.type).toBe('adjust_speed');
      if (action.type === 'adjust_speed') {
        expect(action.rate).toBeGreaterThan(1); // Speed up to catch up
        expect(action.rate).toBeLessThanOrEqual(1.05); // Micro adjustment
      }
    });

    it('should speed up when behind (positive drift)', () => {
      const action = controller.calculateSyncAction(10.0, 10.5, true); // 500ms behind

      expect(action.type).toBe('adjust_speed');
      if (action.type === 'adjust_speed') {
        expect(action.rate).toBeGreaterThan(1);
        expect(action.rate).toBeLessThanOrEqual(DEFAULT_SYNC_CONFIG.maxPlaybackRate);
      }
    });

    it('should slow down when ahead (negative drift)', () => {
      const action = controller.calculateSyncAction(10.5, 10.0, true); // 500ms ahead

      expect(action.type).toBe('adjust_speed');
      if (action.type === 'adjust_speed') {
        expect(action.rate).toBeLessThan(1);
        expect(action.rate).toBeGreaterThanOrEqual(DEFAULT_SYNC_CONFIG.minPlaybackRate);
      }
    });

    it('should use smooth seek for medium drift (1.5-5s)', () => {
      const action = controller.calculateSyncAction(10.0, 13.0, true); // 3s drift

      expect(action.type).toBe('smooth_seek');
      if (action.type === 'smooth_seek') {
        expect(action.targetTime).toBe(13.0);
        expect(action.duration).toBeGreaterThan(0);
        expect(action.duration).toBeLessThanOrEqual(400);
      }
    });

    it('should use hard seek for large drift (>5s)', () => {
      const action = controller.calculateSyncAction(10.0, 20.0, true); // 10s drift

      expect(action.type).toBe('hard_seek');
      if (action.type === 'hard_seek') {
        expect(action.targetTime).toBe(20.0);
      }
    });

    it('should return "none" when paused', () => {
      const action = controller.calculateSyncAction(10.0, 15.0, false); // Large drift but paused
      expect(action.type).toBe('none');
    });
  });

  describe('Compensated Sync Action', () => {
    it('should combine latency compensation with sync action', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // 10s position, target is 10.1s, 200ms latency
      // After compensation: target becomes ~10.3s
      // Drift: 300ms -> speed adjustment
      const action = controller.calculateCompensatedSyncAction(
        10.0,
        10.1,
        now - 200,
        true
      );

      // With 200ms latency + 100ms original drift = ~300ms total drift
      // This should trigger a speed adjustment
      expect(action.type).toBe('adjust_speed');
    });

    it('should not over-compensate for large latency', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const action = controller.calculateCompensatedSyncAction(
        10.0,
        10.0,
        now - 3000, // 3s "latency" - likely clock drift
        true
      );

      // Should clamp latency to maxLatencyCompensation (2s)
      // So compensation is max 2s, action should be smooth_seek or hard_seek
      expect(['smooth_seek', 'hard_seek', 'adjust_speed']).toContain(action.type);
    });
  });

  describe('Speed Adjustment', () => {
    it('should apply speed adjustment to video element', () => {
      const mockVideo = {
        playbackRate: 1.0
      } as HTMLVideoElement;

      controller.applySpeedAdjustment(mockVideo, 1.05);

      expect(mockVideo.playbackRate).toBe(1.05);
    });

    it('should reset speed after timeout', () => {
      const mockVideo = {
        playbackRate: 1.0
      } as HTMLVideoElement;

      controller.applySpeedAdjustment(mockVideo, 1.05);
      expect(mockVideo.playbackRate).toBe(1.05);

      // Fast-forward past the reset timeout
      vi.advanceTimersByTime(2500);

      expect(mockVideo.playbackRate).toBe(1.0);
    });

    it('should preserve original playback rate on reset', () => {
      const mockVideo = {
        playbackRate: 1.25 // User set 1.25x speed
      } as HTMLVideoElement;

      controller.applySpeedAdjustment(mockVideo, 1.35);
      expect(mockVideo.playbackRate).toBe(1.35);

      controller.resetSpeed(mockVideo);
      expect(mockVideo.playbackRate).toBe(1.25);
    });
  });

  describe('Smooth Seek', () => {
    it('should interpolate seek over duration', async () => {
      const mockVideo = {
        currentTime: 10.0
      } as HTMLVideoElement;

      // Use real timers for this test since it uses setInterval
      vi.useRealTimers();

      const seekPromise = controller.smoothSeek(mockVideo, 12.0, 100);

      // Wait for seek to complete
      await seekPromise;

      expect(mockVideo.currentTime).toBeCloseTo(12.0, 1);
    });
  });

  describe('Statistics', () => {
    it('should track clock offset with median filtering', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Simulate varying clock offsets
      controller.calculateLatency(now + 100); // -100 offset
      controller.calculateLatency(now + 150); // -150 offset
      controller.calculateLatency(now + 200); // -200 offset

      const stats = controller.getStats();
      // Median should be around -150
      expect(stats.clockOffset).toBeLessThan(0);
    });

    it('should reset all state', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Populate some state
      controller.calculateLatency(now - 100);
      controller.calculateLatency(now - 200);

      controller.reset();

      const stats = controller.getStats();
      expect(stats.avgLatency).toBe(0);
      expect(stats.clockOffset).toBe(0);
      expect(stats.samplesCount).toBe(0);
      expect(stats.isAdjusting).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero drift', () => {
      const action = controller.calculateSyncAction(10.0, 10.0, true);
      expect(action.type).toBe('none');
    });

    it('should handle negative time values', () => {
      // This shouldn't happen in practice, but let's be safe
      const action = controller.calculateSyncAction(-1.0, 0.0, true);
      // 1 second drift should trigger speed adjustment
      expect(action.type).toBe('adjust_speed');
    });

    it('should handle very large time values', () => {
      const action = controller.calculateSyncAction(3600, 3600.5, true); // 1 hour in
      expect(action.type).toBe('adjust_speed');
    });

    it('should handle simultaneous events', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Multiple events at exact same timestamp
      const latency1 = controller.calculateLatency(now);
      const latency2 = controller.calculateLatency(now);

      expect(latency1).toBe(0);
      expect(latency2).toBe(0);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should handle typical network latency (50-150ms)', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // Simulate receiving a PLAY event with 100ms network latency
      // Host is at 30.0s when they pressed play
      const hostTime = 30.0;
      const eventTimestamp = now - 100; // 100ms ago

      // We're currently at 29.9s (slightly behind)
      const ourTime = 29.9;

      const action = controller.calculateCompensatedSyncAction(
        ourTime,
        hostTime,
        eventTimestamp,
        true
      );

      // Compensated target: 30.0 + 0.1 = 30.1s
      // Our time: 29.9s
      // Drift: 200ms -> should trigger speed adjustment
      expect(action.type).toBe('adjust_speed');
    });

    it('should handle pause event without compensation', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // PAUSE events should use exact position, not compensate
      const pauseTime = 45.5;
      const compensated = controller.compensateForLatency(pauseTime, now - 200, false);

      expect(compensated).toBe(45.5);
    });

    it('should handle seek while playing', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // User seeks to 2:00 (120s), 150ms latency
      const seekTarget = 120.0;
      const eventTimestamp = now - 150;

      // We're currently at 45s
      const currentTime = 45.0;

      const action = controller.calculateCompensatedSyncAction(
        currentTime,
        seekTarget,
        eventTimestamp,
        true
      );

      // Large drift (75s) -> hard seek
      expect(action.type).toBe('hard_seek');
      if (action.type === 'hard_seek') {
        // Should compensate: 120 + 0.15 = 120.15s
        expect(action.targetTime).toBeCloseTo(120.15, 1);
      }
    });

    it('should handle buffering recovery (multiple PLAY events)', () => {
      const now = Date.now();
      vi.setSystemTime(now);

      // First PLAY event
      let action = controller.calculateCompensatedSyncAction(10.0, 10.1, now - 100, true);
      expect(['none', 'adjust_speed']).toContain(action.type);

      // Second PLAY event after brief buffering (we didn't move much)
      vi.setSystemTime(now + 500);
      action = controller.calculateCompensatedSyncAction(10.1, 10.6, now + 400, true);
      expect(['none', 'adjust_speed']).toContain(action.type);
    });

    it('should converge clock offset over time', () => {
      const now = Date.now();

      // Simulate receiving events from a clock that's 200ms ahead
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(now + i * 1000);
        controller.calculateLatency(now + i * 1000 + 200); // Remote clock is 200ms ahead
      }

      const stats = controller.getStats();
      // Clock offset should be around -200ms (we need to subtract to match remote)
      expect(stats.clockOffset).toBeLessThan(0);
      expect(Math.abs(stats.clockOffset + 200)).toBeLessThan(100); // Within 100ms of expected
    });
  });
});
