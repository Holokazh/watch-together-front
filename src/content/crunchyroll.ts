// Crunchyroll Player Adapter for Watch Together
// Crunchyroll uses a custom HTML5 player wrapper (Vilos) with potential shadow DOM
// Must handle episode changes dynamically and player reloads

import { BasePlayerAdapter, findVideoWithFallbacks, isValidVideoElement } from './player.interface.js';
import type { SyncEvent, NavigationEvent } from '../shared/events.js';
import { DRIFT_THRESHOLD_MS } from '../shared/events.js';
import { AdaptiveSyncController } from '../shared/adaptive-sync.js';

// Crunchyroll video selectors - ordered by reliability
// These change when Crunchyroll updates their Vilos player
const CRUNCHYROLL_VIDEO_SELECTORS = [
  // 2024/2025 Crunchyroll player selectors
  '#velocity-player-package video',
  '[data-testid="velocity-player"] video',
  '.velocity-player video',
  '#cr-player video',
  '.cr-video-player video',
  // Modern Crunchyroll player selectors
  '#player0 video',
  '[data-testid="vilos-player"] video',
  '.video-player video',
  '.erc-video-player video',
  // Vilos player selectors
  '.vilos-player video',
  '#vilos video',
  'vilos-player video',
  // ERC player (newer versions)
  '.erc-current-media-player video',
  '[class*="player"] video',
  '[id*="player"] video',
  // Generic fallbacks - these should catch most cases
  'video#player0',
  'video[src^="blob:"]',
  'video[src*="crunchyroll"]',
  'video'
];

// Container selectors for the player wrapper
const CRUNCHYROLL_CONTAINER_SELECTORS = [
  // 2024/2025 containers
  '#velocity-player-package',
  '[data-testid="velocity-player"]',
  '.velocity-player',
  '#cr-player',
  '.cr-video-player',
  // Older containers
  '#player0',
  '[data-testid="vilos-player"]',
  '.video-player',
  '.erc-video-player',
  '.erc-current-media-player',
  '.vilos-player',
  '#vilos',
  'vilos-player',
  // Broad fallbacks
  '[class*="player"]',
  '[id*="player"]',
  '#content'
];

class CrunchyrollPlayerAdapter extends BasePlayerAdapter {
  private urlObserver: MutationObserver | null = null;
  private containerObserver: MutationObserver | null = null;
  private shadowRoot: ShadowRoot | null = null;
  private currentEpisodeId: string | null = null;
  private playerContainer: Element | null = null;

  protected getPlatformName(): string {
    return 'Crunchyroll';
  }

  protected findVideoElement(): HTMLVideoElement | null {
    // Strategy 1: Try standard DOM selectors with fallback finder
    const video = findVideoWithFallbacks(CRUNCHYROLL_VIDEO_SELECTORS);
    if (video) return video;

    // Strategy 2: Try to find video inside shadow DOM
    const shadowVideo = this.findVideoInShadowDOM();
    if (shadowVideo) return shadowVideo;

    // Strategy 3: Check inside iframes (some regions use different player)
    const iframeVideo = this.findVideoInIframes();
    if (iframeVideo) return iframeVideo;

    return null;
  }

  private findVideoInShadowDOM(): HTMLVideoElement | null {
    // Check known containers for shadow roots
    for (const selector of CRUNCHYROLL_CONTAINER_SELECTORS) {
      try {
        const container = document.querySelector(selector);
        if (container?.shadowRoot) {
          const video = container.shadowRoot.querySelector<HTMLVideoElement>('video');
          if (video && isValidVideoElement(video)) {
            this.shadowRoot = container.shadowRoot;
            console.log(`[WatchTogether:Crunchyroll] Found video in shadow DOM: ${selector}`);
            return video;
          }
        }
      } catch {
        // Invalid selector, skip
      }
    }

    // Scan all elements for shadow roots (expensive but thorough)
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      try {
        if (el.shadowRoot) {
          const video = el.shadowRoot.querySelector<HTMLVideoElement>('video');
          if (video && isValidVideoElement(video)) {
            this.shadowRoot = el.shadowRoot;
            console.log('[WatchTogether:Crunchyroll] Found video in unknown shadow root');
            return video;
          }
        }
      } catch {
        // Access denied, skip
      }
    }

