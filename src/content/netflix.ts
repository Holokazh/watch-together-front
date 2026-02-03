// Netflix Player Adapter for Watch Together
// Netflix uses a custom player that wraps HTML5 video with additional controls
// We must be defensive as the DOM structure may change frequently

import { BasePlayerAdapter, findVideoWithFallbacks } from './player.interface.js';
import type { SyncEvent } from '../shared/events.js';
import { AdaptiveSyncController } from '../shared/adaptive-sync.js';

// Netflix video selectors - ordered by reliability
// These may change when Netflix updates their player
const NETFLIX_VIDEO_SELECTORS = [
  'video[src^="blob:"]',
  '.watch-video video',
  '.NFPlayer video',
  '.VideoContainer video',
  '[data-uia="video-canvas"] video',
  '.watch-video--player-view video',
  'video'
];

// Netflix player container selectors for detecting player state
const NETFLIX_PLAYER_SELECTORS = [
  '.watch-video--player-view',
  '.NFPlayer',
  '.VideoContainer',
  '[data-uia="player"]',
  '[data-uia="video-canvas"]'
];

// Known Netflix internal API paths - these change frequently
const NETFLIX_API_PATHS = [
  // Current known path
  (w: WindowWithNetflix) => w.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer,
  // Alternative paths that have been used historically
  (w: WindowWithNetflix) => (w as WindowWithNetflixAlt).netflix?.reactContext?.models?.playerModel?.getPlayer?.(),
  // Fallback: search window for player-like objects
  (w: WindowWithNetflix) => findNetflixPlayerInWindow(w),
];

class NetflixPlayerAdapter extends BasePlayerAdapter {
  private playerContainer: Element | null = null;
  private videoSrcObserver: MutationObserver | null = null;
  private urlObserver: MutationObserver | null = null;
  private cachedNetflixPlayer: NetflixPlayerAPI | null = null;
  private playerCacheTime: number = 0;
  private readonly playerCacheMaxAge: number = 5000; // Re-check API every 5s

  protected getPlatformName(): string {
    return 'Netflix';
  }

  protected findVideoElement(): HTMLVideoElement | null {
    // Use the fallback finder which tries multiple strategies
    return findVideoWithFallbacks(NETFLIX_VIDEO_SELECTORS);
  }

  protected setupPlatformSpecificListeners(): void {
    this.findPlayerContainer();
    this.setupVideoSourceObserver();
    this.setupUrlChangeListener();
  }

  protected cleanupPlatformSpecificListeners(): void {
    this.videoSrcObserver?.disconnect();
    this.urlObserver?.disconnect();
    this.videoSrcObserver = null;
    this.urlObserver = null;
    this.playerContainer = null;
    this.cachedNetflixPlayer = null;
  }

  private findPlayerContainer(): void {
    for (const selector of NETFLIX_PLAYER_SELECTORS) {
      try {
        const container = document.querySelector(selector);
        if (container) {
          this.playerContainer = container;
          console.log(`[WatchTogether:Netflix] Found player container: ${selector}`);
          break;
        }
      } catch {
        // Invalid selector, skip
      }
    }

    if (!this.playerContainer) {
      console.warn('[WatchTogether:Netflix] Could not find player container, using body');
      this.playerContainer = document.body;
    }
  }

  private setupVideoSourceObserver(): void {
    // Netflix may swap video elements during playback (quality changes, episode change, etc.)
    if (!this.playerContainer) return;

    this.videoSrcObserver = new MutationObserver(() => {
      const currentVideo = this.findVideoElement();
      if (currentVideo && currentVideo !== this.videoElement) {
        console.log('[WatchTogether:Netflix] Video element changed, rebinding');
        this.handleVideoSwap(currentVideo);
      }
    });

    this.videoSrcObserver.observe(this.playerContainer, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  private setupUrlChangeListener(): void {
    // Watch for navigation within Netflix (episode changes, etc.)
    let lastUrl = location.href;

    this.urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[WatchTogether:Netflix] URL changed, will re-validate adapter');
        // Clear player cache as it may have changed
        this.cachedNetflixPlayer = null;
      }
    });

