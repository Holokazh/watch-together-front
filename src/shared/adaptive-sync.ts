// Adaptive Sync - Smooth synchronization with latency compensation
// Uses playback rate adjustments for small drifts and compensates for network latency

export interface AdaptiveSyncConfig {
  // Thresholds in milliseconds
  smallDriftThreshold: number;   // Below this: adjust playback speed
  mediumDriftThreshold: number;  // Below this: smooth seek
  largeDriftThreshold: number;   // Above this: hard seek

  // Speed adjustment bounds
  minPlaybackRate: number;
  maxPlaybackRate: number;

  // How quickly to adjust (0-1, higher = faster correction)
  correctionFactor: number;

  // Latency compensation settings
  maxLatencyCompensation: number;  // Max ms to compensate (ignore if higher)
  minLatencyCompensation: number;  // Min ms to apply compensation (ignore smaller)
}

export const DEFAULT_SYNC_CONFIG: AdaptiveSyncConfig = {
  smallDriftThreshold: 300,     // 0.3s - use speed adjustment (tightened)
  mediumDriftThreshold: 1500,   // 1.5s - smooth interpolated seek
  largeDriftThreshold: 5000,    // 5s - hard seek

  minPlaybackRate: 0.9,
  maxPlaybackRate: 1.1,
  correctionFactor: 0.4,        // Slightly faster correction

  maxLatencyCompensation: 2000, // Don't compensate more than 2s (likely clock drift)
  minLatencyCompensation: 10    // Ignore latency below 10ms
};

export type SyncAction =
  | { type: 'none' }
  | { type: 'adjust_speed'; rate: number }
  | { type: 'smooth_seek'; targetTime: number; duration: number }
  | { type: 'hard_seek'; targetTime: number };

export class AdaptiveSyncController {
  private config: AdaptiveSyncConfig;
  private originalPlaybackRate: number = 1.0;
  private isAdjustingSpeed: boolean = false;
  private speedResetTimeout: ReturnType<typeof setTimeout> | null = null;
  private smoothSeekInterval: ReturnType<typeof setInterval> | null = null;

  // Clock offset estimation (difference between local and remote clocks)
  private clockOffset: number = 0;
  private clockOffsetSamples: number[] = [];
  private readonly maxClockSamples: number = 10;

  // Latency tracking for statistics
  private latencySamples: number[] = [];
  private readonly maxLatencySamples: number = 20;

