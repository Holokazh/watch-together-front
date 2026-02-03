// Unified PlayerAdapter interface for all streaming platforms
// Each platform must implement this interface to enable synchronization

export interface PlayerAdapter {
  // Playback controls
  play(): void;
  pause(): void;
  seek(time: number): void;

  // State getters
  getCurrentTime(): number;
  isPlaying(): boolean;
  getDuration(): number;

  // Event listeners - callbacks receive current time
  onPlay(cb: (time: number) => void): void;
  onPause(cb: (time: number) => void): void;
  onSeek(cb: (time: number) => void): void;

  // Health check - returns true if adapter is still functional
  isValid(): boolean;

  // Cleanup
  destroy(): void;
}

// Event origin tracking to prevent infinite sync loops
export enum EventOrigin {
  LOCAL = 'LOCAL',   // User interaction on this client
  REMOTE = 'REMOTE', // Sync event from another client
}

// Adapter health status for monitoring
export interface AdapterHealth {
  valid: boolean;
  hasVideo: boolean;
  canPlay: boolean;
  lastCheck: number;
}

// Recovery callback type
export type RecoveryCallback = () => void;

// Base class with common functionality for all adapters
export abstract class BasePlayerAdapter implements PlayerAdapter {
  protected videoElement: HTMLVideoElement | null = null;
  protected playCallbacks: Array<(time: number) => void> = [];
  protected pauseCallbacks: Array<(time: number) => void> = [];
  protected seekCallbacks: Array<(time: number) => void> = [];
  protected recoveryCallbacks: RecoveryCallback[] = [];
  protected lastSeekTime: number = 0;
  protected eventOrigin: EventOrigin = EventOrigin.LOCAL;
  protected isDestroyed: boolean = false;
  protected healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  protected recoveryAttempts: number = 0;
  protected readonly maxRecoveryAttempts: number = 5;

  // Bound event handlers for cleanup
  protected boundPlayHandler: () => void;
  protected boundPauseHandler: () => void;
  protected boundSeekedHandler: () => void;
  protected boundErrorHandler: (e: Event) => void;
  protected boundEmptiedHandler: () => void;

  // Health monitoring
  protected lastHealthStatus: AdapterHealth = {
    valid: false,
    hasVideo: false,
    canPlay: false,
    lastCheck: 0
  };

  constructor() {
    this.boundPlayHandler = this.handlePlay.bind(this);
    this.boundPauseHandler = this.handlePause.bind(this);
    this.boundSeekedHandler = this.handleSeeked.bind(this);
    this.boundErrorHandler = this.handleError.bind(this);
    this.boundEmptiedHandler = this.handleEmptied.bind(this);
  }

  // Abstract methods each platform must implement
  protected abstract findVideoElement(): HTMLVideoElement | null;
  protected abstract setupPlatformSpecificListeners(): void;
  protected abstract cleanupPlatformSpecificListeners(): void;
  protected abstract getPlatformName(): string;

  // Get raw video element for advanced operations (like adaptive sync)
  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  // Initialize the adapter - call after construction
  public async initialize(): Promise<boolean> {
    this.videoElement = this.findVideoElement();
    if (!this.videoElement) {
      console.warn(`[WatchTogether:${this.getPlatformName()}] Video element not found`);
      return false;
    }

    this.setupEventListeners();
    this.setupPlatformSpecificListeners();
    this.startHealthCheck();
    this.recoveryAttempts = 0;

    console.log(`[WatchTogether:${this.getPlatformName()}] Player adapter initialized`);
    return true;
  }

  protected setupEventListeners(): void {
    if (!this.videoElement) return;

    this.videoElement.addEventListener('play', this.boundPlayHandler);
    this.videoElement.addEventListener('pause', this.boundPauseHandler);
    this.videoElement.addEventListener('seeked', this.boundSeekedHandler);
    this.videoElement.addEventListener('error', this.boundErrorHandler);
    this.videoElement.addEventListener('emptied', this.boundEmptiedHandler);
  }

  protected handlePlay(): void {
    if (this.isDestroyed || this.eventOrigin === EventOrigin.REMOTE) return;
    const time = this.getCurrentTime();
    this.playCallbacks.forEach(cb => cb(time));
  }

  protected handlePause(): void {
    if (this.isDestroyed || this.eventOrigin === EventOrigin.REMOTE) return;
    const time = this.getCurrentTime();
    this.pauseCallbacks.forEach(cb => cb(time));
  }

  protected handleSeeked(): void {
    if (this.isDestroyed || this.eventOrigin === EventOrigin.REMOTE) return;
    const time = this.getCurrentTime();
    // Debounce seek events - ignore if within 100ms of last seek
    const now = Date.now();
    if (now - this.lastSeekTime < 100) return;
    this.lastSeekTime = now;
    this.seekCallbacks.forEach(cb => cb(time));
  }

