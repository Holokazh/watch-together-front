// ADN (Anime Digital Network) Content Script
// Handles video synchronization for animedigitalnetwork.fr

import { VideoAdapter } from '../shared/adapter';
import { SyncEvent } from '../shared/events';

class ADNAdapter implements VideoAdapter {
  private video: HTMLVideoElement | null = null;

  async initialize(): Promise<boolean> {
    try {
      // Find video element (ADN uses standard HTML5 video)
      this.video = document.querySelector('video');

      if (!this.video) {
        console.warn('[WatchTogether:ADN] No video element found');
        return false;
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

      console.log('[WatchTogether:ADN] Adapter initialized');
      return true;
    } catch (error) {
      console.error('[WatchTogether:ADN] Failed to initialize:', error);
      return false;
    }
  }

  isValid(): boolean {
    return this.video !== null && !this.video.error && this.video.readyState >= 2;
  }

  async play(): Promise<void> {
    if (!this.video) return;
    try {
      await this.video.play();
    } catch (error) {
      console.error('[WatchTogether:ADN] Play failed:', error);
    }
  }

  async pause(): Promise<void> {
    if (!this.video) return;
    this.video.pause();
  }

  async seek(time: number): Promise<void> {
    if (!this.video) return;
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
}

class ADNIntegration {
  private adapter: ADNAdapter | null = null;
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
    console.log('[WatchTogether:ADN] Initializing');

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

    this.adapter = new ADNAdapter();
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
      // ADN URLs: /video/[anime-name]/[episode-id]
      const match = location.pathname.match(/\/video\/[^/]+\/(\d+)/);
      if (match && match[1]) {
        return `adn:${match[1]}`;
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
        payload: { url: location.href, platform: 'adn' as const }
      });
    }
  }

  private observeUrlChanges(): void {
    let lastUrl = location.href;
    new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        console.log('[WatchTogether:ADN] URL changed, reinitializing');
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

      if (timeDiff > 1) {
        await this.adapter.seek(event.time);
      }

      if (event.type === 'PLAY') {
        await this.adapter.play();
      } else if (event.type === 'PAUSE') {
        await this.adapter.pause();
      } else if (event.type === 'SEEK') {
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
          console.warn(`[WatchTogether:ADN] Video mismatch - ignoring sync`);
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
    this.syncCheckInterval = setInterval(() => {
      if (!this.adapter || !this.adapter.isValid() || !this.isTabVisible) return;
      console.log('[WatchTogether:ADN] Periodic sync check');
    }, 3000);
  }

  private stopPeriodicSync(): void {
    if (this.syncCheckInterval) {
      clearInterval(this.syncCheckInterval);
      this.syncCheckInterval = null;
    }
  }

  private sendToBackground(message: any): void {
    chrome.runtime.sendMessage(message).catch((error) => {
      console.error('[WatchTogether:ADN] Failed to send message:', error);
    });
  }
}

// Initialize integration
new ADNIntegration();
