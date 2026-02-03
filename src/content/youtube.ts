// YouTube Player Adapter for Watch Together
// Handles YouTube's HTML5 video player with SPA navigation support

import { BasePlayerAdapter, findVideoWithFallbacks } from './player.interface.js';
import type { SyncEvent, NavigationEvent } from '../shared/events.js';
import { DRIFT_THRESHOLD_MS } from '../shared/events.js';
import { AdaptiveSyncController } from '../shared/adaptive-sync.js';

// YouTube video selectors - ordered by specificity
const YOUTUBE_VIDEO_SELECTORS = [
  'video.html5-main-video',
  'video.video-stream',
  '#movie_player video',
  'ytd-player video',
  '.html5-video-container video',
  'video'
];

class YouTubePlayerAdapter extends BasePlayerAdapter {
  private navigationObserver: MutationObserver | null = null;
  private currentVideoId: string | null = null;
  private adObserver: MutationObserver | null = null;
  private isPlayingAd: boolean = false;
  private onAdStateChange: ((isAd: boolean) => void) | null = null;

  protected getPlatformName(): string {
    return 'YouTube';
  }

  protected findVideoElement(): HTMLVideoElement | null {
    return findVideoWithFallbacks(YOUTUBE_VIDEO_SELECTORS);
  }

  protected setupPlatformSpecificListeners(): void {
    this.setupNavigationListener();
    this.setupAdDetection();
    this.currentVideoId = this.getVideoIdFromUrl();
  }

  protected cleanupPlatformSpecificListeners(): void {
    this.navigationObserver?.disconnect();
    this.navigationObserver = null;
    this.adObserver?.disconnect();
    this.adObserver = null;
  }

  // Public method to register ad state change callback
  public setAdStateChangeCallback(callback: (isAd: boolean) => void): void {
    this.onAdStateChange = callback;
  }

  // Check if currently playing an ad
  public isAdPlaying(): boolean {
    return this.isPlayingAd;
  }

  private setupAdDetection(): void {
    // Check for ad indicators immediately
    this.checkForAd();

    // Watch for DOM changes that indicate ad playback
    this.adObserver = new MutationObserver(() => {
      this.checkForAd();
    });

    const moviePlayer = document.querySelector('#movie_player');
    if (moviePlayer) {
      this.adObserver.observe(moviePlayer, {
        attributes: true,
        attributeFilter: ['class'],
        childList: true,
        subtree: true
      });
    }
  }

  private checkForAd(): void {
    const moviePlayer = document.querySelector('#movie_player');
    if (!moviePlayer) return;

    // Check for ad-related classes
    const hasAdClass = moviePlayer.classList.contains('ad-showing') ||
                       moviePlayer.classList.contains('ad-interrupting') ||
                       moviePlayer.classList.contains('ad-created');

    // Check for ad overlay elements
    const hasAdOverlay = !!document.querySelector('.ytp-ad-player-overlay') ||
                         !!document.querySelector('.video-ads') ||
                         !!document.querySelector('[class*="ad-container"]');

    // Check for ad skip button
    const hasSkipButton = !!document.querySelector('.ytp-ad-skip-button') ||
                          !!document.querySelector('.ytp-ad-skip-button-modern');

    const wasPlayingAd = this.isPlayingAd;
    this.isPlayingAd = hasAdClass || hasAdOverlay || hasSkipButton;

    // Notify if ad state changed
    if (wasPlayingAd !== this.isPlayingAd && this.onAdStateChange) {
      console.log(`[WatchTogether:YouTube] Ad state changed: ${this.isPlayingAd ? 'AD STARTED' : 'AD ENDED'}`);
      this.onAdStateChange(this.isPlayingAd);
    }
  }