  protected handleError(e: Event): void {
    const target = e.target as HTMLVideoElement;
    const error = target?.error;
    console.warn(`[WatchTogether:${this.getPlatformName()}] Video error:`, error?.message || 'Unknown error');

    // Don't recover on MEDIA_ERR_ABORTED (user cancelled) or MEDIA_ERR_DECODE (usually temporary)
    if (error && error.code !== MediaError.MEDIA_ERR_ABORTED) {
      this.attemptRecovery('video_error');
    }
  }

  protected handleEmptied(): void {
    // Video source was removed - likely player is being swapped
    console.log(`[WatchTogether:${this.getPlatformName()}] Video emptied, will attempt rebind`);
    this.attemptRecovery('video_emptied');
  }

  // Attempt to recover from errors by re-binding to video
  protected async attemptRecovery(reason: string): Promise<boolean> {
    if (this.isDestroyed) return false;
    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      console.error(`[WatchTogether:${this.getPlatformName()}] Max recovery attempts reached`);
      return false;
    }

    this.recoveryAttempts++;
    console.log(`[WatchTogether:${this.getPlatformName()}] Recovery attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts} (reason: ${reason})`);

    // Remove old listeners
    this.removeVideoListeners();

    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
    const delay = Math.min(500 * Math.pow(2, this.recoveryAttempts - 1), 8000);
    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.isDestroyed) return false;

    // Try to find video again
    const newVideo = this.findVideoElement();
    if (newVideo) {
      this.videoElement = newVideo;
      this.setupEventListeners();
      this.recoveryAttempts = 0; // Reset on success
      console.log(`[WatchTogether:${this.getPlatformName()}] Recovery successful - rebound to video`);

      // Notify recovery listeners
      this.recoveryCallbacks.forEach(cb => cb());
      return true;
    }

    console.warn(`[WatchTogether:${this.getPlatformName()}] Recovery attempt ${this.recoveryAttempts} failed`);

    // Schedule another attempt if we haven't maxed out
    if (this.recoveryAttempts < this.maxRecoveryAttempts) {
      setTimeout(() => this.attemptRecovery('retry'), 1000);
    }

    return false;
  }

  protected removeVideoListeners(): void {
    if (this.videoElement) {
      this.videoElement.removeEventListener('play', this.boundPlayHandler);
      this.videoElement.removeEventListener('pause', this.boundPauseHandler);
      this.videoElement.removeEventListener('seeked', this.boundSeekedHandler);
      this.videoElement.removeEventListener('error', this.boundErrorHandler);
      this.videoElement.removeEventListener('emptied', this.boundEmptiedHandler);
    }
  }

  // Register callback for when recovery succeeds
  public onRecovery(cb: RecoveryCallback): void {
    this.recoveryCallbacks.push(cb);
  }

  // Periodic health check to detect broken state
  protected startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth();
    }, 5000); // Check every 5 seconds
  }

  protected stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  protected checkHealth(): void {
    const health: AdapterHealth = {
      valid: this.isValid(),
      hasVideo: this.videoElement !== null,
      canPlay: this.videoElement?.readyState !== undefined && this.videoElement.readyState >= 1,
      lastCheck: Date.now()
    };

    // If we had a valid adapter but now it's broken, try recovery
    if (this.lastHealthStatus.valid && !health.valid) {
      console.warn(`[WatchTogether:${this.getPlatformName()}] Health check failed, adapter no longer valid`);
      this.attemptRecovery('health_check_failed');
    }

    this.lastHealthStatus = health;
  }

  // Mark next action as coming from remote sync
  public setRemoteOrigin(): void {
    this.eventOrigin = EventOrigin.REMOTE;
    // Reset to local after a short delay to handle async events
    setTimeout(() => {
      this.eventOrigin = EventOrigin.LOCAL;
    }, 300);
  }

  public play(): void {
    if (!this.videoElement || this.isDestroyed) return;
    this.setRemoteOrigin();
    this.videoElement.play().catch(err => {
      console.warn(`[WatchTogether:${this.getPlatformName()}] Play failed:`, err.message);
    });
  }

  public pause(): void {
    if (!this.videoElement || this.isDestroyed) return;
    this.setRemoteOrigin();
    this.videoElement.pause();
  }

  public seek(time: number): void {
    if (!this.videoElement || this.isDestroyed) return;
    // Validate time is within bounds
    const duration = this.getDuration();
    if (duration > 0 && time > duration) {
      time = duration - 0.1;
    }
    if (time < 0) time = 0;

    this.setRemoteOrigin();
    this.videoElement.currentTime = time;
  }

  public getCurrentTime(): number {
    return this.videoElement?.currentTime ?? 0;
  }

  public isPlaying(): boolean {
    if (!this.videoElement) return false;
    return !this.videoElement.paused && !this.videoElement.ended;
  }

  public getDuration(): number {
    return this.videoElement?.duration ?? 0;
  }

  // Check if adapter is still valid and functional
  public isValid(): boolean {
    if (!this.videoElement) return false;
    if (this.isDestroyed) return false;

    // Check if video element is still in DOM
    if (!document.contains(this.videoElement)) {
      return false;
    }

    // Check if video has valid source (blob or regular URL)
    const src = this.videoElement.src || this.videoElement.currentSrc;
    if (!src && this.videoElement.querySelectorAll('source').length === 0) {
      return false;
    }

    return true;
  }

  public onPlay(cb: (time: number) => void): void {
    this.playCallbacks.push(cb);
  }

  public onPause(cb: (time: number) => void): void {
    this.pauseCallbacks.push(cb);
  }

  public onSeek(cb: (time: number) => void): void {
    this.seekCallbacks.push(cb);
  }

  public destroy(): void {
    this.isDestroyed = true;
    this.stopHealthCheck();
    this.removeVideoListeners();
    this.cleanupPlatformSpecificListeners();

    this.playCallbacks = [];
    this.pauseCallbacks = [];
    this.seekCallbacks = [];
    this.recoveryCallbacks = [];
    this.videoElement = null;

    console.log(`[WatchTogether:${this.getPlatformName()}] Player adapter destroyed`);
  }
}