  constructor(config: Partial<AdaptiveSyncConfig> = {}) {
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  /**
   * Calculate network latency from event timestamp
   * Returns the estimated one-way latency in milliseconds
   */
  calculateLatency(eventTimestamp: number): number {
    const now = Date.now();
    const rawLatency = now - eventTimestamp;

    // Handle clock skew: if latency is negative, clocks are out of sync
    // We'll use this to estimate clock offset
    if (rawLatency < -100) {
      // Remote clock is ahead of ours
      this.updateClockOffset(rawLatency);
    } else if (rawLatency > this.config.maxLatencyCompensation) {
      // Either network is very slow or remote clock is behind
      // Could be legitimate high latency or clock drift
      this.updateClockOffset(rawLatency - 200); // Assume ~200ms baseline latency
    }

    // Adjust latency by clock offset
    const adjustedLatency = rawLatency - this.clockOffset;

    // Clamp to reasonable bounds
    const clampedLatency = Math.max(0, Math.min(adjustedLatency, this.config.maxLatencyCompensation));

    // Track for statistics
    this.recordLatency(clampedLatency);

    return clampedLatency;
  }

  /**
   * Update clock offset estimation using median filtering
   */
  private updateClockOffset(sample: number): void {
    this.clockOffsetSamples.push(sample);
    if (this.clockOffsetSamples.length > this.maxClockSamples) {
      this.clockOffsetSamples.shift();
    }

    // Use median for robustness against outliers
    const sorted = [...this.clockOffsetSamples].sort((a, b) => a - b);
    this.clockOffset = sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * Record latency sample for statistics
   */
  private recordLatency(latency: number): void {
    this.latencySamples.push(latency);
    if (this.latencySamples.length > this.maxLatencySamples) {
      this.latencySamples.shift();
    }
  }

  /**
   * Get average latency from recent samples
   */
  getAverageLatency(): number {
    if (this.latencySamples.length === 0) return 0;
    const sum = this.latencySamples.reduce((a, b) => a + b, 0);
    return sum / this.latencySamples.length;
  }

  /**
   * Compensate target time for network latency
   * For PLAY events during playback, we need to account for how much time
   * has passed since the event was sent
   */
  compensateForLatency(targetTime: number, eventTimestamp: number, isPlaying: boolean): number {
    const latency = this.calculateLatency(eventTimestamp);

    // Only compensate if latency is significant and we're playing
    if (latency < this.config.minLatencyCompensation || !isPlaying) {
      return targetTime;
    }

    // Add latency (in seconds) to target time
    // This accounts for how much the video has progressed since the event was sent
    const compensation = latency / 1000;
    const compensatedTime = targetTime + compensation;

    console.log(`[AdaptiveSync] Latency: ${latency.toFixed(0)}ms, compensation: +${compensation.toFixed(3)}s`);

    return compensatedTime;
  }

  /**
   * Calculate what sync action to take based on current drift
   * Now with latency compensation support
   */
  calculateSyncAction(currentTime: number, targetTime: number, isPlaying: boolean): SyncAction {
    const drift = targetTime - currentTime; // Positive = we're behind, negative = we're ahead
    const absDrift = Math.abs(drift) * 1000; // Convert to ms

    // If paused or drift is negligible, do nothing
    if (!isPlaying || absDrift < 30) {  // Tightened threshold to 30ms
      return { type: 'none' };
    }

    // Large drift: hard seek
    if (absDrift > this.config.largeDriftThreshold) {
      return { type: 'hard_seek', targetTime };
    }

    // Medium drift: smooth seek over a short duration
    if (absDrift > this.config.mediumDriftThreshold) {
      return {
        type: 'smooth_seek',
        targetTime,
        duration: Math.min(400, absDrift / 4) // Slightly faster seek
      };
    }

    // Small drift: adjust playback speed
    if (absDrift > this.config.smallDriftThreshold) {
      // Calculate speed adjustment - more aggressive for larger drifts
      let rate: number;
      if (drift > 0) {
        // We're behind - speed up
        rate = Math.min(
          this.config.maxPlaybackRate,
          1 + (absDrift / 1000) * this.config.correctionFactor
        );
      } else {
        // We're ahead - slow down
        rate = Math.max(
          this.config.minPlaybackRate,
          1 - (absDrift / 1000) * this.config.correctionFactor
        );
      }
      return { type: 'adjust_speed', rate };
    }

    // Very small drift (30-300ms): micro speed adjustment
    // This provides fine-grained correction without noticeable speed changes
    const microRate = drift > 0
      ? Math.min(1.05, 1 + (absDrift / 1000) * 0.15)  // Subtle speed up
      : Math.max(0.95, 1 - (absDrift / 1000) * 0.15); // Subtle slow down

    return { type: 'adjust_speed', rate: microRate };
  }

  /**
   * Combined method: compensate for latency and calculate sync action
   * This is the main entry point for sync operations
   */
  calculateCompensatedSyncAction(
    currentTime: number,
    targetTime: number,
    eventTimestamp: number,
    isPlaying: boolean
  ): SyncAction {
    const compensatedTarget = this.compensateForLatency(targetTime, eventTimestamp, isPlaying);
    return this.calculateSyncAction(currentTime, compensatedTarget, isPlaying);
  }

  /**
   * Apply speed adjustment to video element
   */
  applySpeedAdjustment(video: HTMLVideoElement, rate: number): void {
    if (!this.isAdjustingSpeed) {
      this.originalPlaybackRate = video.playbackRate;
      this.isAdjustingSpeed = true;
    }

    video.playbackRate = rate;

    // Clear existing reset timeout
    if (this.speedResetTimeout) {
      clearTimeout(this.speedResetTimeout);
    }

    // Reset speed after a period (we'll recalculate on next sync event)
    this.speedResetTimeout = setTimeout(() => {
      this.resetSpeed(video);
    }, 2000);
  }

  /**
   * Reset playback speed to normal
   */
  resetSpeed(video: HTMLVideoElement): void {
    if (this.isAdjustingSpeed) {
      video.playbackRate = this.originalPlaybackRate;
      this.isAdjustingSpeed = false;
    }
    if (this.speedResetTimeout) {
      clearTimeout(this.speedResetTimeout);
      this.speedResetTimeout = null;
    }
  }

  /**
   * Perform a smooth seek (interpolated over duration)
   */
  smoothSeek(video: HTMLVideoElement, targetTime: number, duration: number): Promise<void> {
    return new Promise((resolve) => {
      // Clear any existing smooth seek
      if (this.smoothSeekInterval) {
        clearInterval(this.smoothSeekInterval);
      }

      const startTime = video.currentTime;
      const startTs = performance.now();
      const diff = targetTime - startTime;

      this.smoothSeekInterval = setInterval(() => {
        const elapsed = performance.now() - startTs;
        const progress = Math.min(1, elapsed / duration);

        // Use easeOutQuad for smooth deceleration
        const eased = 1 - (1 - progress) * (1 - progress);

        video.currentTime = startTime + diff * eased;

        if (progress >= 1) {
          if (this.smoothSeekInterval) {
            clearInterval(this.smoothSeekInterval);
            this.smoothSeekInterval = null;
          }
          resolve();
        }
      }, 16); // ~60fps

      // Safety timeout
      setTimeout(() => {
        if (this.smoothSeekInterval) {
          clearInterval(this.smoothSeekInterval);
          this.smoothSeekInterval = null;
          video.currentTime = targetTime;
          resolve();
        }
      }, duration + 100);
    });
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.speedResetTimeout) {
      clearTimeout(this.speedResetTimeout);
      this.speedResetTimeout = null;
    }
    if (this.smoothSeekInterval) {
      clearInterval(this.smoothSeekInterval);
      this.smoothSeekInterval = null;
    }
  }

  /**
   * Reset all state (useful for testing or session reset)
   */
  reset(): void {
    this.destroy();
    this.clockOffset = 0;
    this.clockOffsetSamples = [];
    this.latencySamples = [];
    this.isAdjustingSpeed = false;
    this.originalPlaybackRate = 1.0;
  }

  /**
   * Get sync statistics for debugging
   */
  getStats(): {
    avgLatency: number;
    clockOffset: number;
    isAdjusting: boolean;
    samplesCount: number;
  } {
    return {
      avgLatency: this.getAverageLatency(),
      clockOffset: this.clockOffset,
      isAdjusting: this.isAdjustingSpeed,
      samplesCount: this.latencySamples.length
    };
  }
}
