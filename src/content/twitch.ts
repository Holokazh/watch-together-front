// Twitch Content Script
// Handles video synchronization for Twitch (VODs and replays)
// Note: Live streams cannot be synchronized due to variable latency

import { VideoAdapter } from '../shared/adapter';
import { SyncEvent } from '../shared/events';

class TwitchAdapter implements VideoAdapter {
  private video: HTMLVideoElement | null = null;
  private isLiveStream = false;

  async initialize(): Promise<boolean> {
    try {
      // Find video element
      this.video = document.querySelector('video');

      if (!this.video) {
        console.warn('[WatchTogether:Twitch] No video element found');
        return false;
      }

      // Detect if it's a live stream
      this.isLiveStream = this.detectLiveStream();

      if (this.isLiveStream) {
        console.log('[WatchTogether:Twitch] Live stream detected - limited sync support');
      }

      // Wait for video to be ready
      if (this.video.readyState < 2) {
        await new Promise<void>((resolve) => {
          const handler = () => {
            this.video!.removeEventListener('loadedmetadata', handler);
            resolve();
          };
          this.video!.addEventListener('loadedmetadata', handler);
        });
      }

      console.log('[WatchTogether:Twitch] Adapter initialized');
      return true;
    } catch (error) {
      console.error('[WatchTogether:Twitch] Failed to initialize:', error);
      return false;
    }
  }

  private detectLiveStream(): boolean {
    // Check if we're on a channel page (live stream) vs. video page (VOD)
    const isChannelPage = !location.pathname.includes('/videos/');

    // Also check for "LIVE" indicator in DOM
    const liveIndicator = document.querySelector('[data-a-target="player-overlay-live-indicator"]') ||
                          document.querySelector('[class*="live-indicator"]');

    return isChannelPage || !!liveIndicator;
  }

  isValid(): boolean {
    return this.video !== null && !this.video.error && this.video.readyState >= 2;
  }

  async play(): Promise<void> {
    if (!this.video) return;
    try {
      await this.video.play();
    } catch (error) {
      console.error('[WatchTogether:Twitch] Play failed:', error);
    }
  }

  async pause(): Promise<void> {
    if (!this.video) return;
    this.video.pause();
  }

  async seek(time: number): Promise<void> {
    if (!this.video) return;

    // Don't allow seeking on live streams
    if (this.isLiveStream) {
      console.warn('[WatchTogether:Twitch] Cannot seek on live stream');
      return;
    }

    this.video.currentTime = time;
  }

  async getCurrentTime(): Promise<number> {
    if (!this.video) return 0;
    return this.video.currentTime;
  }

  async isPaused(): Promise<boolean> {
    if (!this.video) return true;
    return this.video.paused;
  }

  onPlay(callback: (time: number) => void): void {
    if (!this.video) return;
    this.video.addEventListener('play', () => {
      callback(this.video!.currentTime);
    });
  }

  onPause(callback: (time: number) => void): void {
    if (!this.video) return;
    this.video.addEventListener('pause', () => {
      callback(this.video!.currentTime);
    });
  }

  onSeeked(callback: (time: number) => void): void {
    if (!this.video) return;
    if (this.isLiveStream) return; // Don't track seeks on live streams

    this.video.addEventListener('seeked', () => {
      callback(this.video!.currentTime);
    });
  }

  onTimeUpdate(callback: (time: number) => void): void {
    if (!this.video) return;
    this.video.addEventListener('timeupdate', () => {
      callback(this.video!.currentTime);
    });
  }

  getIsLiveStream(): boolean {
    return this.isLiveStream;
  }
}

class TwitchIntegration {
  private adapter: TwitchAdapter | null = null;
  private isApplyingSync = false;
  private isTabVisible = true;
  private syncCheckInterval: ReturnType<typeof setInterval> | null = null;
  private isInRoom = false;
  private currentVideoId: string | null = null;

  constructor() {
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.initialize();
  }