    return null;
  }

  private findVideoInIframes(): HTMLVideoElement | null {
    // Some regional versions of Crunchyroll embed the player in an iframe
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iframeDoc) {
          const video = iframeDoc.querySelector<HTMLVideoElement>('video');
          if (video && isValidVideoElement(video)) {
            console.log('[WatchTogether:Crunchyroll] Found video in iframe');
            return video;
          }
        }
      } catch {
        // Cross-origin iframe, can't access
      }
    }
    return null;
  }

  protected setupPlatformSpecificListeners(): void {
    this.currentEpisodeId = this.getEpisodeIdFromUrl();
    this.findPlayerContainer();
    this.setupUrlChangeListener();
    this.setupContainerObserver();
  }

  protected cleanupPlatformSpecificListeners(): void {
    this.urlObserver?.disconnect();
    this.containerObserver?.disconnect();
    this.urlObserver = null;
    this.containerObserver = null;
    this.shadowRoot = null;
    this.playerContainer = null;
  }

  private findPlayerContainer(): void {
    for (const selector of CRUNCHYROLL_CONTAINER_SELECTORS) {
      try {
        const container = document.querySelector(selector);
        if (container) {
          this.playerContainer = container;
          console.log(`[WatchTogether:Crunchyroll] Found player container: ${selector}`);
          return;
        }
      } catch {
        // Invalid selector, skip
      }
    }
    console.warn('[WatchTogether:Crunchyroll] Could not find player container');
  }

  private getEpisodeIdFromUrl(): string | null {
    // Crunchyroll URLs: /watch/EPISODEID/title or /LOCALE/watch/EPISODEID/title
    const match = window.location.pathname.match(/\/watch\/([^\/]+)/);
    return match ? match[1] : null;
  }

  private setupUrlChangeListener(): void {
    let lastUrl = location.href;

    this.urlObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const newEpisodeId = this.getEpisodeIdFromUrl();
        if (newEpisodeId && newEpisodeId !== this.currentEpisodeId) {
          console.log(`[WatchTogether:Crunchyroll] Episode changed: ${this.currentEpisodeId} -> ${newEpisodeId}`);
          this.currentEpisodeId = newEpisodeId;
          this.handleEpisodeChange();
        }
      }
    });

    this.urlObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private setupContainerObserver(): void {
    // Watch for video element changes within the player container
    const observeTarget = this.playerContainer || document.body;

    this.containerObserver = new MutationObserver(() => {
      const currentVideo = this.findVideoElement();
      if (currentVideo && currentVideo !== this.videoElement) {
        console.log('[WatchTogether:Crunchyroll] Video element changed, rebinding');
        this.handleVideoSwap(currentVideo);
      }
    });

    this.containerObserver.observe(observeTarget, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });
  }

  private async handleEpisodeChange(): Promise<void> {
    // Episode changed - wait for new video to load
    console.log('[WatchTogether:Crunchyroll] Waiting for new episode video...');

    // Wait for DOM to settle
    await new Promise(resolve => setTimeout(resolve, 1500));

    const newVideo = this.findVideoElement();
    if (newVideo && newVideo !== this.videoElement) {
      this.handleVideoSwap(newVideo);
    } else if (!newVideo) {
      // Video not found yet, trigger recovery
      this.attemptRecovery('episode_change');
    }
  }

  private handleVideoSwap(newVideo: HTMLVideoElement): void {
    this.removeVideoListeners();
    this.videoElement = newVideo;
    this.setupEventListeners();
    console.log('[WatchTogether:Crunchyroll] Rebound to new video element');
  }

  // Override play with Crunchyroll-specific retry logic
  public play(): void {
    if (!this.videoElement || this.isDestroyed) return;
    this.setRemoteOrigin();

    this.videoElement.play().catch(err => {
      if (err.name === 'NotAllowedError') {
        console.warn('[WatchTogether:Crunchyroll] Autoplay blocked - user interaction required');
      } else if (err.name === 'AbortError') {
        // Crunchyroll often aborts play during buffering, retry
        console.log('[WatchTogether:Crunchyroll] Play aborted, retrying...');
        setTimeout(() => {
          if (this.videoElement && !this.isDestroyed) {
            this.videoElement.play().catch(() => {});
          }
        }, 200);
      } else {
        console.warn('[WatchTogether:Crunchyroll] Play failed:', err.message);
      }
    });
  }

  // Enhanced validity check for Crunchyroll
  public isValid(): boolean {
    if (!super.isValid()) return false;

    // Must be on a watch page
    if (!window.location.pathname.includes('/watch/')) {
      return false;
    }

    return true;
  }
}

// Content script main logic for Crunchyroll
class CrunchyrollContentScript {
  private adapter: CrunchyrollPlayerAdapter | null = null;
  private readonly maxRetries: number = 30;
  private isApplyingSync: boolean = false;
  private isNavigatingFromSync: boolean = false;
  private watchObserver: MutationObserver | null = null;
  private navigationObserver: MutationObserver | null = null;
  private lastUrl: string = '';
  private adaptiveSync: AdaptiveSyncController = new AdaptiveSyncController();
  private isTabVisible: boolean = !document.hidden;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Register this tab with the background script
    this.registerTab();