    this.urlObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private handleVideoSwap(newVideo: HTMLVideoElement): void {
    this.removeVideoListeners();
    this.videoElement = newVideo;
    this.setupEventListeners();
    // Clear player cache
    this.cachedNetflixPlayer = null;
  }

  // Netflix-specific: Get their internal player API with caching
  private getNetflixPlayer(): NetflixPlayerAPI | null {
    const now = Date.now();

    // Use cached player if still valid
    if (this.cachedNetflixPlayer && (now - this.playerCacheTime) < this.playerCacheMaxAge) {
      return this.cachedNetflixPlayer;
    }

    // Try each known API path
    for (const getPlayer of NETFLIX_API_PATHS) {
      try {
        const videoPlayer = getPlayer(window as WindowWithNetflix);
        if (videoPlayer) {
          // Get active player session
          if ('getAllPlayerSessionIds' in videoPlayer) {
            const sessionIds = videoPlayer.getAllPlayerSessionIds();
            if (sessionIds && sessionIds.length > 0) {
              const player = videoPlayer.getVideoPlayerBySessionId(sessionIds[0]);
              if (player && typeof player.play === 'function') {
                this.cachedNetflixPlayer = player;
                this.playerCacheTime = now;
                return player;
              }
            }
          }
          // Direct player object
          if (typeof videoPlayer.play === 'function') {
            this.cachedNetflixPlayer = videoPlayer as NetflixPlayerAPI;
            this.playerCacheTime = now;
            return this.cachedNetflixPlayer;
          }
        }
      } catch {
        // API path not available, try next
      }
    }

    return null;
  }

  // Override play to try Netflix API first, fallback to native
  public play(): void {
    if (this.isDestroyed) return;
    this.setRemoteOrigin();

    const netflixPlayer = this.getNetflixPlayer();
    if (netflixPlayer?.play) {
      try {
        netflixPlayer.play();
        return;
      } catch (e) {
        console.warn('[WatchTogether:Netflix] API play failed, using native');
        this.cachedNetflixPlayer = null; // Clear cache on failure
      }
    }

    super.play();
  }

  // Override pause to try Netflix API first
  public pause(): void {
    if (this.isDestroyed) return;
    this.setRemoteOrigin();

    const netflixPlayer = this.getNetflixPlayer();
    if (netflixPlayer?.pause) {
      try {
        netflixPlayer.pause();
        return;
      } catch (e) {
        console.warn('[WatchTogether:Netflix] API pause failed, using native');
        this.cachedNetflixPlayer = null;
      }
    }

    super.pause();
  }

  // Override seek to try Netflix API first
  public seek(time: number): void {
    if (this.isDestroyed) return;
    this.setRemoteOrigin();

    const netflixPlayer = this.getNetflixPlayer();
    if (netflixPlayer?.seek) {
      try {
        // Netflix seek expects milliseconds
        netflixPlayer.seek(time * 1000);
        return;
      } catch (e) {
        console.warn('[WatchTogether:Netflix] API seek failed, using native');
        this.cachedNetflixPlayer = null;
      }
    }

    super.seek(time);
  }

  // Override to handle Netflix's different time format
  public getCurrentTime(): number {
    const netflixPlayer = this.getNetflixPlayer();
    if (netflixPlayer?.getCurrentTime) {
      try {
        // Netflix returns milliseconds
        const timeMs = netflixPlayer.getCurrentTime();
        if (typeof timeMs === 'number' && !isNaN(timeMs)) {
          return timeMs / 1000;
        }
      } catch {
        // Fall through to native
      }
    }
    return super.getCurrentTime();
  }

  public isPlaying(): boolean {
    const netflixPlayer = this.getNetflixPlayer();
    if (netflixPlayer?.isPlaying) {
      try {
        return netflixPlayer.isPlaying();
      } catch {
        // Fall through to native
      }
    }
    return super.isPlaying();
  }

