// Background Service Worker for Watch Together
// Handles WebSocket connection, session persistence, and message routing

import type {
  ClientMessage,
  ServerMessage,
  SyncEvent,
  NavigationEvent,
  UserInfo,
  CreateRoomMessage,
  JoinRoomMessage,
  LeaveRoomMessage,
  SyncEventMessage,
  NavigateMessage,
  RequestStateMessage,
  StateResponseMessage,
  KickUserMessage,
  SetPermissionMessage,
  SetNameMessage,
  GetUsersMessage,
  JoinerReadyMessage,
} from '../shared/events.js';

import {
  generateUserId,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS
} from '../shared/events.js';

// WebSocket server URL
const WS_SERVER_URL = 'ws://watch-together-backend-production.up.railway.app';

// Global session state (persists across all tabs)
interface SessionState {
  oderId: string;
  socket: WebSocket | null;
  roomId: string | null;
  isHost: boolean;
  userCount: number;
  users: UserInfo[];
  connected: boolean;
  reconnectAttempts: number;
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  userName: string;
  canControl: boolean;
  isReconnecting: boolean;
  lastSuccessfulConnection: number;
  pendingMessages: ClientMessage[];
  connectionId: string;
  currentUrl: string | null;
  currentPlatform: 'youtube' | 'netflix' | 'crunchyroll' | null;
}

// Single global session shared across all tabs
let session: SessionState = {
  oderId: generateUserId(),
  socket: null,
  roomId: null,
  isHost: false,
  userCount: 0,
  users: [],
  connected: false,
  reconnectAttempts: 0,
  heartbeatInterval: null,
  userName: '',
  canControl: true,
  isReconnecting: false,
  lastSuccessfulConnection: 0,
  pendingMessages: [],
  connectionId: crypto.randomUUID(),
  currentUrl: null,
  currentPlatform: null
};

// Track active tabs on supported sites
const activeTabs = new Set<number>();

// Track tab states (visible/hidden, platform)
interface TabState {
  tabId: number;
  visible: boolean;
  platform: 'youtube' | 'netflix' | 'crunchyroll' | null;
  hasAdapter: boolean;
  lastActivity: number;
}

const tabStates = new Map<number, TabState>();

// Track pending operations to prevent race conditions
interface PendingOperation {
  type: 'CREATE_ROOM' | 'JOIN_ROOM' | 'LEAVE_ROOM';
  timestamp: number;
  roomId?: string;
}

let pendingOperation: PendingOperation | null = null;

// Lock for room operations
function acquireRoomLock(operation: PendingOperation): boolean {
  // Check if there's already a pending operation
  if (pendingOperation) {
    const age = Date.now() - pendingOperation.timestamp;
    // If operation is older than 5s, assume it's stuck and clear it
    if (age > 5000) {
      console.warn('[WatchTogether] Clearing stale operation:', pendingOperation.type);
      pendingOperation = null;
    } else {
      console.warn('[WatchTogether] Operation already in progress:', pendingOperation.type);
      return false;
    }
  }

  pendingOperation = operation;
  return true;
}

function releaseRoomLock(): void {
  pendingOperation = null;
}

// Get the primary (most active) tab
function getPrimaryTab(): number | null {
  const visibleTabs = Array.from(tabStates.values())
    .filter(state => state.visible && state.hasAdapter)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  if (visibleTabs.length > 0) {
    return visibleTabs[0].tabId;
  }

  // Fallback to any tab with adapter
  const tabsWithAdapter = Array.from(tabStates.values())
    .filter(state => state.hasAdapter)
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return tabsWithAdapter.length > 0 ? tabsWithAdapter[0].tabId : null;
}

// Load session state from storage on startup
async function loadStoredSession(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(['userName', 'lastRoomId', 'lastConnectionTime']);
    if (result.userName) {
      session.userName = result.userName;
      console.log('[WatchTogether] Loaded username:', session.userName);
    }

    // Auto-rejoin recent room if less than 30 minutes old
    if (result.lastRoomId && result.lastConnectionTime) {
      const age = Date.now() - result.lastConnectionTime;
      if (age < 30 * 60 * 1000) { // 30 minutes
        console.log(`[WatchTogether] Found recent room ${result.lastRoomId} (${Math.round(age / 1000)}s ago)`);
        // We'll auto-rejoin when a tab connects
      } else {
        // Clear stale room data
        chrome.storage.local.remove(['lastRoomId', 'lastConnectionTime']);
      }
    }
  } catch (e) {
    console.error('[WatchTogether] Failed to load session:', e);
  }
}

// Save session state to storage
async function saveSessionState(): Promise<void> {
  try {
    const data: Record<string, unknown> = {
      userName: session.userName
    };

    if (session.roomId) {
      data.lastRoomId = session.roomId;
      data.lastConnectionTime = Date.now();
    }

    await chrome.storage.local.set(data);
  } catch (e) {
    console.error('[WatchTogether] Failed to save session:', e);
  }
}

// Initialize on service worker start
loadStoredSession();