  private async initialize(): Promise<void> {
    console.log('[WatchTogether:Twitch] Initializing');

    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initializeAdapter());
    } else {
      await this.initializeAdapter();
    }

    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));

    // Watch for URL changes (SPA navigation)
    this.observeUrlChanges();
  }

  private async initializeAdapter(): Promise<void> {
    await this.waitForVideo();

    this.adapter = new TwitchAdapter();
    const success = await this.adapter.initialize();

    if (success) {
      this.bindPlayerEvents();
      this.updateVideoIdentifier();

      if (this.isInRoom) {
        setTimeout(() => {
          this.sendToBackground({ type: 'JOINER_READY' });
        }, 500);
      }
    }
  }

  private waitForVideo(): Promise<void> {
    return new Promise((resolve) => {
      const checkVideo = () => {
        const video = document.querySelector('video');
        if (video) {
          resolve();
        } else {
          setTimeout(checkVideo, 500);
        }
      };
      checkVideo();
    });
  }

  private getVideoIdentifier(): string | null {
    try {
      // For VODs: /videos/[videoId]
      const vodMatch = location.pathname.match(/\/videos\/(\d+)/);
      if (vodMatch && vodMatch[1]) {
        return `twitch:vod:${vodMatch[1]}`;
      }

      // For clips: /[channel]/clip/[clipSlug]
      const clipMatch = location.pathname.match(/\/clip\/([^/]+)/);
      if (clipMatch && clipMatch[1]) {
        return `twitch:clip:${clipMatch[1]}`;
      }

      // For live streams: /[channel]
      const channelMatch = location.pathname.match(/^\/([^/]+)/);
      if (channelMatch && channelMatch[1]) {
        // Use channel + current timestamp for live streams
        return `twitch:live:${channelMatch[1]}:${Date.now()}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  private updateVideoIdentifier(): void {
    this.currentVideoId = this.getVideoIdentifier();
    if (this.currentVideoId) {
      this.sendToBackground({
        type: 'UPDATE_CURRENT_URL',
        payload: { url: location.href, platform: 'twitch' as const }
      });
    }
  }

  private observeUrlChanges(): void {
    let lastUrl = location.href;
    new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[WatchTogether:Twitch] URL changed, reinitializing');
        this.adapter = null;
        setTimeout(() => this.initializeAdapter(), 1000);
      }
    }).observe(document, { subtree: true, childList: true });
  }

  private bindPlayerEvents(): void {
    if (!this.adapter) return;

    this.adapter.onPlay((time) => {
      if (this.isApplyingSync || !this.isTabVisible) return;
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
      if (this.isApplyingSync || !this.isTabVisible) return;
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

    this.adapter.onSeeked((time) => {
      if (this.isApplyingSync || !this.isTabVisible) return;
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
  }

  private handleVisibilityChange(): void {
    this.isTabVisible = !document.hidden;
  }

  private async applySyncEvent(event: SyncEvent): Promise<void> {
    if (!this.adapter) return;

    this.isApplyingSync = true;

    try {
      const currentTime = await this.adapter.getCurrentTime();
      const timeDiff = Math.abs(currentTime - event.time);

      // For VODs, sync time if difference is significant
      if (timeDiff > 2 && !this.adapter.getIsLiveStream()) {
        await this.adapter.seek(event.time);
      }

      if (event.type === 'PLAY') {
        await this.adapter.play();
      } else if (event.type === 'PAUSE') {
        await this.adapter.pause();
      } else if (event.type === 'SEEK' && !this.adapter.getIsLiveStream()) {
        await this.adapter.seek(event.time);
      }
    } finally {
      setTimeout(() => {
        this.isApplyingSync = false;
      }, 1000);
    }
  }

  private handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void): boolean {
    switch (message.type) {
      case 'APPLY_SYNC': {
        const event = message.payload as SyncEvent;

        if (!this.adapter || !this.adapter.isValid()) {
          sendResponse({ success: false, error: 'Adapter not ready' });
          break;
        }

        if (event.videoId && this.currentVideoId && event.videoId !== this.currentVideoId) {
          console.warn(`[WatchTogether:Twitch] Video mismatch - ignoring sync`);
          sendResponse({ success: false, error: 'Different video' });
          break;
        }

        this.applySyncEvent(event);
        sendResponse({ success: true });
        break;
      }

      case 'STATUS_UPDATE': {
        const status = message.payload as { roomId: string | null; connected: boolean };
        const wasInRoom = this.isInRoom;
        this.isInRoom = !!(status.roomId && status.connected);

        if (this.isInRoom && !wasInRoom) {
          this.startPeriodicSync();
        } else if (!this.isInRoom && wasInRoom) {
          this.stopPeriodicSync();
        }

        sendResponse({ success: true });
        break;
      }

      case 'GET_STATE': {
        if (!this.adapter) {
          sendResponse({ success: false, error: 'Adapter not ready' });
          break;
        }

        Promise.all([this.adapter.getCurrentTime(), this.adapter.isPaused()])
          .then(([time, paused]) => {
            sendResponse({ success: true, time, paused });
          });
        return true;
      }
    }

    return false;
  }

  private startPeriodicSync(): void {
    this.stopPeriodicSync();
    // Only enable periodic sync for VODs, not live streams
    if (this.adapter && !this.adapter.getIsLiveStream()) {
      this.syncCheckInterval = setInterval(() => {
        if (!this.adapter || !this.adapter.isValid() || !this.isTabVisible) return;
        console.log('[WatchTogether:Twitch] Periodic sync check');
      }, 3000);
    }
  }

  private stopPeriodicSync(): void {
    if (this.syncCheckInterval) {
      clearInterval(this.syncCheckInterval);
      this.syncCheckInterval = null;
    }
  }

  private sendToBackground(message: any): void {
    chrome.runtime.sendMessage(message).catch((error) => {
      console.error('[WatchTogether:Twitch] Failed to send message:', error);
    });
  }
}

// Initialize integration
new TwitchIntegration();