    this.setupMessageHandling();
    this.setupNavigationTracking();
    this.setupVisibilityTracking();

    // Check for deep link (room code in URL parameter)
    this.checkDeepLink();

    if (!this.isWatchPage()) {
      console.log('[WatchTogether:Crunchyroll] Not a watch page, waiting...');
      this.watchForWatchPage();
      return;
    }

    await this.initializeAdapter();
  }

  private setupVisibilityTracking(): void {
    document.addEventListener('visibilitychange', () => {
      this.isTabVisible = !document.hidden;
      console.log(`[WatchTogether:Crunchyroll] Tab visibility changed: ${this.isTabVisible ? 'visible' : 'hidden'}`);

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
      console.log(`[WatchTogether:Crunchyroll] Deep link detected - room code: ${roomCode}`);

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
          console.log(`[WatchTogether:Crunchyroll] Adapter not ready yet, retry ${attempts}/${maxAttempts}`);
          setTimeout(checkAndNotify, 1000);
        }
        return;
      }

      const video = this.adapter.getVideoElement();

      // Check if video is actually ready and loaded
      if (video && video.readyState >= 3 && video.duration > 0) {
        console.log(`[WatchTogether:Crunchyroll] Joiner video ready after deep link (readyState: ${video.readyState}, duration: ${video.duration.toFixed(2)}s)`);

        // Pause our video to wait for host sync
        if (!video.paused) {
          console.log(`[WatchTogether:Crunchyroll] Pausing video while waiting for host to start playback`);
          this.adapter.pause();
        }

        // Signal to host that we're ready
        console.log(`[WatchTogether:Crunchyroll] Sending JOINER_READY signal to host`);
        this.sendToBackground({
          type: 'JOINER_READY'
        });
      } else if (attempts < maxAttempts) {
        console.log(`[WatchTogether:Crunchyroll] Video not ready yet (readyState: ${video?.readyState}, duration: ${video?.duration}), retry ${attempts}/${maxAttempts}`);
        setTimeout(checkAndNotify, 1000);
      } else {
        console.warn(`[WatchTogether:Crunchyroll] Max attempts reached, could not verify video ready state`);
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
    console.log('[WatchTogether:Crunchyroll] Tab registered');
  }

  private isWatchPage(): boolean {
    return window.location.pathname.includes('/watch/');
  }

  private watchForWatchPage(): void {
    let lastPath = window.location.pathname;

    this.watchObserver = new MutationObserver(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        if (this.isWatchPage() && !this.adapter) {
          console.log('[WatchTogether:Crunchyroll] Navigated to watch page');
          this.initializeAdapter();
        } else if (!this.isWatchPage() && this.adapter) {
          console.log('[WatchTogether:Crunchyroll] Left watch page, cleaning up');
          this.cleanup();
        }
      }
    });

    this.watchObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private setupNavigationTracking(): void {
    this.lastUrl = location.href;

    this.navigationObserver = new MutationObserver(() => {
      if (location.href !== this.lastUrl) {
        const oldUrl = this.lastUrl;
        this.lastUrl = location.href;

        // Don't send navigation if we're navigating from a sync event
        if (this.isNavigatingFromSync) {
          this.isNavigatingFromSync = false;
          return;
        }

        // Only send navigation events for watch pages
        if (this.isWatchPage()) {
          console.log(`[WatchTogether:Crunchyroll] URL changed: ${oldUrl} -> ${this.lastUrl}`);
          this.sendNavigationEvent();
        }
      }
    });

    this.navigationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private sendNavigationEvent(): void {
    // Only send navigation events if tab is visible
    if (!this.isTabVisible) {
      console.log('[WatchTogether:Crunchyroll] Tab hidden - ignoring navigation event');
      return;
    }

    const navigationEvent: NavigationEvent = {
      url: location.href,
      platform: 'crunchyroll',
      timestamp: Date.now()
    };

    this.sendToBackground({
      type: 'NAVIGATION_EVENT',
      payload: navigationEvent
    });

    console.log('[WatchTogether:Crunchyroll] Sent navigation event:', location.href);
  }

  private navigateToUrl(url: string): void {
    if (location.href === url) return;

    console.log('[WatchTogether:Crunchyroll] Navigating to:', url);
    this.isNavigatingFromSync = true;

    window.location.href = url;
  }

  private async initializeAdapter(): Promise<void> {
    console.log('[WatchTogether:Crunchyroll] Waiting for video element...');

    let video: HTMLVideoElement | null = null;

    // Crunchyroll can take a while to load the player
    for (let i = 0; i < this.maxRetries; i++) {
      // Debug: Log what we find on each attempt
      if (i % 5 === 0) {
        this.debugLogVideoElements();
      }

      video = findVideoWithFallbacks(CRUNCHYROLL_VIDEO_SELECTORS);

      // Also try shadow DOM
      if (!video) {
        video = this.findVideoInShadowDOM();
      }

      // Try aggressive search - find ANY video element
      if (!video) {
        video = this.findAnyVideo();
      }

      if (video) {
        console.log('[WatchTogether:Crunchyroll] Found video element:', video);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!video) {
      console.warn('[WatchTogether:Crunchyroll] Could not find video element after retries');
      this.debugLogVideoElements();
      return;
    }

    this.adapter = new CrunchyrollPlayerAdapter();
    const success = await this.adapter.initialize();

    if (success) {
      this.bindPlayerEvents();
      console.log('[WatchTogether:Crunchyroll] Adapter ready');
    }
  }

  private debugLogVideoElements(): void {
    // Log all video elements on the page
    const allVideos = document.querySelectorAll('video');
    console.log(`[WatchTogether:Crunchyroll] DEBUG: Found ${allVideos.length} video element(s) on page`);
    allVideos.forEach((v, i) => {
      console.log(`[WatchTogether:Crunchyroll] DEBUG: Video ${i}:`, {
        src: v.src?.substring(0, 100),
        readyState: v.readyState,
        duration: v.duration,
        parent: v.parentElement?.className,
        grandparent: v.parentElement?.parentElement?.className
      });
    });

    // Log potential player containers
    const containers = document.querySelectorAll('[class*="player"], [id*="player"]');
    console.log(`[WatchTogether:Crunchyroll] DEBUG: Found ${containers.length} potential player container(s)`);
    containers.forEach((c, i) => {
      if (i < 5) { // Limit logging
        console.log(`[WatchTogether:Crunchyroll] DEBUG: Container ${i}:`, {
          tag: c.tagName,
          id: (c as HTMLElement).id,
          class: c.className
        });
      }
    });
  }

  private findAnyVideo(): HTMLVideoElement | null {
    // Last resort: find any video element with a blob or crunchyroll source
    const allVideos = document.querySelectorAll('video');
    for (const video of allVideos) {
      if (video instanceof HTMLVideoElement) {
        // Check if it's a real video (not an ad or thumbnail)
        if (video.readyState > 0 || video.src?.startsWith('blob:') || video.duration > 0) {
          console.log('[WatchTogether:Crunchyroll] Found video via aggressive search');
          return video;
        }
      }
    }
    return null;
  }

  private findVideoInShadowDOM(): HTMLVideoElement | null {
    for (const selector of CRUNCHYROLL_CONTAINER_SELECTORS) {
      try {
        const container = document.querySelector(selector);
        if (container?.shadowRoot) {
          const video = container.shadowRoot.querySelector<HTMLVideoElement>('video');
          if (video && isValidVideoElement(video)) {
            return video;
          }
        }
      } catch {
        // Invalid selector or access denied
      }
    }
    return null;
  }

  private bindPlayerEvents(): void {
    if (!this.adapter) return;

    this.adapter.onPlay((time) => {
      if (this.isApplyingSync) return;
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:Crunchyroll] Tab hidden - ignoring PLAY event');
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
        console.log('[WatchTogether:Crunchyroll] Tab hidden - ignoring PAUSE event');
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
        console.log('[WatchTogether:Crunchyroll] Tab hidden - ignoring SEEK event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'SEEK', time, timestamp: Date.now() }
      });
    });

    // Re-bind events on recovery
    this.adapter.onRecovery(() => {
      console.log('[WatchTogether:Crunchyroll] Adapter recovered, events still bound');
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

      case 'NAVIGATE': {
        const nav = message.payload as NavigationEvent;
        if (nav.platform === 'crunchyroll') {
          this.navigateToUrl(nav.url);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Different platform' });
        }
        break;
      }

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
          platform: 'crunchyroll',
          valid: this.adapter?.isValid() ?? false
        });
        break;

      case 'START_PLAYBACK_FOR_JOINER':
        // Host received signal that joiner is ready
        // Start/resume playback to trigger sync
        if (this.adapter && this.adapter.isValid()) {
          console.log('[WatchTogether:Crunchyroll] Starting playback to sync with joiner');
          const currentTime = this.adapter.getCurrentTime();

          // First, send explicit SEEK event to sync position
          console.log(`[WatchTogether:Crunchyroll] Sending SEEK to ${currentTime.toFixed(2)}s to sync joiner position`);
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
              console.log('[WatchTogether:Crunchyroll] Sending PLAY to start synchronized playback');
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
              console.log('[WatchTogether:Crunchyroll] Forcing final sync after 2s:', isPlaying ? 'PLAY' : 'PAUSE', 'at', syncTime.toFixed(2) + 's');

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
      console.warn('[WatchTogether:Crunchyroll] Cannot apply sync - adapter not valid');
      return;
    }

    const video = this.adapter.getVideoElement();
    if (!video) return;

    this.isApplyingSync = true;

    try {
      const currentTime = this.adapter.getCurrentTime();
      const isPlaying = this.adapter.isPlaying();

      switch (event.type) {
        case 'PLAY': {
          // Use adaptive sync with latency compensation
          const action = this.adaptiveSync.calculateCompensatedSyncAction(
            currentTime,
            event.time,
            event.timestamp,
            true // We're about to play
          );

          switch (action.type) {
            case 'adjust_speed':
              this.adaptiveSync.applySpeedAdjustment(video, action.rate);
              console.log(`[WatchTogether:Crunchyroll] Adaptive sync: speed ${action.rate.toFixed(2)}x`);
              break;
            case 'smooth_seek':
              await this.adaptiveSync.smoothSeek(video, action.targetTime, action.duration);
              console.log(`[WatchTogether:Crunchyroll] Adaptive sync: smooth seek to ${action.targetTime.toFixed(2)}s`);
              break;
            case 'hard_seek':
              this.adapter.seek(action.targetTime);
              console.log(`[WatchTogether:Crunchyroll] Adaptive sync: hard seek to ${action.targetTime.toFixed(2)}s`);
              break;
            default:
              console.log(`[WatchTogether:Crunchyroll] Adaptive sync: in sync (no action needed)`);
              break;
          }

          this.adapter.play();
          break;
        }

        case 'PAUSE': {
          // Reset any speed adjustments when pausing
          this.adaptiveSync.resetSpeed(video);

          // For pause, no latency compensation - we want exact position
          const drift = Math.abs(currentTime - event.time) * 1000;
          if (drift > DRIFT_THRESHOLD_MS) {
            this.adapter.seek(event.time);
            console.log(`[WatchTogether:Crunchyroll] Pause: seeked to ${event.time.toFixed(2)}s (drift: ${drift.toFixed(0)}ms)`);
          }
          this.adapter.pause();
          break;
        }

        case 'SEEK': {
          // For explicit seek, compensate for latency if playing
          const compensatedTime = this.adaptiveSync.compensateForLatency(
            event.time,
            event.timestamp,
            isPlaying
          );

          const seekDrift = Math.abs(currentTime - compensatedTime) * 1000;
          if (seekDrift > 5000) {
            // Large seek - do it directly
            this.adapter.seek(compensatedTime);
            console.log(`[WatchTogether:Crunchyroll] Seek: hard seek to ${compensatedTime.toFixed(2)}s`);
          } else if (seekDrift > 300) {
            // Medium seek - smooth it
            await this.adaptiveSync.smoothSeek(video, compensatedTime, 250);
            console.log(`[WatchTogether:Crunchyroll] Seek: smooth seek to ${compensatedTime.toFixed(2)}s`);
          } else {
            // Small seek
            this.adapter.seek(compensatedTime);
            console.log(`[WatchTogether:Crunchyroll] Seek: micro seek to ${compensatedTime.toFixed(2)}s`);
          }
          break;
        }
      }

      // Log sync stats periodically
      const stats = this.adaptiveSync.getStats();
      if (stats.samplesCount > 0 && stats.samplesCount % 5 === 0) {
        console.log(`[WatchTogether:Crunchyroll] Sync stats: avg latency ${stats.avgLatency.toFixed(0)}ms, clock offset ${stats.clockOffset.toFixed(0)}ms`);
      }

      console.log(`[WatchTogether:Crunchyroll] Applied sync: ${event.type} at ${event.time.toFixed(2)}s`);
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
        console.log('[WatchTogether:Crunchyroll] Extension context invalidated, cleaning up');
        this.cleanup();
        return;
      }
      chrome.runtime.sendMessage(message).catch(err => {
        // Silently ignore "Extension context invalidated" errors
        if (err.message?.includes('Extension context invalidated')) {
          this.cleanup();
          return;
        }
        console.warn('[WatchTogether:Crunchyroll] Failed to send message:', err.message);
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
console.log('[WatchTogether:Crunchyroll] Content script loaded');
new CrunchyrollContentScript();