// Initialize WebSocket connection with enhanced error handling
function connect(): void {
  if (session.socket?.readyState === WebSocket.OPEN) {
    console.log('[WatchTogether] Already connected');
    return;
  }

  if (session.socket?.readyState === WebSocket.CONNECTING) {
    console.log('[WatchTogether] Connection already in progress');
    return;
  }

  console.log('[WatchTogether] Connecting to server:', WS_SERVER_URL);

  try {
    session.socket = new WebSocket(WS_SERVER_URL);
    const connectionAttemptId = session.connectionId;

    // Connection timeout - if not connected within 10s, consider it failed
    const connectionTimeout = setTimeout(() => {
      if (session.socket?.readyState === WebSocket.CONNECTING && connectionAttemptId === session.connectionId) {
        console.error('[WatchTogether] Connection timeout - closing socket');
        session.socket?.close();
        handleConnectionFailure('Connection timeout');
      }
    }, 10000);

    session.socket.onopen = () => {
      clearTimeout(connectionTimeout);
      console.log('[WatchTogether] Connected to server');
      session.connected = true;
      session.reconnectAttempts = 0;
      session.isReconnecting = false;
      session.lastSuccessfulConnection = Date.now();

      // Send pending messages
      flushPendingMessages();

      // Rejoin room if we were in one (after reconnection)
      if (session.roomId && session.isReconnecting) {
        console.log('[WatchTogether] Reconnected - rejoining room:', session.roomId);
        const rejoinMsg: JoinRoomMessage = {
          type: 'JOIN_ROOM',
          roomId: session.roomId,
          userId: session.oderId,
          userName: session.userName
        };
        sendMessage(rejoinMsg);
      }

      startHeartbeat();
      broadcastStatusToAllTabs();
    };

    session.socket.onclose = (event) => {
      clearTimeout(connectionTimeout);

      console.log('[WatchTogether] Disconnected:', event.code, event.reason);
      session.connected = false;
      session.socket = null;
      stopHeartbeat();
      broadcastStatusToAllTabs();

      // Don't reconnect if intentional close (code 1000) or if we weren't in a room
      if (event.code === 1000 || !session.roomId) {
        console.log('[WatchTogether] Clean disconnect, not reconnecting');
        return;
      }

      // Attempt reconnection if we were in a room
      if (session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        session.reconnectAttempts++;
        session.isReconnecting = true;

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s
        const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, session.reconnectAttempts - 1), 30000);

        console.log(`[WatchTogether] Reconnect attempt ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

        // Notify user of reconnection attempt
        forwardToAllTabs({
          type: 'CONNECTION_STATUS',
          payload: {
            status: 'reconnecting',
            attempt: session.reconnectAttempts,
            maxAttempts: MAX_RECONNECT_ATTEMPTS
          }
        });

        setTimeout(() => connect(), delay);
      } else {
        console.error('[WatchTogether] Max reconnection attempts reached');
        session.isReconnecting = false;

        // Notify user of permanent disconnection
        forwardToAllTabs({
          type: 'CONNECTION_STATUS',
          payload: {
            status: 'failed',
            message: 'Could not reconnect to server. Please reload the page.'
          }
        });

        // Clear room state
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
        broadcastStatusToAllTabs();
      }
    };

    session.socket.onerror = (error) => {
      console.error('[WatchTogether] WebSocket error:', error);
    };

    session.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        handleServerMessage(message);
      } catch (e) {
        console.error('[WatchTogether] Failed to parse message:', e);
      }
    };
  } catch (e) {
    console.error('[WatchTogether] Failed to connect:', e);
    handleConnectionFailure('Failed to initialize connection');
  }
}

// Handle connection failures
function handleConnectionFailure(reason: string): void {
  console.error('[WatchTogether] Connection failed:', reason);
  session.connected = false;
  session.socket = null;
  stopHeartbeat();

  if (session.roomId && session.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    session.reconnectAttempts++;
    session.isReconnecting = true;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(2, session.reconnectAttempts - 1), 30000);

    console.log(`[WatchTogether] Will retry connection in ${delay}ms`);
    setTimeout(() => connect(), delay);
  }

  broadcastStatusToAllTabs();
}

// Flush pending messages after reconnection
function flushPendingMessages(): void {
  if (session.pendingMessages.length === 0) return;

  console.log(`[WatchTogether] Flushing ${session.pendingMessages.length} pending messages`);
  const messages = [...session.pendingMessages];
  session.pendingMessages = [];

  for (const message of messages) {
    sendMessage(message);
  }
}

function disconnect(): void {
  if (session.socket) {
    session.socket.close(1000, 'User requested disconnect');
    session.socket = null;
  }
  session.connected = false;
  session.roomId = null;
  session.isHost = false;
  session.userCount = 0;
  session.users = [];
  stopHeartbeat();
  broadcastStatusToAllTabs();
}

function startHeartbeat(): void {
  stopHeartbeat();
  session.heartbeatInterval = setInterval(() => {
    sendMessage({ type: 'HEARTBEAT', userId: session.oderId });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (session.heartbeatInterval) {
    clearInterval(session.heartbeatInterval);
    session.heartbeatInterval = null;
  }
}

// Send message to server with queuing support
function sendMessage(message: ClientMessage): void {
  if (session.socket?.readyState === WebSocket.OPEN) {
    try {
      session.socket.send(JSON.stringify(message));
    } catch (e) {
      console.error('[WatchTogether] Failed to send message:', e);
      // If send fails and we're reconnecting, queue it
      if (session.isReconnecting && shouldQueueMessage(message)) {
        queueMessage(message);
      }
    }
  } else {
    console.warn('[WatchTogether] Cannot send - not connected');

    // Queue important messages during reconnection
    if (session.isReconnecting && shouldQueueMessage(message)) {
      queueMessage(message);
    } else if (!session.connected && !session.isReconnecting) {
      // If not connected and not reconnecting, try to connect
      console.log('[WatchTogether] Attempting to connect to send message');
      connect();
      // Queue this message to send after connection
      if (shouldQueueMessage(message)) {
        queueMessage(message);
      }
    }
  }
}

// Determine if a message should be queued during disconnection
function shouldQueueMessage(message: ClientMessage): boolean {
  // Don't queue heartbeats or state responses (they're time-sensitive)
  if (message.type === 'HEARTBEAT' || message.type === 'STATE_RESPONSE') {
    return false;
  }
  // Queue everything else (room operations, sync events, etc.)
  return true;
}

// Queue a message for sending after reconnection
function queueMessage(message: ClientMessage): void {
  // Avoid duplicates - check if similar message already queued
  const isDuplicate = session.pendingMessages.some(
    m => m.type === message.type && JSON.stringify(m) === JSON.stringify(message)
  );

  if (!isDuplicate) {
    session.pendingMessages.push(message);
    console.log(`[WatchTogether] Queued message: ${message.type} (${session.pendingMessages.length} pending)`);
  }

  // Limit queue size to prevent memory issues
  if (session.pendingMessages.length > 50) {
    session.pendingMessages.shift(); // Remove oldest
    console.warn('[WatchTogether] Message queue full, dropping oldest message');
  }
}

// Handle messages from server
function handleServerMessage(message: ServerMessage): void {
  console.log('[WatchTogether] Received:', message.type);

  switch (message.type) {
    case 'ROOM_CREATED':
      session.oderId = message.oderId; // Use server-assigned ID
      session.roomId = message.roomId;
      session.isHost = message.isHost;
      session.userCount = 1;
      session.users = [{
        oderId: session.oderId,
        name: session.userName || 'You',
        canControl: true,
        isHost: true
      }];
      console.log(`[WatchTogether] Created room ${session.roomId}, my ID: ${session.oderId}`);
      releaseRoomLock();
      saveSessionState();
      broadcastStatusToAllTabs();
      break;

    case 'ROOM_JOINED':
      session.oderId = message.oderId; // Use server-assigned ID
      session.roomId = message.roomId;
      session.isHost = message.isHost;
      session.userCount = message.userCount;
      session.users = message.users;

      // Set canControl based on our user info in the users list
      const myUser = message.users.find(u => u.oderId === message.oderId);
      if (myUser) {
        session.canControl = myUser.canControl;
      }

      console.log(`[WatchTogether] Joined room ${session.roomId}, my ID: ${session.oderId}, canControl: ${session.canControl}`);
      releaseRoomLock();
      saveSessionState();
      broadcastStatusToAllTabs();
      break;

    case 'ROOM_LEFT':
      session.roomId = null;
      session.isHost = false;
      session.userCount = 0;
      session.users = [];
      releaseRoomLock();
      // Clear saved room
      chrome.storage.local.remove(['lastRoomId', 'lastConnectionTime']);
      broadcastStatusToAllTabs();
      break;

    case 'SYNC_EVENT':
      // Don't apply sync events from ourselves
      if (message.oderId === session.oderId) {
        console.log('[WatchTogether] Ignoring own SYNC_EVENT');
        break;
      }
      console.log(`[WatchTogether] Received SYNC_EVENT from ${message.oderId}:`, message.event.type, 'at', message.event.time.toFixed(2));

      // Only forward if we have a current URL/platform tracked
      // Content scripts will validate URL match before applying
      forwardToAllTabs({
        type: 'APPLY_SYNC',
        payload: message.event
      });
      break;

    case 'NAVIGATE':
      // Don't apply navigation events from ourselves
      if (message.oderId === session.oderId) {
        console.log('[WatchTogether] Ignoring own NAVIGATE');
        break;
      }
      console.log(`[WatchTogether] Received NAVIGATE to ${message.navigation.url} from ${message.oderId}`);

      // Update our current URL/platform when someone navigates
      // This helps us track if we're in sync
      session.currentUrl = message.navigation.url;
      session.currentPlatform = message.navigation.platform;

      forwardToAllTabs({
        type: 'NAVIGATE',
        payload: message.navigation
      });
      break;

    case 'STATE_REQUEST':
      requestPlayerState();
      break;

    case 'JOINER_READY_NOTIFICATION':
      // A joiner is ready for sync - send them our current playback state
      console.log(`[WatchTogether] Joiner ${message.joinerUserId} is ready - sending sync`);
      forwardToAllTabs({
        type: 'START_PLAYBACK_FOR_JOINER',
        payload: { joinerUserId: message.joinerUserId }
      });
      break;

    case 'STATE_UPDATE':
      const syncEvent: SyncEvent = {
        type: message.isPlaying ? 'PLAY' : 'PAUSE',
        time: message.currentTime,
        timestamp: Date.now()
      };
      forwardToAllTabs({
        type: 'APPLY_SYNC',
        payload: syncEvent
      });
      break;

    case 'USER_JOINED':
      session.userCount = message.userCount;
      session.users = message.users;
      console.log(`[WatchTogether] ${message.userName} joined`);
      broadcastStatusToAllTabs();

      // If we're the host and someone joined, send current state to sync them
      if (session.isHost) {
        console.log('[WatchTogether] Host requesting state to sync new user');
        requestPlayerState();
      }
      break;

    case 'USER_LEFT':
      session.userCount = message.userCount;
      session.users = message.users;
      if (message.newHostId === session.oderId) {
        session.isHost = true;
        console.log('[WatchTogether] You are now the host');
      }
      broadcastStatusToAllTabs();
      break;

    case 'USER_KICKED':
      console.log('[WatchTogether] USER_KICKED received:', message.oderId, 'my id:', session.oderId);
      if (message.oderId === session.oderId) {
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
        console.log('[WatchTogether] You were kicked from the room, broadcasting...');
        broadcastStatusToAllTabs();
        forwardToAllTabs({
          type: 'KICKED',
          payload: { reason: message.reason }
        });
        console.log('[WatchTogether] KICKED message forwarded to all tabs');
      } else {
        console.log('[WatchTogether] USER_KICKED for different user, ignoring');
      }
      break;

    case 'USERS_LIST':
      session.users = message.users;
      const me = message.users.find(u => u.oderId === session.oderId);
      if (me) {
        session.canControl = me.canControl;
        session.isHost = me.isHost;
      }
      broadcastStatusToAllTabs();
      break;

    case 'PERMISSION_CHANGED':
      if (message.oderId === session.oderId) {
        session.canControl = message.canControl;
        console.log(`[WatchTogether] Your control permission: ${message.canControl}`);
      }
      broadcastStatusToAllTabs();
      break;

    case 'ERROR':
      console.error(`[WatchTogether] Server error:`, message.code, message.message);

      // Release any pending room operation lock
      releaseRoomLock();

      // If room doesn't exist, clear session
      if (message.code === 'ROOM_NOT_FOUND' || message.message.includes('does not exist')) {
        console.log('[WatchTogether] Room not found, clearing session');
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
        broadcastStatusToAllTabs();
      }

      forwardToAllTabs({
        type: 'ERROR',
        payload: { code: message.code, message: message.message }
      });
      break;

    case 'HEARTBEAT_ACK':
      break;

    case 'JOINER_READY_NOTIFICATION':
      // A joiner has signaled they're ready - host should start playback
      if (session.isHost) {
        console.log('[WatchTogether] Joiner is ready, host triggering playback to sync');
        forwardToAllTabs({
          type: 'START_PLAYBACK_FOR_JOINER'
        });
      }
      break;
  }
}

// Forward message to all active tabs and popup
async function forwardToAllTabs(message: { type: string; payload?: unknown }): Promise<void> {
  const deadTabs: number[] = [];

  // Send to content scripts in active tabs
  for (const tabId of activeTabs) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      // Mark for removal if tab is dead
      deadTabs.push(tabId);
    }
  }

  // Clean up dead tabs
  for (const tabId of deadTabs) {
    activeTabs.delete(tabId);
    tabStates.delete(tabId);
    console.log(`[WatchTogether] Removed dead tab ${tabId}`);
  }

  // Also broadcast to popup (and any other extension contexts)
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // Popup might not be open, ignore error
  }
}

// Request current player state from primary tab
async function requestPlayerState(): Promise<void> {
  // Try primary tab first (visible tab with adapter)
  const primaryTabId = getPrimaryTab();
  if (primaryTabId) {
    try {
      const response = await chrome.tabs.sendMessage(primaryTabId, { type: 'REQUEST_STATE' }) as {
        success: boolean;
        state?: { isPlaying: boolean; currentTime: number };
      };

      if (response?.success && response.state && session.roomId) {
        const stateResponse: StateResponseMessage = {
          type: 'STATE_RESPONSE',
          roomId: session.roomId,
          userId: session.oderId,
          isPlaying: response.state.isPlaying,
          currentTime: response.state.currentTime
        };
        sendMessage(stateResponse);
        return;
      }
    } catch (e) {
      console.warn(`[WatchTogether] Failed to get state from primary tab ${primaryTabId}:`, e);
    }
  }

  // Fallback: try all active tabs
  for (const tabId of activeTabs) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_STATE' }) as {
        success: boolean;
        state?: { isPlaying: boolean; currentTime: number };
      };

      if (response?.success && response.state && session.roomId) {
        const stateResponse: StateResponseMessage = {
          type: 'STATE_RESPONSE',
          roomId: session.roomId,
          userId: session.oderId,
          isPlaying: response.state.isPlaying,
          currentTime: response.state.currentTime
        };
        sendMessage(stateResponse);
        return;
      }
    } catch (e) {
      // Tab not ready
    }
  }

  console.warn('[WatchTogether] Could not get player state from any tab');
}

// Force sync: get current URL and playback state from active tab and broadcast to all
async function forceSync(): Promise<{ success: boolean; error?: string }> {
  if (!session.roomId) {
    return { success: false, error: 'Not in a room' };
  }

  // Get the active tab's URL and state
  for (const tabId of activeTabs) {
    try {
      // Get tab URL
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url) continue;

      // Determine platform from URL
      let platform: 'youtube' | 'netflix' | 'crunchyroll' | null = null;
      if (tab.url.includes('youtube.com')) platform = 'youtube';
      else if (tab.url.includes('netflix.com')) platform = 'netflix';
      else if (tab.url.includes('crunchyroll.com')) platform = 'crunchyroll';

      if (!platform) continue;

      // Get current playback state
      const stateResponse = await chrome.tabs.sendMessage(tabId, { type: 'REQUEST_STATE' }) as {
        success: boolean;
        state?: { isPlaying: boolean; currentTime: number };
      };

      // Send navigation event to sync URL
      const navMsg: NavigateMessage = {
        type: 'NAVIGATE',
        roomId: session.roomId,
        userId: session.oderId,
        navigation: {
          url: tab.url,
          platform,
          timestamp: Date.now()
        }
      };
      sendMessage(navMsg);
      console.log('[WatchTogether] Force sync - sent navigation:', tab.url);

      // Send playback state sync
      if (stateResponse?.success && stateResponse.state) {
        const syncMsg: SyncEventMessage = {
          type: 'SYNC_EVENT',
          roomId: session.roomId,
          userId: session.oderId,
          event: {
            type: stateResponse.state.isPlaying ? 'PLAY' : 'PAUSE',
            time: stateResponse.state.currentTime,
            timestamp: Date.now()
          }
        };
        sendMessage(syncMsg);
        console.log('[WatchTogether] Force sync - sent playback state:', stateResponse.state);
      }

      return { success: true };
    } catch (e) {
      // Try next tab
      continue;
    }
  }

  return { success: false, error: 'No active video tab found' };
}

// Broadcast status to all tabs and popup
function broadcastStatusToAllTabs(): void {
  const status = {
    connected: session.connected,
    roomId: session.roomId,
    isHost: session.isHost,
    userCount: session.userCount,
    users: session.users,
    userId: session.oderId,
    canControl: session.canControl,
    syncStatus: session.connected ? (session.roomId ? 'OK' : 'DISCONNECTED') : 'DISCONNECTED'
  };

  for (const tabId of activeTabs) {
    chrome.tabs.sendMessage(tabId, {
      type: 'STATUS_UPDATE',
      payload: status
    }).catch(() => {});
  }

  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    payload: status
  }).catch(() => {});
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (tabId) {
    activeTabs.add(tabId);
  }

  handleMessage(tabId, message, sendResponse);
  return true;
});

function handleMessage(tabId: number | undefined, message: { type: string; payload?: unknown }, sendResponse: (response: unknown) => void): void {
  console.log('[WatchTogether] Message:', message.type);

  switch (message.type) {
    case 'CONNECT':
      connect();
      sendResponse({ success: true });
      break;

    case 'DISCONNECT':
      disconnect();
      sendResponse({ success: true });
      break;

    case 'CREATE_ROOM': {
      // Prevent concurrent room operations
      if (!acquireRoomLock({ type: 'CREATE_ROOM', timestamp: Date.now() })) {
        sendResponse({ success: false, error: 'Another room operation is in progress' });
        break;
      }

      const payload = message.payload as { userName?: string } | undefined;
      if (payload?.userName) {
        session.userName = payload.userName;
      }

      // If already in a room, leave it first
      if (session.roomId) {
        console.log('[WatchTogether] Already in room, leaving before creating new one');
        const leaveMsg: LeaveRoomMessage = {
          type: 'LEAVE_ROOM',
          roomId: session.roomId,
          userId: session.oderId
        };
        sendMessage(leaveMsg);
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
      }

      const doCreate = () => {
        const createMsg: CreateRoomMessage = {
          type: 'CREATE_ROOM',
          userId: session.oderId,
          userName: session.userName
        };
        sendMessage(createMsg);
        // Lock will be released when ROOM_CREATED is received
      };

      if (!session.connected) {
        connect();
        const checkConnection = setInterval(() => {
          if (session.connected) {
            clearInterval(checkConnection);
            doCreate();
          }
        }, 100);

        // Timeout after 10s
        setTimeout(() => {
          clearInterval(checkConnection);
          if (!session.connected) {
            releaseRoomLock();
            console.error('[WatchTogether] Failed to connect for room creation');
          }
        }, 10000);
      } else {
        doCreate();
      }
      sendResponse({ success: true });
      break;
    }

    case 'JOIN_ROOM': {
      const payload = message.payload as { roomId: string; userName?: string };
      if (!payload?.roomId) {
        sendResponse({ success: false, error: 'Room ID required' });
        return;
      }

      const targetRoomId = payload.roomId.toUpperCase();

      // Prevent concurrent room operations
      if (!acquireRoomLock({ type: 'JOIN_ROOM', timestamp: Date.now(), roomId: targetRoomId })) {
        sendResponse({ success: false, error: 'Another room operation is in progress' });
        break;
      }

      // If already in this room, skip
      if (session.roomId === targetRoomId) {
        console.log('[WatchTogether] Already in this room');
        releaseRoomLock();
        sendResponse({ success: true });
        break;
      }

      if (payload.userName) {
        session.userName = payload.userName;
      }

      // If in a different room, leave it first
      if (session.roomId) {
        console.log('[WatchTogether] Leaving current room before joining new one');
        const leaveMsg: LeaveRoomMessage = {
          type: 'LEAVE_ROOM',
          roomId: session.roomId,
          userId: session.oderId
        };
        sendMessage(leaveMsg);
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
      }

      const doJoin = () => {
        const joinMsg: JoinRoomMessage = {
          type: 'JOIN_ROOM',
          roomId: targetRoomId,
          userId: session.oderId,
          userName: session.userName
        };
        sendMessage(joinMsg);
        // Lock will be released when ROOM_JOINED is received
      };

      if (!session.connected) {
        connect();
        const checkConnection = setInterval(() => {
          if (session.connected) {
            clearInterval(checkConnection);
            doJoin();
          }
        }, 100);

        // Timeout after 10s
        setTimeout(() => {
          clearInterval(checkConnection);
          if (!session.connected) {
            releaseRoomLock();
            console.error('[WatchTogether] Failed to connect for room join');
          }
        }, 10000);
      } else {
        doJoin();
      }
      sendResponse({ success: true });
      break;
    }

    case 'AUTO_JOIN_ROOM': {
      // Auto-join from deep link - get username from storage
      const payload = message.payload as { roomId: string };
      if (!payload?.roomId) {
        sendResponse({ success: false, error: 'Room ID required' });
        return;
      }

      const targetRoomId = payload.roomId.toUpperCase();
      console.log(`[WatchTogether] AUTO_JOIN_ROOM for room: ${targetRoomId}`);

      // Prevent concurrent room operations
      if (!acquireRoomLock({ type: 'JOIN_ROOM', timestamp: Date.now(), roomId: targetRoomId })) {
        sendResponse({ success: false, error: 'Another room operation is in progress' });
        break;
      }

      // Check if we're already in this room
      if (session.roomId === targetRoomId) {
        console.log('[WatchTogether] Already in this room, ignoring AUTO_JOIN');
        releaseRoomLock();
        sendResponse({ success: true });
        return;
      }

      // Get username from storage
      chrome.storage.local.get(['userName']).then(result => {
        if (result.userName) {
          session.userName = result.userName;
        }

        // If we're already in a different room, leave it first
        if (session.roomId) {
          console.log(`[WatchTogether] Already in room ${session.roomId}, leaving before joining ${targetRoomId}`);
          const leaveMsg: LeaveRoomMessage = {
            type: 'LEAVE_ROOM',
            roomId: session.roomId,
            userId: session.oderId
          };
          sendMessage(leaveMsg);

          // Clear local session state immediately
          session.roomId = null;
          session.isHost = false;
          session.userCount = 0;
          session.users = [];
          broadcastStatusToAllTabs();
        }

        const doJoin = () => {
          console.log(`[WatchTogether] Sending JOIN_ROOM for ${targetRoomId}`);
          const joinMsg: JoinRoomMessage = {
            type: 'JOIN_ROOM',
            roomId: targetRoomId,
            userId: session.oderId,
            userName: session.userName
          };
          sendMessage(joinMsg);
          // Lock will be released when ROOM_JOINED or ERROR is received
        };

        if (!session.connected) {
          console.log('[WatchTogether] Not connected, establishing connection first...');
          connect();

          let attempts = 0;
          const maxAttempts = 50; // 5 seconds max

          const checkConnection = setInterval(() => {
            attempts++;

            if (session.connected) {
              clearInterval(checkConnection);
              console.log('[WatchTogether] Connected!');
              // Small delay after leaving previous room
              setTimeout(doJoin, 300);
            } else if (attempts >= maxAttempts) {
              clearInterval(checkConnection);
              releaseRoomLock();
              console.error('[WatchTogether] Failed to connect after 5 seconds');
              forwardToAllTabs({
                type: 'ERROR',
                payload: { code: 'CONNECTION_TIMEOUT', message: 'Could not connect to server' }
              });
            }
          }, 100);
        } else {
          // Small delay if we just left a room
          setTimeout(doJoin, session.roomId ? 300 : 0);
        }
      }).catch(err => {
        console.error('[WatchTogether] Failed to get username from storage:', err);
        releaseRoomLock();
      });

      sendResponse({ success: true });
      break;
    }

    case 'LEAVE_ROOM':
      if (session.roomId) {
        const leaveMsg: LeaveRoomMessage = {
          type: 'LEAVE_ROOM',
          roomId: session.roomId,
          userId: session.oderId
        };
        sendMessage(leaveMsg);
        session.roomId = null;
        session.isHost = false;
        session.userCount = 0;
        session.users = [];
        broadcastStatusToAllTabs();
      }
      sendResponse({ success: true });
      break;

    case 'PLAYER_EVENT':
      if (!session.roomId) {
        console.warn('[WatchTogether] PLAYER_EVENT ignored - not in a room');
        sendResponse({ success: false, error: 'Not in a room' });
        break;
      }

      if (!session.canControl) {
        console.warn('[WatchTogether] PLAYER_EVENT ignored - no control permission');
        sendResponse({ success: false, error: 'No control permission' });
        break;
      }

      // Validate event data
      const event = message.payload as SyncEvent;
      if (!event || !event.type || typeof event.time !== 'number') {
        console.error('[WatchTogether] Invalid PLAYER_EVENT payload:', event);
        sendResponse({ success: false, error: 'Invalid event data' });
        break;
      }

      // Sanitize time value (prevent NaN, Infinity, negative values)
      if (!isFinite(event.time) || event.time < 0) {
        console.error('[WatchTogether] Invalid time value:', event.time);
        sendResponse({ success: false, error: 'Invalid time value' });
        break;
      }

      const syncMsg: SyncEventMessage = {
        type: 'SYNC_EVENT',
        roomId: session.roomId,
        userId: session.oderId,
        event: event
      };
      sendMessage(syncMsg);
      console.log('[WatchTogether] Sent SYNC_EVENT to server');
      sendResponse({ success: true });
      break;

    case 'NAVIGATION_EVENT':
      if (!session.roomId) {
        console.warn('[WatchTogether] NAVIGATION_EVENT ignored - not in a room');
        sendResponse({ success: false, error: 'Not in a room' });
        break;
      }

      if (!session.canControl) {
        console.warn('[WatchTogether] NAVIGATION_EVENT ignored - no control permission');
        sendResponse({ success: false, error: 'No control permission' });
        break;
      }

      const navigation = message.payload as NavigationEvent;

      // Validate navigation data
      if (!navigation || !navigation.url || !navigation.platform) {
        console.error('[WatchTogether] Invalid NAVIGATION_EVENT payload:', navigation);
        sendResponse({ success: false, error: 'Invalid navigation data' });
        break;
      }

      // Validate URL format
      try {
        new URL(navigation.url);
      } catch {
        console.error('[WatchTogether] Invalid URL:', navigation.url);
        sendResponse({ success: false, error: 'Invalid URL' });
        break;
      }

      // Update our current URL/platform
      session.currentUrl = navigation.url;
      session.currentPlatform = navigation.platform;

      const navMsg: NavigateMessage = {
        type: 'NAVIGATE',
        roomId: session.roomId,
        userId: session.oderId,
        navigation: navigation
      };
      sendMessage(navMsg);
      console.log('[WatchTogether] Sent NAVIGATE to server:', navigation.url);
      sendResponse({ success: true });
      break;

    case 'FORCE_SYNC':
      if (!session.roomId) {
        sendResponse({ success: false, error: 'Not in a room' });
        return;
      }
      if (!session.canControl) {
        sendResponse({ success: false, error: 'No control permission' });
        return;
      }
      // Get current state from active tab and broadcast
      forceSync().then((result: { success: boolean; error?: string }) => {
        sendResponse(result);
      });
      break;

    case 'JOINER_READY':
      // Joiner's video is ready, signal to server to notify host
      if (session.roomId) {
        console.log('[WatchTogether] Joiner video ready, notifying host');
        const joinerReadyMsg: JoinerReadyMessage = {
          type: 'JOINER_READY',
          roomId: session.roomId,
          userId: session.oderId
        };
        sendMessage(joinerReadyMsg);
      }
      sendResponse({ success: true });
      break;

    case 'OPEN_POPUP':
      // Open the extension popup programmatically
      chrome.action.openPopup().catch((err) => {
        console.log('[WatchTogether] Could not open popup:', err.message);
        // Fallback: Some browsers don't support openPopup, that's OK
      });
      sendResponse({ success: true });
      break;

    case 'KICK_USER': {
      const payload = message.payload as { targetUserId: string };
      if (session.roomId && session.isHost) {
        const kickMsg: KickUserMessage = {
          type: 'KICK_USER',
          roomId: session.roomId,
          userId: session.oderId,
          targetUserId: payload.targetUserId
        };
        sendMessage(kickMsg);
      }
      sendResponse({ success: true });
      break;
    }

    case 'SET_PERMISSION': {
      const payload = message.payload as { targetUserId: string; canControl: boolean };
      if (session.roomId && session.isHost) {
        const permMsg: SetPermissionMessage = {
          type: 'SET_PERMISSION',
          roomId: session.roomId,
          userId: session.oderId,
          targetUserId: payload.targetUserId,
          canControl: payload.canControl
        };
        sendMessage(permMsg);
      }
      sendResponse({ success: true });
      break;
    }

    case 'SET_NAME': {
      const payload = message.payload as { name: string };
      session.userName = payload.name;
      if (session.connected) {
        const nameMsg: SetNameMessage = {
          type: 'SET_NAME',
          userId: session.oderId,
          name: payload.name
        };
        sendMessage(nameMsg);
      }
      sendResponse({ success: true });
      break;
    }

    case 'GET_USERS':
      if (session.roomId) {
        const getUsersMsg: GetUsersMessage = {
          type: 'GET_USERS',
          roomId: session.roomId,
          userId: session.oderId
        };
        sendMessage(getUsersMsg);
      }
      sendResponse({ success: true, users: session.users });
      break;

    case 'GET_STATUS':
      sendResponse({
        success: true,
        status: {
          connected: session.connected,
          roomId: session.roomId,
          isHost: session.isHost,
          userCount: session.userCount,
          users: session.users,
          userId: session.oderId,
          canControl: session.canControl,
          syncStatus: session.connected ? (session.roomId ? 'OK' : 'DISCONNECTED') : 'DISCONNECTED'
        }
      });
      break;

    case 'REGISTER_TAB':
      if (tabId) {
        activeTabs.add(tabId);
        tabStates.set(tabId, {
          tabId,
          visible: true,
          platform: null,
          hasAdapter: false,
          lastActivity: Date.now()
        });
        console.log(`[WatchTogether] Registered tab ${tabId}`);
      }
      sendResponse({ success: true });
      break;

    case 'TAB_VISIBILITY': {
      const payload = message.payload as { visible: boolean };
      if (tabId && tabStates.has(tabId)) {
        const state = tabStates.get(tabId)!;
        state.visible = payload.visible;
        state.lastActivity = Date.now();
        console.log(`[WatchTogether] Tab ${tabId} visibility: ${payload.visible}`);
      }
      sendResponse({ success: true });
      break;
    }

    case 'ADAPTER_STATUS': {
      const payload = message.payload as { hasAdapter: boolean; platform: 'youtube' | 'netflix' | 'crunchyroll' };
      if (tabId && tabStates.has(tabId)) {
        const state = tabStates.get(tabId)!;
        state.hasAdapter = payload.hasAdapter;
        state.platform = payload.platform;
        state.lastActivity = Date.now();
        console.log(`[WatchTogether] Tab ${tabId} adapter status: ${payload.hasAdapter} (${payload.platform})`);
      }
      sendResponse({ success: true });
      break;
    }

    case 'UPDATE_CURRENT_URL': {
      const payload = message.payload as { url: string; platform: 'youtube' | 'netflix' | 'crunchyroll' };
      if (payload?.url && payload?.platform) {
        session.currentUrl = payload.url;
        session.currentPlatform = payload.platform;
        console.log(`[WatchTogether] Updated current URL: ${payload.url} (${payload.platform})`);
      }
      sendResponse({ success: true });
      break;
    }

    case 'JOINER_READY': {
      if (!session.roomId) {
        console.warn('[WatchTogether] JOINER_READY ignored - not in a room');
        sendResponse({ success: false, error: 'Not in a room' });
        break;
      }

      const joinerReadyMsg: JoinerReadyMessage = {
        type: 'JOINER_READY',
        roomId: session.roomId,
        userId: session.oderId
      };
      sendMessage(joinerReadyMsg);
      console.log('[WatchTogether] Sent JOINER_READY to server');
      sendResponse({ success: true });
      break;
    }

    default:
      console.warn('[WatchTogether] Unknown message type:', message.type, message);
      sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
  }
}

// Helper function to check if URL is on a supported platform
function isSupportedPlatform(url: string | undefined): boolean {
  if (!url) return false;
  return url.includes('youtube.com') ||
         url.includes('netflix.com') ||
         url.includes('crunchyroll.com') ||
         url.includes('vimeo.com') ||
         url.includes('dailymotion.com') ||
         url.includes('animedigitalnetwork.fr') ||
         url.includes('anime-sama.si') ||
         url.includes('twitch.tv') ||
         url.includes('disneyplus.com') ||
         url.includes('primevideo.com') ||
         url.includes('amazon.com/') && url.includes('video') ||
         url.includes('max.com');
}

// Helper function to leave room if no more active tabs
async function checkAndLeaveRoom() {
  // If there are no active tabs and we're in a room, leave it
  if (activeTabs.size === 0 && session.roomId) {
    console.log('[WatchTogether] No active tabs remaining, leaving room automatically');

    const roomId = session.roomId;

    // Send leave message to server
    const leaveMsg: LeaveRoomMessage = {
      type: 'LEAVE_ROOM',
      roomId: roomId,
      userId: session.oderId
    };
    sendMessage(leaveMsg);

    // Clear session state
    session.roomId = null;
    session.isHost = false;
    session.userCount = 0;
    session.users = [];

    // Broadcast status update
    broadcastStatusToAllTabs();

    // Notify all open popups/tabs that we left the room
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'ROOM_LEFT',
            payload: { roomId }
          }).catch(() => {
            // Ignore errors for tabs that don't have content script
          });
        }
      }
    } catch (e) {
      console.error('[WatchTogether] Error notifying tabs:', e);
    }
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const wasActive = activeTabs.has(tabId);
  activeTabs.delete(tabId);
  tabStates.delete(tabId);
  console.log(`[WatchTogether] Tab ${tabId} closed`);

  // If this was an active tab, check if we should leave the room
  if (wasActive) {
    await checkAndLeaveRoom();
  }
});

// Track navigation - leave room if navigating away from supported site
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const wasActive = activeTabs.has(tabId);
    const isSupported = isSupportedPlatform(tab.url);

    if (wasActive && !isSupported) {
      activeTabs.delete(tabId);
      console.log(`[WatchTogether] Tab ${tabId} navigated away from supported site`);

      // Check if we should leave the room
      await checkAndLeaveRoom();
    } else if (!wasActive && isSupported) {
      // Tab navigated to a supported site
      activeTabs.add(tabId);
      console.log(`[WatchTogether] Tab ${tabId} navigated to supported site`);
    }
  }
});

console.log('[WatchTogether] Background service worker initialized (global session)');
