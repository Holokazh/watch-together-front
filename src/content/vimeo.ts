// Vimeo Content Script
// Handles video synchronization for Vimeo

import { VideoAdapter } from '../shared/adapter';
import { SyncEvent } from '../shared/events';

class VimeoAdapter implements VideoAdapter {
  private player: any = null;
  private iframe: HTMLIFrameElement | null = null;

  async initialize(): Promise<boolean> {
    try {
      // Find Vimeo iframe
      this.iframe = document.querySelector('iframe[src*="player.vimeo.com"]');

      if (!this.iframe) {
        console.warn('[WatchTogether:Vimeo] No Vimeo player iframe found');
        return false;
      }

      // Load Vimeo Player API
      await this.loadVimeoAPI();

      // Initialize player
      // @ts-ignore - Vimeo Player API
      this.player = new window.Vimeo.Player(this.iframe);

      console.log('[WatchTogether:Vimeo] Adapter initialized');
      return true;
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Failed to initialize:', error);
      return false;
    }
  }

  private loadVimeoAPI(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      // @ts-ignore
      if (window.Vimeo && window.Vimeo.Player) {
        resolve();
        return;
      }

      // Load Vimeo Player API
      const script = document.createElement('script');
      script.src = 'https://player.vimeo.com/api/player.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Vimeo API'));
      document.head.appendChild(script);
    });
  }

  isValid(): boolean {
    return this.player !== null;
  }

  async play(): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.play();
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Play failed:', error);
    }
  }

  async pause(): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.pause();
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Pause failed:', error);
    }
  }

  async seek(time: number): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.setCurrentTime(time);
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Seek failed:', error);
    }
  }

  async getCurrentTime(): Promise<number> {
    if (!this.player) return 0;
    try {
      return await this.player.getCurrentTime();
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Get time failed:', error);
      return 0;
    }
  }

  async isPaused(): Promise<boolean> {
    if (!this.player) return true;
    try {
      return await this.player.getPaused();
    } catch (error) {
      console.error('[WatchTogether:Vimeo] Get paused state failed:', error);
      return true;
    }
  }

  onPlay(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.on('play', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onPause(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.on('pause', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onSeeked(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.on('seeked', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onTimeUpdate(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.on('timeupdate', (data: { seconds: number }) => {
      callback(data.seconds);
    });
  }
}

class VimeoIntegration {
  private adapter: VimeoAdapter | null = null;
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
    console.log('[WatchTogether:Vimeo] Initializing');

    // Listen for visibility changes
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    // Wait for page to be fully loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initializeAdapter());
    } else {
      await this.initializeAdapter();
    }

    // Set up message listener
    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
  }

  private async initializeAdapter(): Promise<void> {
    // Wait for iframe to be present
    await this.waitForIframe();

    this.adapter = new VimeoAdapter();
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

  private waitForIframe(): Promise<void> {
    return new Promise((resolve) => {
      const checkIframe = () => {
        const iframe = document.querySelector('iframe[src*="player.vimeo.com"]');
        if (iframe) {
          resolve();
        } else {
          setTimeout(checkIframe, 500);
        }
      };
      checkIframe();
    });
  }

  private getVideoIdentifier(): string | null {
    try {
      const iframe = document.querySelector('iframe[src*="player.vimeo.com"]') as HTMLIFrameElement;
      if (!iframe) return null;

      const match = iframe.src.match(/vimeo\.com\/video\/(\d+)/);
      if (match && match[1]) {
        return `vimeo:${match[1]}`;
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
        payload: { url: location.href, platform: 'vimeo' as const }
      });
    }
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
          console.warn(`[WatchTogether:Vimeo] Video mismatch - ignoring sync`);
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
      console.log('[WatchTogether:Vimeo] Periodic sync check');
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
      console.error('[WatchTogether:Vimeo] Failed to send message:', error);
    });
  }
}

// Initialize integration
new VimeoIntegration();
