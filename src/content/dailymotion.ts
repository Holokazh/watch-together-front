// Dailymotion Content Script
// Handles video synchronization for Dailymotion

import { VideoAdapter } from '../shared/adapter';
import { SyncEvent } from '../shared/events';

class DailymotionAdapter implements VideoAdapter {
  private player: any = null;
  private videoId: string | null = null;

  async initialize(): Promise<boolean> {
    try {
      // Get video ID from URL
      this.videoId = this.extractVideoId();
      if (!this.videoId) {
        console.warn('[WatchTogether:Dailymotion] No video ID found');
        return false;
      }

      // Load Dailymotion SDK
      await this.loadDailymotionSDK();

      // Find player container
      const container = document.querySelector('#player') || document.querySelector('[id*="dailymotion"]');

      if (!container) {
        console.warn('[WatchTogether:Dailymotion] No player container found');
        return false;
      }

      // Initialize player
      // @ts-ignore - Dailymotion SDK
      this.player = window.dailymotion.createPlayer(container, {
        video: this.videoId
      });

      console.log('[WatchTogether:Dailymotion] Adapter initialized');
      return true;
    } catch (error) {
      console.error('[WatchTogether:Dailymotion] Failed to initialize:', error);
      return false;
    }
  }

  private extractVideoId(): string | null {
    const match = location.pathname.match(/\/video\/([a-z0-9]+)/i);
    return match ? match[1] : null;
  }

  private loadDailymotionSDK(): Promise<void> {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      if (window.dailymotion) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://api.dmcdn.net/all.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Dailymotion SDK'));
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
      console.error('[WatchTogether:Dailymotion] Play failed:', error);
    }
  }

  async pause(): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.pause();
    } catch (error) {
      console.error('[WatchTogether:Dailymotion] Pause failed:', error);
    }
  }

  async seek(time: number): Promise<void> {
    if (!this.player) return;
    try {
      await this.player.seek(time);
    } catch (error) {
      console.error('[WatchTogether:Dailymotion] Seek failed:', error);
    }
  }

  async getCurrentTime(): Promise<number> {
    if (!this.player) return 0;
    try {
      const time = await this.player.currentTime;
      return time || 0;
    } catch (error) {
      console.error('[WatchTogether:Dailymotion] Get time failed:', error);
      return 0;
    }
  }

  async isPaused(): Promise<boolean> {
    if (!this.player) return true;
    try {
      const paused = await this.player.paused;
      return paused !== false;
    } catch (error) {
      console.error('[WatchTogether:Dailymotion] Get paused state failed:', error);
      return true;
    }
  }

  onPlay(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.addEventListener('play', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onPause(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.addEventListener('pause', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onSeeked(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.addEventListener('seeked', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }

  onTimeUpdate(callback: (time: number) => void): void {
    if (!this.player) return;
    this.player.addEventListener('timeupdate', async () => {
      const time = await this.getCurrentTime();
      callback(time);
    });
  }
}

class DailymotionIntegration {
  private adapter: DailymotionAdapter | null = null;
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
    console.log('[WatchTogether:Dailymotion] Initializing');

    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initializeAdapter());
    } else {
      await this.initializeAdapter();
    }

    chrome.runtime.onMessage.addListener(this.handleMessage.bind(this));
  }

  private async initializeAdapter(): Promise<void> {
    await this.waitForPlayer();

    this.adapter = new DailymotionAdapter();
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

  private waitForPlayer(): Promise<void> {
    return new Promise((resolve) => {
      const checkPlayer = () => {
        const player = document.querySelector('#player') || document.querySelector('[id*="dailymotion"]');
        if (player) {
          resolve();
        } else {
          setTimeout(checkPlayer, 500);
        }
      };
      checkPlayer();
    });
  }

  private getVideoIdentifier(): string | null {
    const match = location.pathname.match(/\/video\/([a-z0-9]+)/i);
    return match ? `dailymotion:${match[1]}` : null;
  }

  private updateVideoIdentifier(): void {
    this.currentVideoId = this.getVideoIdentifier();
    if (this.currentVideoId) {
      this.sendToBackground({
        type: 'UPDATE_CURRENT_URL',
        payload: { url: location.href, platform: 'dailymotion' as const }
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
          console.warn(`[WatchTogether:Dailymotion] Video mismatch - ignoring sync`);
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
      console.log('[WatchTogether:Dailymotion] Periodic sync check');
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
      console.error('[WatchTogether:Dailymotion] Failed to send message:', error);
    });
  }
}

// Initialize integration
new DailymotionIntegration();