  // Enhanced validity check for Netflix
  public isValid(): boolean {
    if (!super.isValid()) return false;

    // Additional Netflix-specific checks
    // Make sure we're still on a watch page
    if (!window.location.pathname.startsWith('/watch')) {
      return false;
    }

    return true;
  }
}

// Type definitions for Netflix's internal player API
interface NetflixPlayerAPI {
  play(): void;
  pause(): void;
  seek(timeMs: number): void;
  getCurrentTime(): number;
  isPlaying(): boolean;
}

interface NetflixVideoPlayer {
  getAllPlayerSessionIds(): string[];
  getVideoPlayerBySessionId(id: string): NetflixPlayerAPI;
  play?: () => void;
  pause?: () => void;
  seek?: (timeMs: number) => void;
  getCurrentTime?: () => number;
  isPlaying?: () => boolean;
}

interface WindowWithNetflix extends Window {
  netflix?: {
    appContext?: {
      state?: {
        playerApp?: {
          getAPI?(): {
            videoPlayer?: NetflixVideoPlayer;
          };
        };
      };
    };
  };
}

interface WindowWithNetflixAlt extends Window {
  netflix?: {
    reactContext?: {
      models?: {
        playerModel?: {
          getPlayer?(): NetflixPlayerAPI;
        };
      };
    };
  };
}

// Fallback: Try to find player-like object in window
function findNetflixPlayerInWindow(_win: WindowWithNetflix): NetflixVideoPlayer | null {
  // This is a last resort - search for objects with player-like methods
  // Disabled by default as it's slow and unreliable
  return null;
}

// Content script main logic for Netflix
class NetflixContentScript {
  private adapter: NetflixPlayerAdapter | null = null;
  private readonly maxRetries: number = 30;
  private isApplyingSync: boolean = false;
  private watchObserver: MutationObserver | null = null;
  private adaptiveSync: AdaptiveSyncController = new AdaptiveSyncController();
  private isTabVisible: boolean = !document.hidden;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Register this tab with the background script
    this.registerTab();
    this.setupMessageHandling();
    this.setupVisibilityTracking();

    // Check for deep link (room code in URL parameter)
    this.checkDeepLink();

    if (!this.isWatchPage()) {
      console.log('[WatchTogether:Netflix] Not a watch page, waiting...');
      this.watchForWatchPage();
      return;
    }