  private setupNavigationListener(): void {
    // YouTube uses History API for navigation - watch for URL changes
    let lastUrl = location.href;

    this.navigationObserver = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        const newVideoId = this.getVideoIdFromUrl();
        if (newVideoId && newVideoId !== this.currentVideoId) {
          console.log(`[WatchTogether:YouTube] Video changed: ${this.currentVideoId} -> ${newVideoId}`);
          this.currentVideoId = newVideoId;
          this.handleVideoChange();
        }
      }
    });

    this.navigationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private getVideoIdFromUrl(): string | null {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  private async handleVideoChange(): Promise<void> {
    // Wait for new video element to be ready
    await new Promise(resolve => setTimeout(resolve, 500));

    const newVideo = this.findVideoElement();
    if (newVideo && newVideo !== this.videoElement) {
      this.removeVideoListeners();
      this.videoElement = newVideo;
      this.setupEventListeners();
      console.log('[WatchTogether:YouTube] Rebound to new video element');
    }
  }

  // Override play to handle YouTube's buffering states
  public play(): void {
    if (!this.videoElement || this.isDestroyed) return;
    this.setRemoteOrigin();

    this.videoElement.play().catch(err => {
      if (err.name === 'NotAllowedError') {
        console.warn('[WatchTogether:YouTube] Autoplay blocked - user interaction required');
      } else {
        console.warn('[WatchTogether:YouTube] Play failed:', err.message);
      }
    });
  }

  // Enhanced validity check for YouTube
  public isValid(): boolean {
    if (!super.isValid()) return false;

    // Must be on a watch page
    if (window.location.pathname !== '/watch') {
      return false;
    }

    return true;
  }
}

// Content script main logic
class YouTubeContentScript {
  private adapter: YouTubePlayerAdapter | null = null;
  private readonly maxRetries: number = 30;
  private isApplyingSync: boolean = false;
  private isNavigatingFromSync: boolean = false;
  private watchObserver: MutationObserver | null = null;
  private navigationObserver: MutationObserver | null = null;
  private lastUrl: string = '';
  private adaptiveSync: AdaptiveSyncController = new AdaptiveSyncController();
  private isTabVisible: boolean = !document.hidden;
  private currentVideoId: string | null = null;
  private syncCheckInterval: ReturnType<typeof setInterval> | null = null;
  private isInRoom: boolean = false;
  private isPlayingAd: boolean = false;

  constructor() {
    this.init();
  }

  // Get normalized video identifier for URL comparison
  private getVideoIdentifier(url?: string): string | null {
    try {
      const urlToCheck = url || location.href;
      const urlObj = new URL(urlToCheck);

      // YouTube video ID from ?v= parameter
      const videoId = urlObj.searchParams.get('v');
      if (videoId) {
        return `youtube:${videoId}`;
      }

      return null;
    } catch {
      return null;
    }
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
      console.log('[WatchTogether:YouTube] Not a watch page, waiting...');
      this.watchForWatchPage();
      return;
    }