// Utility function to wait for an element with retry logic
export async function waitForElement<T extends Element>(
  selector: string | string[],
  maxRetries: number = 30,
  retryDelayMs: number = 1000,
  context: Document | Element = document,
  validator?: (el: T) => boolean
): Promise<T | null> {
  const selectors = Array.isArray(selector) ? selector : [selector];

  for (let i = 0; i < maxRetries; i++) {
    for (const sel of selectors) {
      try {
        const element = context.querySelector<T>(sel);
        if (element && (!validator || validator(element))) {
          return element;
        }
      } catch {
        // Invalid selector, skip
      }
    }
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
  return null;
}

// Utility to find video element using multiple strategies
export function findVideoWithFallbacks(
  selectors: string[],
  context: Document | Element = document
): HTMLVideoElement | null {
  // Strategy 1: Try specific selectors in order
  for (const selector of selectors) {
    try {
      const video = context.querySelector<HTMLVideoElement>(selector);
      if (video && isValidVideoElement(video)) {
        return video;
      }
    } catch {
      // Invalid selector, skip
    }
  }

  // Strategy 2: Find all videos and pick the most likely main player
  const allVideos = context.querySelectorAll<HTMLVideoElement>('video');
  if (allVideos.length === 1 && isValidVideoElement(allVideos[0])) {
    return allVideos[0];
  }

  // Strategy 3: Find largest visible video by dimensions (likely the main player)
  if (allVideos.length > 1) {
    let bestVideo: HTMLVideoElement | null = null;
    let bestArea = 0;

    for (const video of allVideos) {
      if (!isValidVideoElement(video)) continue;

      const rect = video.getBoundingClientRect();
      // Must be visible
      if (rect.width === 0 || rect.height === 0) continue;

      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        bestVideo = video;
      }
    }

    if (bestVideo) {
      return bestVideo;
    }
  }

  // Strategy 4: Return first video with a source, even if small
  for (const video of allVideos) {
    if (video.src || video.currentSrc) {
      return video;
    }
  }

  return null;
}

// Check if a video element appears to be valid for playback
export function isValidVideoElement(video: HTMLVideoElement): boolean {
  // Must have a source
  if (!video.src && !video.currentSrc && video.querySelectorAll('source').length === 0) {
    return false;
  }

  // Check if it's visible (has dimensions)
  const rect = video.getBoundingClientRect();
  // Allow small videos but filter out truly invisible ones (0x0)
  if (rect.width === 0 && rect.height === 0) {
    // Could be CSS hidden, check computed style
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }

  return true;
}

// Utility to observe DOM for element appearance with multiple selectors
export function observeElement<T extends Element>(
  selector: string | string[],
  callback: (element: T) => void,
  context: Document | Element = document
): MutationObserver {
  const selectors = Array.isArray(selector) ? selector : [selector];

  const findAndCallback = (): boolean => {
    for (const sel of selectors) {
      try {
        const element = context.querySelector<T>(sel);
        if (element) {
          callback(element);
          return true;
        }
      } catch {
        // Invalid selector, skip
      }
    }
    return false;
  };

  // Check if already exists
  findAndCallback();

  const observer = new MutationObserver(() => {
    findAndCallback();
  });

  observer.observe(context instanceof Document ? context.body : context, {
    childList: true,
    subtree: true,
  });

  return observer;
}

// Debounce utility for event handling
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}