    await this.initializeAdapter();
  }

  private setupVisibilityTracking(): void {
    document.addEventListener('visibilitychange', () => {
      this.isTabVisible = !document.hidden;
      console.log(`[WatchTogether:Netflix] Tab visibility changed: ${this.isTabVisible ? 'visible' : 'hidden'}`);

      // Notify background of visibility change
      this.sendToBackground({
        type: 'TAB_VISIBILITY',
        payload: { visible: this.isTabVisible }
      });
    });
  }

  private checkDeepLink(): void {
    const urlParams = new URLSearchParams(window.location.search);
    const roomCode = urlParams.get('wt');

    if (roomCode) {
      console.log(`[WatchTogether:Netflix] Deep link detected - room code: ${roomCode}`);

      // Show notification that Watch Together is active
      this.showWatchTogetherNotification(roomCode);

      // Auto-join the room
      this.sendToBackground({
        type: 'AUTO_JOIN_ROOM',
        payload: { roomId: roomCode.toUpperCase() }
      });

      // Open the popup to show connection status
      this.sendToBackground({
        type: 'OPEN_POPUP'
      });

      // After joining, wait for the video to be ready and send initial state
      this.scheduleInitialStateSync();

      // Remove the parameter from URL to clean it up
      urlParams.delete('wt');
      const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
      window.history.replaceState({}, '', newUrl);
    }
  }

  private scheduleInitialStateSync(): void {
    let attempts = 0;
    const maxAttempts = 15;

    const checkAndNotify = () => {
      attempts++;

      if (!this.adapter || !this.adapter.isValid()) {
        if (attempts < maxAttempts) {
          console.log(`[WatchTogether:Netflix] Adapter not ready yet, retry ${attempts}/${maxAttempts}`);
          setTimeout(checkAndNotify, 1000);
        }
        return;
      }

      const video = this.adapter.getVideoElement();

      // Check if video is actually ready and loaded
      if (video && video.readyState >= 3 && video.duration > 0) {
        console.log(`[WatchTogether:Netflix] Joiner video ready after deep link (readyState: ${video.readyState}, duration: ${video.duration.toFixed(2)}s)`);

        // Pause our video to wait for host sync
        if (!video.paused) {
          console.log(`[WatchTogether:Netflix] Pausing video while waiting for host to start playback`);
          this.adapter.pause();
        }

        // Signal to host that we're ready
        console.log(`[WatchTogether:Netflix] Sending JOINER_READY signal to host`);
        this.sendToBackground({
          type: 'JOINER_READY'
        });
      } else if (attempts < maxAttempts) {
        console.log(`[WatchTogether:Netflix] Video not ready yet (readyState: ${video?.readyState}, duration: ${video?.duration}), retry ${attempts}/${maxAttempts}`);
        setTimeout(checkAndNotify, 1000);
      } else {
        console.warn(`[WatchTogether:Netflix] Max attempts reached, could not verify video ready state`);
      }
    };

    // Start checking after 2 seconds
    setTimeout(checkAndNotify, 2000);
  }

  private showWatchTogetherNotification(roomCode: string): void {
    // Create a notification banner
    const notification = document.createElement('div');
    notification.id = 'watch-together-notification';
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #ff6b35, #f7931e);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(255, 107, 53, 0.4);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 12px;
      animation: slideIn 0.3s ease-out;
    `;

    notification.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
        <circle cx="9" cy="7" r="4"></circle>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
      </svg>
      <div>
        <div style="font-weight: 600;">Watch Together Active</div>
        <div style="font-size: 12px; opacity: 0.9;">Joining room ${roomCode}...</div>
      </div>
    `;

    // Add animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(400px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(400px);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(notification);

    // Remove after 4 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => {
        notification.remove();
        style.remove();
      }, 300);
    }, 4000);
  }

  private registerTab(): void {
    this.sendToBackground({ type: 'REGISTER_TAB' });
    console.log('[WatchTogether:Netflix] Tab registered');
  }

  private isWatchPage(): boolean {
    return window.location.pathname.startsWith('/watch');
  }

  private watchForWatchPage(): void {
    let lastPath = window.location.pathname;

    this.watchObserver = new MutationObserver(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        if (this.isWatchPage() && !this.adapter) {
          console.log('[WatchTogether:Netflix] Navigated to watch page');
          this.init();
        } else if (!this.isWatchPage() && this.adapter) {
          console.log('[WatchTogether:Netflix] Left watch page, cleaning up');
          this.cleanup();
        }
      }
    });

    this.watchObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private async initializeAdapter(): Promise<void> {
    console.log('[WatchTogether:Netflix] Waiting for video element...');

    let video: HTMLVideoElement | null = null;
    for (let i = 0; i < this.maxRetries; i++) {
      video = findVideoWithFallbacks(NETFLIX_VIDEO_SELECTORS);
      if (video) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!video) {
      console.warn('[WatchTogether:Netflix] Could not find video element after retries');
      return;
    }

    this.adapter = new NetflixPlayerAdapter();
    const success = await this.adapter.initialize();

    if (success) {
      this.bindPlayerEvents();
      console.log('[WatchTogether:Netflix] Adapter ready');
    }
  }

  private bindPlayerEvents(): void {
    if (!this.adapter) return;

    this.adapter.onPlay((time) => {
      if (this.isApplyingSync) return;
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:Netflix] Tab hidden - ignoring PLAY event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'PLAY', time, timestamp: Date.now() }
      });
    });

    this.adapter.onPause((time) => {
      if (this.isApplyingSync) return;
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:Netflix] Tab hidden - ignoring PAUSE event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'PAUSE', time, timestamp: Date.now() }
      });
    });

    this.adapter.onSeek((time) => {
      if (this.isApplyingSync) return;
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:Netflix] Tab hidden - ignoring SEEK event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'SEEK', time, timestamp: Date.now() }
      });
    });

    // Re-bind events on recovery
    this.adapter.onRecovery(() => {
      console.log('[WatchTogether:Netflix] Adapter recovered, events still bound');
    });
  }

  private setupMessageHandling(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      this.handleMessage(message, sendResponse);
      return true;
    });
  }

  private handleMessage(message: { type: string; payload?: unknown }, sendResponse: (response: unknown) => void): void {
    switch (message.type) {
      case 'APPLY_SYNC':
        this.applySyncEvent(message.payload as SyncEvent);
        sendResponse({ success: true });
        break;

      case 'REQUEST_STATE':
        if (this.adapter && this.adapter.isValid()) {
          sendResponse({
            success: true,
            state: {
              isPlaying: this.adapter.isPlaying(),
              currentTime: this.adapter.getCurrentTime(),
            }
          });
        } else {
          sendResponse({ success: false, error: 'Adapter not valid' });
        }
        break;

      case 'PING':
        sendResponse({
          success: true,
          platform: 'netflix',
          valid: this.adapter?.isValid() ?? false
        });
        break;

      case 'START_PLAYBACK_FOR_JOINER':
        // Host received signal that joiner is ready
        // Start/resume playback to trigger sync
        if (this.adapter && this.adapter.isValid()) {
          console.log('[WatchTogether:Netflix] Starting playback to sync with joiner');
          const currentTime = this.adapter.getCurrentTime();

          // First, send explicit SEEK event to sync position
          console.log(`[WatchTogether:Netflix] Sending SEEK to ${currentTime.toFixed(2)}s to sync joiner position`);
          this.sendToBackground({
            type: 'PLAYER_EVENT',
            payload: {
              type: 'SEEK',
              time: currentTime,
              timestamp: Date.now()
            }
          });

          // Then send PLAY event to start playback
          setTimeout(() => {
            if (this.adapter && this.adapter.isValid()) {
              console.log('[WatchTogether:Netflix] Sending PLAY to start synchronized playback');
              this.adapter.play();

              this.sendToBackground({
                type: 'PLAYER_EVENT',
                payload: {
                  type: 'PLAY',
                  time: this.adapter.getCurrentTime(),
                  timestamp: Date.now()
                }
              });
            }
          }, 200);

          // Force a third sync after 2 seconds to ensure everyone is aligned
          setTimeout(() => {
            if (this.adapter && this.adapter.isValid()) {
              const syncTime = this.adapter.getCurrentTime();
              const isPlaying = this.adapter.isPlaying();
              console.log('[WatchTogether:Netflix] Forcing final sync after 2s:', isPlaying ? 'PLAY' : 'PAUSE', 'at', syncTime.toFixed(2) + 's');

              // Send both SEEK and PLAY/PAUSE to ensure perfect sync
              this.sendToBackground({
                type: 'PLAYER_EVENT',
                payload: {
                  type: 'SEEK',
                  time: syncTime,
                  timestamp: Date.now()
                }
              });

              setTimeout(() => {
                if (this.adapter && this.adapter.isValid()) {
                  this.sendToBackground({
                    type: 'PLAYER_EVENT',
                    payload: {
                      type: isPlaying ? 'PLAY' : 'PAUSE',
                      time: this.adapter.getCurrentTime(),
                      timestamp: Date.now()
                    }
                  });
                }
              }, 100);
            }
          }, 2000);

          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Adapter not valid' });
        }
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  private async applySyncEvent(event: SyncEvent): Promise<void> {
    if (!this.adapter || !this.adapter.isValid()) {
      console.warn('[WatchTogether:Netflix] Cannot apply sync - adapter not valid');
      return;
    }

    this.isApplyingSync = true;

    try {
      const currentTime = this.adapter.getCurrentTime();
      const isPlaying = this.adapter.isPlaying();
      const video = this.adapter.getVideoElement();

      switch (event.type) {
        case 'PLAY': {
          // Use adaptive sync with latency compensation
          if (video) {
            const action = this.adaptiveSync.calculateCompensatedSyncAction(
              currentTime,
              event.time,
              event.timestamp,
              true // We're about to play
            );

            switch (action.type) {
              case 'adjust_speed':
                this.adaptiveSync.applySpeedAdjustment(video, action.rate);
                console.log(`[WatchTogether:Netflix] Adaptive sync: speed ${action.rate.toFixed(2)}x`);
                break;
              case 'smooth_seek':
                await this.adaptiveSync.smoothSeek(video, action.targetTime, action.duration);
                console.log(`[WatchTogether:Netflix] Adaptive sync: smooth seek to ${action.targetTime.toFixed(2)}s`);
                break;
              case 'hard_seek':
                this.adapter.seek(action.targetTime);
                console.log(`[WatchTogether:Netflix] Adaptive sync: hard seek to ${action.targetTime.toFixed(2)}s`);
                break;
              default:
                console.log(`[WatchTogether:Netflix] Adaptive sync: in sync (no action needed)`);
                break;
            }
          }
          this.adapter.play();
          break;
        }

        case 'PAUSE': {
          // For pause, no latency compensation - we want exact position
          const drift = Math.abs(currentTime - event.time) * 1000;
          if (drift > 500) {
            this.adapter.seek(event.time);
            console.log(`[WatchTogether:Netflix] Pause: seeked to ${event.time.toFixed(2)}s (drift: ${drift.toFixed(0)}ms)`);
          }
          this.adapter.pause();
          // Reset playback speed on pause
          if (video) {
            this.adaptiveSync.resetSpeed(video);
          }
          break;
        }

        case 'SEEK': {
          // For explicit seek, compensate for latency if playing
          const compensatedTime = this.adaptiveSync.compensateForLatency(
            event.time,
            event.timestamp,
            isPlaying
          );

          if (video) {
            const seekDrift = Math.abs(currentTime - compensatedTime) * 1000;
            if (seekDrift > 5000) {
              // Large seek - do it directly
              this.adapter.seek(compensatedTime);
              console.log(`[WatchTogether:Netflix] Seek: hard seek to ${compensatedTime.toFixed(2)}s`);
            } else if (seekDrift > 300) {
              // Medium seek - smooth it
              await this.adaptiveSync.smoothSeek(video, compensatedTime, 250);
              console.log(`[WatchTogether:Netflix] Seek: smooth seek to ${compensatedTime.toFixed(2)}s`);
            } else {
              // Small seek
              this.adapter.seek(compensatedTime);
              console.log(`[WatchTogether:Netflix] Seek: micro seek to ${compensatedTime.toFixed(2)}s`);
            }
          } else {
            this.adapter.seek(compensatedTime);
          }
          break;
        }
      }

      // Log sync stats periodically
      const stats = this.adaptiveSync.getStats();
      if (stats.samplesCount > 0 && stats.samplesCount % 5 === 0) {
        console.log(`[WatchTogether:Netflix] Sync stats: avg latency ${stats.avgLatency.toFixed(0)}ms, clock offset ${stats.clockOffset.toFixed(0)}ms`);
      }

      console.log(`[WatchTogether:Netflix] Applied sync: ${event.type} at ${event.time.toFixed(2)}s`);
    } finally {
      setTimeout(() => {
        this.isApplyingSync = false;
      }, 200); // Reduced cooldown
    }
  }

  private sendToBackground(message: { type: string; payload?: unknown }): void {
    try {
      // Check if extension context is still valid
      if (!chrome.runtime?.id) {
        console.log('[WatchTogether:Netflix] Extension context invalidated, cleaning up');
        this.cleanup();
        return;
      }
      chrome.runtime.sendMessage(message).catch(err => {
        // Silently ignore "Extension context invalidated" errors
        if (err.message?.includes('Extension context invalidated')) {
          this.cleanup();
          return;
        }
        console.warn('[WatchTogether:Netflix] Failed to send message:', err.message);
      });
    } catch (err) {
      // Extension was reloaded, clean up silently
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.adapter) {
      this.adapter.destroy();
      this.adapter = null;
    }
  }
}

// Initialize content script
console.log('[WatchTogether:Netflix] Content script loaded');
new NetflixContentScript();