    await this.initializeAdapter();
  }

  private setupVisibilityTracking(): void {
    document.addEventListener('visibilitychange', () => {
      this.isTabVisible = !document.hidden;
      console.log(`[WatchTogether:YouTube] Tab visibility changed: ${this.isTabVisible ? 'visible' : 'hidden'}`);

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
      // Validate room code format (should be 8 characters, alphanumeric)
      const cleanRoomCode = roomCode.trim().toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(cleanRoomCode)) {
        console.error('[WatchTogether:YouTube] Invalid room code format:', roomCode);
        this.showErrorNotification('Invalid Link', 'The Watch Together room code in this link is not valid.');

        // Remove invalid parameter
        urlParams.delete('wt');
        const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
        window.history.replaceState({}, '', newUrl);
        return;
      }

      console.log(`[WatchTogether:YouTube] Deep link detected - room code: ${cleanRoomCode}`);

      // Check if we're on a valid watch page
      if (!this.isWatchPage()) {
        console.warn('[WatchTogether:YouTube] Deep link on non-watch page, will process when navigating to video');
        // Don't remove the parameter yet - we'll process it when user navigates to a video
        return;
      }

      // Show notification that Watch Together is active
      this.showWatchTogetherNotification(cleanRoomCode);

      // Auto-join the room with retry logic
      this.autoJoinWithRetry(cleanRoomCode);

      // After joining, wait for the video to be ready and send initial state
      this.scheduleInitialStateSync();

      // Remove the parameter from URL to clean it up
      urlParams.delete('wt');
      const newUrl = `${window.location.pathname}${urlParams.toString() ? '?' + urlParams.toString() : ''}`;
      window.history.replaceState({}, '', newUrl);
    }
  }

  private async autoJoinWithRetry(roomCode: string, attempt: number = 1): Promise<void> {
    const maxAttempts = 3;

    try {
      console.log(`[WatchTogether:YouTube] Auto-join attempt ${attempt}/${maxAttempts} for room ${roomCode}`);

      const response = await chrome.runtime.sendMessage({
        type: 'AUTO_JOIN_ROOM',
        payload: { roomId: roomCode }
      });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to join room');
      }

      console.log(`[WatchTogether:YouTube] Successfully initiated auto-join for room ${roomCode}`);

      // Open the popup to show connection status after successful join
      setTimeout(() => {
        this.sendToBackground({
          type: 'OPEN_POPUP'
        });
      }, 500);

    } catch (error) {
      console.error(`[WatchTogether:YouTube] Auto-join attempt ${attempt} failed:`, error);

      if (attempt < maxAttempts) {
        // Retry with exponential backoff
        const delay = attempt * 1000;
        console.log(`[WatchTogether:YouTube] Retrying in ${delay}ms...`);
        setTimeout(() => {
          this.autoJoinWithRetry(roomCode, attempt + 1);
        }, delay);
      } else {
        console.error(`[WatchTogether:YouTube] Failed to auto-join after ${maxAttempts} attempts`);
        this.showErrorNotification('Connection Failed', 'Could not join the Watch Together room. Please try joining manually.');
      }
    }
  }

  private scheduleInitialStateSync(): void {
    let attempts = 0;
    const maxAttempts = 15;

    const checkAndNotify = () => {
      attempts++;

      if (!this.adapter || !this.adapter.isValid()) {
        if (attempts < maxAttempts) {
          console.log(`[WatchTogether:YouTube] Adapter not ready yet, retry ${attempts}/${maxAttempts}`);
          setTimeout(checkAndNotify, 1000);
        }
        return;
      }

      const video = this.adapter.getVideoElement();

      // Check if video is actually ready and loaded
      if (video && video.readyState >= 3 && video.duration > 0) {
        console.log(`[WatchTogether:YouTube] Joiner video ready after deep link (readyState: ${video.readyState}, duration: ${video.duration.toFixed(2)}s)`);

        // Pause our video to wait for host sync
        if (!video.paused) {
          console.log(`[WatchTogether:YouTube] Pausing video while waiting for host to start playback`);
          this.adapter.pause();
        }

        // Signal to host that we're ready
        console.log(`[WatchTogether:YouTube] Sending JOINER_READY signal to host`);
        this.sendToBackground({
          type: 'JOINER_READY'
        });
      } else if (attempts < maxAttempts) {
        console.log(`[WatchTogether:YouTube] Video not ready yet (readyState: ${video?.readyState}, duration: ${video?.duration}), retry ${attempts}/${maxAttempts}`);
        setTimeout(checkAndNotify, 1000);
      } else {
        console.warn(`[WatchTogether:YouTube] Max attempts reached, could not verify video ready state`);
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

  private showErrorNotification(title: string, message: string): void {
    // Remove any existing error notification
    const existing = document.getElementById('watch-together-error');
    if (existing) existing.remove();

    // Create error notification
    const notification = document.createElement('div');
    notification.id = 'watch-together-error';
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #ff4757, #ff6348);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(255, 71, 87, 0.4);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      max-width: 320px;
      animation: slideIn 0.3s ease-out;
    `;

    notification.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 12px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">${title}</div>
          <div style="font-size: 12px; opacity: 0.95; line-height: 1.4;">${message}</div>
        </div>
      </div>
    `;

    document.body.appendChild(notification);

    // Remove after 6 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }, 6000);
  }

  private registerTab(): void {
    this.sendToBackground({ type: 'REGISTER_TAB' });
    console.log('[WatchTogether:YouTube] Tab registered');
  }

  private isWatchPage(): boolean {
    return window.location.pathname === '/watch';
  }

  private watchForWatchPage(): void {
    let lastPath = window.location.pathname;

    this.watchObserver = new MutationObserver(() => {
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        if (this.isWatchPage() && !this.adapter) {
          console.log('[WatchTogether:YouTube] Navigated to watch page');
          this.initializeAdapter();
        } else if (!this.isWatchPage() && this.adapter) {
          console.log('[WatchTogether:YouTube] Left watch page, cleaning up');
          this.cleanup();
        }
      }
    });

    this.watchObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private setupNavigationTracking(): void {
    this.lastUrl = location.href;

    // Send initial URL to background and track video ID
    if (this.isWatchPage()) {
      this.currentVideoId = this.getVideoIdentifier();
      this.sendToBackground({
        type: 'UPDATE_CURRENT_URL',
        payload: {
          url: location.href,
          platform: 'youtube'
        }
      });
    }

    this.navigationObserver = new MutationObserver(() => {
      if (location.href !== this.lastUrl) {
        const oldUrl = this.lastUrl;
        this.lastUrl = location.href;

        // Update current video ID and background with current URL
        if (this.isWatchPage()) {
          this.currentVideoId = this.getVideoIdentifier();
          this.sendToBackground({
            type: 'UPDATE_CURRENT_URL',
            payload: {
              url: location.href,
              platform: 'youtube'
            }
          });
        }

        // Don't send navigation if we're navigating from a sync event
        if (this.isNavigatingFromSync) {
          this.isNavigatingFromSync = false;
          return;
        }

        // Only send navigation events for watch pages
        if (this.isWatchPage()) {
          console.log(`[WatchTogether:YouTube] URL changed: ${oldUrl} -> ${this.lastUrl}`);
          this.sendNavigationEvent();
        }
      }
    });

    this.navigationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private sendNavigationEvent(): void {
    // Only send navigation events if tab is visible
    if (!this.isTabVisible) {
      console.log('[WatchTogether:YouTube] Tab hidden - ignoring navigation event');
      return;
    }

    const navigationEvent: NavigationEvent = {
      url: location.href,
      platform: 'youtube',
      timestamp: Date.now()
    };

    this.sendToBackground({
      type: 'NAVIGATION_EVENT',
      payload: navigationEvent
    });

    console.log('[WatchTogether:YouTube] Sent navigation event:', location.href);
  }

  private navigateToUrl(url: string): void {
    if (location.href === url) return;

    console.log('[WatchTogether:YouTube] Navigating to:', url);
    this.isNavigatingFromSync = true;

    // Use history API for YouTube SPA navigation
    window.location.href = url;
  }

  private getVideoIdFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.searchParams.get('v');
    } catch {
      return null;
    }
  }

  private showNavigationNotification(message: string): void {
    // Remove any existing navigation notification
    const existing = document.getElementById('watch-together-nav-notification');
    if (existing) existing.remove();

    const notification = document.createElement('div');
    notification.id = 'watch-together-nav-notification';
    notification.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(102, 126, 234, 0.4);
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      max-width: 320px;
      animation: slideIn 0.3s ease-out;
    `;

    notification.innerHTML = `
      <div style="display: flex; align-items: flex-start; gap: 12px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink: 0; margin-top: 2px;">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        <div>
          <div style="font-weight: 600; margin-bottom: 4px;">Watch Together</div>
          <div style="font-size: 13px; opacity: 0.95; line-height: 1.4;">${message}</div>
        </div>
      </div>
    `;

    document.body.appendChild(notification);

    // Remove after 4 seconds
    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease-out';
      setTimeout(() => notification.remove(), 300);
    }, 4000);
  }

  private async initializeAdapter(): Promise<void> {
    console.log('[WatchTogether:YouTube] Waiting for video element...');

    let video: HTMLVideoElement | null = null;
    for (let i = 0; i < this.maxRetries; i++) {
      video = findVideoWithFallbacks(YOUTUBE_VIDEO_SELECTORS);
      if (video) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!video) {
      console.warn('[WatchTogether:YouTube] Could not find video element after retries');
      this.sendToBackground({
        type: 'ADAPTER_STATUS',
        payload: { hasAdapter: false, platform: 'youtube' }
      });
      return;
    }

    this.adapter = new YouTubePlayerAdapter();
    const success = await this.adapter.initialize();

    if (success) {
      // Set up ad detection callback
      this.adapter.setAdStateChangeCallback((isAd: boolean) => {
        this.handleAdStateChange(isAd);
      });

      this.bindPlayerEvents();
      console.log('[WatchTogether:YouTube] Adapter ready');

      // Notify background that adapter is ready
      this.sendToBackground({
        type: 'ADAPTER_STATUS',
        payload: { hasAdapter: true, platform: 'youtube' }
      });

      // If we're in a room, send JOINER_READY to trigger sync from host
      if (this.isInRoom) {
        console.log('[WatchTogether:YouTube] In room and adapter ready - sending JOINER_READY');
        setTimeout(() => {
          this.sendToBackground({
            type: 'JOINER_READY'
          });
        }, 500); // Small delay to ensure everything is initialized
      }
    } else {
      this.sendToBackground({
        type: 'ADAPTER_STATUS',
        payload: { hasAdapter: false, platform: 'youtube' }
      });
    }
  }

  private handleAdStateChange(isAd: boolean): void {
    const wasPlayingAd = this.isPlayingAd;
    this.isPlayingAd = isAd;

    if (!this.isInRoom) return;

    if (isAd && !wasPlayingAd) {
      // Ad started - notify room
      console.log('[WatchTogether:YouTube] 🎬 AD STARTED - pausing room sync');
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: {
          type: 'AD_STARTED',
          time: 0,
          timestamp: Date.now(),
          videoId: this.currentVideoId || undefined
        }
      });
    } else if (!isAd && wasPlayingAd) {
      // Ad ended - resume sync
      console.log('[WatchTogether:YouTube] ✅ AD ENDED - resuming room sync');
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: {
          type: 'AD_ENDED',
          time: this.adapter?.getCurrentTime() || 0,
          timestamp: Date.now(),
          videoId: this.currentVideoId || undefined
        }
      });
    }
  }

  private bindPlayerEvents(): void {
    if (!this.adapter) return;

    this.adapter.onPlay((time) => {
      if (this.isApplyingSync) return;
      // Ignore events during ads
      if (this.isPlayingAd) {
        console.log('[WatchTogether:YouTube] Playing ad - ignoring PLAY event');
        return;
      }
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:YouTube] Tab hidden - ignoring PLAY event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: {
          type: 'PLAY',
          time,
          timestamp: Date.now(),
          videoId: this.currentVideoId || undefined
        }
      });
    });

    this.adapter.onPause((time) => {
      if (this.isApplyingSync) return;
      // Ignore events during ads
      if (this.isPlayingAd) {
        console.log('[WatchTogether:YouTube] Playing ad - ignoring PAUSE event');
        return;
      }
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:YouTube] Tab hidden - ignoring PAUSE event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: {
          type: 'PAUSE',
          time,
          timestamp: Date.now(),
          videoId: this.currentVideoId || undefined
        }
      });
    });

    this.adapter.onSeek((time) => {
      if (this.isApplyingSync) return;
      // Ignore events during ads
      if (this.isPlayingAd) {
        console.log('[WatchTogether:YouTube] Playing ad - ignoring SEEK event');
        return;
      }
      // Only send events if tab is visible
      if (!this.isTabVisible) {
        console.log('[WatchTogether:YouTube] Tab hidden - ignoring SEEK event');
        return;
      }
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: {
          type: 'SEEK',
          time,
          timestamp: Date.now(),
          videoId: this.currentVideoId || undefined
        }
      });
    });

    // Re-bind events on recovery
    this.adapter.onRecovery(() => {
      console.log('[WatchTogether:YouTube] Adapter recovered, events still bound');
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
      case 'APPLY_SYNC': {
        const event = message.payload as SyncEvent;

        // Check if we're on a watch page before applying sync
        if (!this.isWatchPage()) {
          console.warn('[WatchTogether:YouTube] Not on watch page, ignoring APPLY_SYNC');
          sendResponse({ success: false, error: 'Not on watch page' });
          break;
        }

        // Check if adapter is ready
        if (!this.adapter || !this.adapter.isValid()) {
          console.warn('[WatchTogether:YouTube] Adapter not ready, ignoring APPLY_SYNC');
          sendResponse({ success: false, error: 'Adapter not ready' });
          break;
        }

        // CRITICAL: Check if we're watching the same video
        if (event.videoId && this.currentVideoId && event.videoId !== this.currentVideoId) {
          console.warn(`[WatchTogether:YouTube] Video mismatch - ignoring APPLY_SYNC. My video: ${this.currentVideoId}, Event video: ${event.videoId}`);
          sendResponse({ success: false, error: 'Different video' });
          break;
        }

        this.applySyncEvent(event);
        sendResponse({ success: true });
        break;
      }

      case 'NAVIGATE': {
        const nav = message.payload as NavigationEvent;
        if (nav.platform === 'youtube') {
          // Check if we're already on this video
          const targetVideoId = this.getVideoIdentifier(nav.url);
          if (targetVideoId === this.currentVideoId) {
            console.log('[WatchTogether:YouTube] Already on this video, no navigation needed');
            sendResponse({ success: true });
            break;
          }

          // Show notification that someone is changing video
          const videoId = this.getVideoIdFromUrl(nav.url);
          if (videoId) {
            this.showNavigationNotification(`Switching to new video...`);
          }
          this.navigateToUrl(nav.url);
          sendResponse({ success: true });
        } else {
          // Different platform - show notification
          this.showNavigationNotification(`Someone switched to ${nav.platform}. Please navigate there to continue watching together.`);
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
          platform: 'youtube',
          valid: this.adapter?.isValid() ?? false
        });
        break;

      case 'STATUS_UPDATE': {
        // Room status changed - manage auto-sync
        const status = message.payload as { roomId: string | null; connected: boolean };
        const wasInRoom = this.isInRoom;
        this.isInRoom = !!(status.roomId && status.connected);

        if (this.isInRoom && !wasInRoom) {
          // Just joined a room - start periodic sync monitoring
          console.log('[WatchTogether:YouTube] Joined room - starting auto-sync monitoring');
          this.startPeriodicSync();
        } else if (!this.isInRoom && wasInRoom) {
          // Left room - stop periodic sync
          console.log('[WatchTogether:YouTube] Left room - stopping auto-sync monitoring');
          this.stopPeriodicSync();
        }

        sendResponse({ success: true });
        break;
      }

      case 'START_PLAYBACK_FOR_JOINER':
        // Host received signal that joiner is ready
        // Start/resume playback to trigger sync
        if (this.adapter && this.adapter.isValid()) {
          console.log('[WatchTogether:YouTube] Starting playback to sync with joiner');
          const currentTime = this.adapter.getCurrentTime();
          const video = this.adapter.getVideoElement();

          // First, send explicit SEEK event to sync position
          console.log(`[WatchTogether:YouTube] Sending SEEK to ${currentTime.toFixed(2)}s to sync joiner position`);
          this.sendToBackground({
            type: 'PLAYER_EVENT',
            payload: {
              type: 'SEEK',
              time: currentTime,
              timestamp: Date.now(),
              videoId: this.currentVideoId || undefined
            }
          });

          // Then send PLAY event to start playback
          setTimeout(() => {
            if (this.adapter && this.adapter.isValid()) {
              console.log('[WatchTogether:YouTube] Sending PLAY to start synchronized playback');

              // Handle autoplay policy - some browsers require user interaction
              const playPromise = video?.play();
              if (playPromise) {
                playPromise.catch(err => {
                  if (err.name === 'NotAllowedError') {
                    console.warn('[WatchTogether:YouTube] Autoplay blocked - showing notification');
                    this.showErrorNotification(
                      'Click to Play',
                      'Your browser blocked autoplay. Click the video to start syncing.'
                    );
                  } else {
                    console.error('[WatchTogether:YouTube] Play failed:', err);
                  }
                });
              } else {
                this.adapter.play();
              }

              this.sendToBackground({
                type: 'PLAYER_EVENT',
                payload: {
                  type: 'PLAY',
                  time: this.adapter.getCurrentTime(),
                  timestamp: Date.now(),
                  videoId: this.currentVideoId || undefined
                }
              });
            }
          }, 200);

          // Force a third sync after 2 seconds to ensure everyone is aligned
          setTimeout(() => {
            if (this.adapter && this.adapter.isValid()) {
              const syncTime = this.adapter.getCurrentTime();
              const isPlaying = this.adapter.isPlaying();
              console.log('[WatchTogether:YouTube] Forcing final sync after 2s:', isPlaying ? 'PLAY' : 'PAUSE', 'at', syncTime.toFixed(2) + 's');

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

      case 'ERROR': {
        const error = message.payload as { code: string; message: string };
        console.error('[WatchTogether:YouTube] Received error:', error.code, error.message);

        // Show user-friendly notification for room errors
        if (error.code === 'ROOM_NOT_FOUND' || error.message.includes('does not exist')) {
          this.showErrorNotification('Room not found', 'This Watch Together room no longer exists. The host may have left or the room expired.');
        } else if (error.code === 'CONNECTION_TIMEOUT') {
          this.showErrorNotification('Connection failed', 'Could not connect to Watch Together server. Please try again.');
        } else {
          this.showErrorNotification('Error', error.message);
        }

        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  private async applySyncEvent(event: SyncEvent): Promise<void> {
    if (!this.adapter || !this.adapter.isValid()) {
      console.warn('[WatchTogether:YouTube] Cannot apply sync - adapter not valid');
      return;
    }

    const video = this.adapter.getVideoElement();
    if (!video) return;

    // Check if video is in a playable state
    if (video.readyState < 2) {
      console.warn('[WatchTogether:YouTube] Video not ready for sync (readyState:', video.readyState, ')');
      // Queue the sync to retry after buffering
      const waitForReady = () => {
        if (video.readyState >= 2) {
          this.applySyncEvent(event);
        }
      };
      video.addEventListener('canplay', waitForReady, { once: true });
      // Also set timeout to prevent infinite waiting
      setTimeout(() => {
        video.removeEventListener('canplay', waitForReady);
      }, 5000);
      return;
    }

    this.isApplyingSync = true;

    try {
      const currentTime = this.adapter.getCurrentTime();
      const isPlaying = this.adapter.isPlaying();

      switch (event.type) {
        case 'PLAY': {
          // Use adaptive sync with latency compensation for smooth playback synchronization
          const action = this.adaptiveSync.calculateCompensatedSyncAction(
            currentTime,
            event.time,
            event.timestamp,
            true // We're about to play
          );

          switch (action.type) {
            case 'adjust_speed':
              this.adaptiveSync.applySpeedAdjustment(video, action.rate);
              console.log(`[WatchTogether:YouTube] Adaptive sync: speed ${action.rate.toFixed(2)}x`);
              break;
            case 'smooth_seek':
              await this.adaptiveSync.smoothSeek(video, action.targetTime, action.duration);
              console.log(`[WatchTogether:YouTube] Adaptive sync: smooth seek to ${action.targetTime.toFixed(2)}s`);
              break;
            case 'hard_seek':
              this.adapter.seek(action.targetTime);
              console.log(`[WatchTogether:YouTube] Adaptive sync: hard seek to ${action.targetTime.toFixed(2)}s`);
              break;
            default:
              // No action needed - we're already synced
              console.log(`[WatchTogether:YouTube] Adaptive sync: in sync (no action needed)`);
              break;
          }

          this.adapter.play();
          break;
        }

        case 'PAUSE': {
          // Reset any speed adjustments when pausing
          this.adaptiveSync.resetSpeed(video);

          // For pause, no latency compensation - we want to pause at exact position
          const drift = Math.abs(currentTime - event.time) * 1000;
          if (drift > DRIFT_THRESHOLD_MS) {
            this.adapter.seek(event.time);
            console.log(`[WatchTogether:YouTube] Pause: seeked to ${event.time.toFixed(2)}s (drift: ${drift.toFixed(0)}ms)`);
          }
          this.adapter.pause();
          break;
        }

        case 'SEEK': {
          // For explicit seeks, compensate for latency if we're playing
          const compensatedTime = this.adaptiveSync.compensateForLatency(
            event.time,
            event.timestamp,
            isPlaying
          );

          const seekDrift = Math.abs(currentTime - compensatedTime) * 1000;
          if (seekDrift > 5000) {
            // Large seek - do it directly
            this.adapter.seek(compensatedTime);
            console.log(`[WatchTogether:YouTube] Seek: hard seek to ${compensatedTime.toFixed(2)}s`);
          } else if (seekDrift > 300) {
            // Medium seek - smooth it
            await this.adaptiveSync.smoothSeek(video, compensatedTime, 250);
            console.log(`[WatchTogether:YouTube] Seek: smooth seek to ${compensatedTime.toFixed(2)}s`);
          } else {
            // Small seek - direct
            this.adapter.seek(compensatedTime);
            console.log(`[WatchTogether:YouTube] Seek: micro seek to ${compensatedTime.toFixed(2)}s`);
          }
          break;
        }
      }

      // Log sync stats periodically
      const stats = this.adaptiveSync.getStats();
      if (stats.samplesCount > 0 && stats.samplesCount % 5 === 0) {
        console.log(`[WatchTogether:YouTube] Sync stats: avg latency ${stats.avgLatency.toFixed(0)}ms, clock offset ${stats.clockOffset.toFixed(0)}ms`);
      }

      console.log(`[WatchTogether:YouTube] Applied sync: ${event.type} at ${event.time.toFixed(2)}s`);
    } finally {
      setTimeout(() => {
        this.isApplyingSync = false;
      }, 200); // Reduced cooldown for faster responsiveness
    }
  }

  private startPeriodicSync(): void {
    // Stop any existing interval
    this.stopPeriodicSync();

    // Check sync status every 3 seconds
    this.syncCheckInterval = setInterval(() => {
      // Only check if we're on a watch page and adapter is ready
      if (!this.isWatchPage() || !this.adapter || !this.adapter.isValid() || !this.isTabVisible) {
        return;
      }

      // Request current room state to stay in sync
      // This will trigger a STATE_UPDATE which will apply any needed corrections
      console.log('[WatchTogether:YouTube] Periodic sync check');
    }, 3000);
  }

  private stopPeriodicSync(): void {
    if (this.syncCheckInterval) {
      clearInterval(this.syncCheckInterval);
      this.syncCheckInterval = null;
    }
  }

  private sendToBackground(message: { type: string; payload?: unknown }): void {
    try {
      // Check if extension context is still valid
      if (!chrome.runtime?.id) {
        console.log('[WatchTogether:YouTube] Extension context invalidated, cleaning up');
        this.cleanup();
        return;
      }
      chrome.runtime.sendMessage(message).catch(err => {
        // Silently ignore "Extension context invalidated" errors
        if (err.message?.includes('Extension context invalidated')) {
          this.cleanup();
          return;
        }
        console.warn('[WatchTogether:YouTube] Failed to send message:', err.message);
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
console.log('[WatchTogether:YouTube] Content script loaded');
new YouTubeContentScript();
