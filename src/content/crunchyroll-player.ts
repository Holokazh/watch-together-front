// Crunchyroll Player Iframe Adapter for Watch Together
// This script runs inside the Crunchyroll Vilos player iframe (static.crunchyroll.com)
// It directly accesses the video element and communicates with the parent page

import { BasePlayerAdapter, findVideoWithFallbacks, isValidVideoElement } from './player.interface.js';
import type { SyncEvent } from '../shared/events.js';
import { DRIFT_THRESHOLD_MS } from '../shared/events.js';

// Video selectors for the Vilos player iframe
const VILOS_VIDEO_SELECTORS = [
  '#player0',
  'video[id="player0"]',
  '#velocity-player-package video',
  'video[src^="blob:"]',
  'video'
];

class CrunchyrollIframePlayerAdapter extends BasePlayerAdapter {
  protected getPlatformName(): string {
    return 'Crunchyroll-Iframe';
  }

  protected findVideoElement(): HTMLVideoElement | null {
    return findVideoWithFallbacks(VILOS_VIDEO_SELECTORS);
  }

  protected setupPlatformSpecificListeners(): void {
    // No additional listeners needed in iframe context
  }

  protected cleanupPlatformSpecificListeners(): void {
    // No cleanup needed
  }

  // Override play with retry logic
  public play(): void {
    if (!this.videoElement || this.isDestroyed) return;
    this.setRemoteOrigin();

    this.videoElement.play().catch(err => {
      if (err.name === 'NotAllowedError') {
        console.warn('[WatchTogether:CR-Iframe] Autoplay blocked - user interaction required');
      } else if (err.name === 'AbortError') {
        console.log('[WatchTogether:CR-Iframe] Play aborted, retrying...');
        setTimeout(() => {
          if (this.videoElement && !this.isDestroyed) {
            this.videoElement.play().catch(() => {});
          }
        }, 200);
      } else {
        console.warn('[WatchTogether:CR-Iframe] Play failed:', err.message);
      }
    });
  }

  public isValid(): boolean {
    return super.isValid();
  }
}

// Content script for Crunchyroll player iframe
class CrunchyrollIframeContentScript {
  private adapter: CrunchyrollIframePlayerAdapter | null = null;
  private readonly maxRetries: number = 30;
  private isApplyingSync: boolean = false;

  constructor() {
    this.init();
  }

  private async init(): Promise<void> {
    // Check if we're in the Vilos player iframe
    if (!this.isVilosPlayerFrame()) {
      console.log('[WatchTogether:CR-Iframe] Not the Vilos player iframe, skipping');
      return;
    }

    console.log('[WatchTogether:CR-Iframe] Detected Vilos player iframe');
    await this.initializeAdapter();
    this.setupMessageHandling();
  }

  private isVilosPlayerFrame(): boolean {
    // Check for Vilos player indicators
    return (
      document.getElementById('vilos') !== null ||
      document.getElementById('player0') !== null ||
      document.getElementById('velocity-player-package') !== null ||
      document.querySelector('video[src^="blob:"]') !== null
    );
  }

  private async initializeAdapter(): Promise<void> {
    console.log('[WatchTogether:CR-Iframe] Waiting for video element...');

    let video: HTMLVideoElement | null = null;

    for (let i = 0; i < this.maxRetries; i++) {
      video = findVideoWithFallbacks(VILOS_VIDEO_SELECTORS);

      if (video && isValidVideoElement(video)) {
        console.log('[WatchTogether:CR-Iframe] Found video element:', {
          id: video.id,
          src: video.src?.substring(0, 50),
          readyState: video.readyState,
          duration: video.duration
        });
        break;
      }

      // Log progress every 5 attempts
      if (i % 5 === 0) {
        const allVideos = document.querySelectorAll('video');
        console.log(`[WatchTogether:CR-Iframe] Attempt ${i}, found ${allVideos.length} video(s)`);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (!video) {
      console.warn('[WatchTogether:CR-Iframe] Could not find video element after retries');
      return;
    }

    this.adapter = new CrunchyrollIframePlayerAdapter();
    const success = await this.adapter.initialize();

    if (success) {
      this.bindPlayerEvents();
      console.log('[WatchTogether:CR-Iframe] Adapter ready');
    }
  }

  private bindPlayerEvents(): void {
    if (!this.adapter) return;

    this.adapter.onPlay((time) => {
      if (this.isApplyingSync) return;
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'PLAY', time, timestamp: Date.now() }
      });
    });

    this.adapter.onPause((time) => {
      if (this.isApplyingSync) return;
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'PAUSE', time, timestamp: Date.now() }
      });
    });

    this.adapter.onSeek((time) => {
      if (this.isApplyingSync) return;
      this.sendToBackground({
        type: 'PLAYER_EVENT',
        payload: { type: 'SEEK', time, timestamp: Date.now() }
      });
    });

    this.adapter.onRecovery(() => {
      console.log('[WatchTogether:CR-Iframe] Adapter recovered');
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
          platform: 'crunchyroll-iframe',
          valid: this.adapter?.isValid() ?? false
        });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown message type' });
    }
  }

  private applySyncEvent(event: SyncEvent): void {
    if (!this.adapter || !this.adapter.isValid()) {
      console.warn('[WatchTogether:CR-Iframe] Cannot apply sync - adapter not valid');
      return;
    }

    this.isApplyingSync = true;

    try {
      const currentTime = this.adapter.getCurrentTime();
      const drift = Math.abs(currentTime - event.time) * 1000;

      switch (event.type) {
        case 'PLAY':
          if (drift > DRIFT_THRESHOLD_MS) {
            this.adapter.seek(event.time);
          }
          this.adapter.play();
          break;

        case 'PAUSE':
          if (drift > DRIFT_THRESHOLD_MS) {
            this.adapter.seek(event.time);
          }
          this.adapter.pause();
          break;

        case 'SEEK':
          this.adapter.seek(event.time);
          break;
      }

      console.log(`[WatchTogether:CR-Iframe] Applied sync: ${event.type} at ${event.time.toFixed(2)}s`);
    } finally {
      setTimeout(() => {
        this.isApplyingSync = false;
      }, 300);
    }
  }

  private sendToBackground(message: { type: string; payload?: unknown }): void {
    chrome.runtime.sendMessage(message).catch(err => {
      console.warn('[WatchTogether:CR-Iframe] Failed to send message:', err.message);
    });
  }
}

// Initialize content script
console.log('[WatchTogether:CR-Iframe] Content script loaded in iframe');
new CrunchyrollIframeContentScript();
