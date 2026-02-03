// Synchronization event types for Watch Together
// These events are exchanged between clients via WebSocket

// Core sync events emitted by players
export type SyncEventType = 'PLAY' | 'PAUSE' | 'SEEK' | 'AD_STARTED' | 'AD_ENDED';

export interface SyncEvent {
  type: SyncEventType;
  time: number;
  timestamp: number;
  videoId?: string; // Optional normalized video identifier (e.g., "youtube:dQw4w9WgXcQ")
}

// Ad event for tracking advertisement playback
export interface AdEvent {
  type: 'AD_STARTED' | 'AD_ENDED';
  timestamp: number;
  userId: string;
}

// Navigation event for URL sync
export interface NavigationEvent {
  url: string;
  platform: 'youtube' | 'netflix' | 'crunchyroll';
  timestamp: number;
}

// User info for room members
export interface UserInfo {
  oderId: string;
  name: string;
  canControl: boolean;
  isHost: boolean;
}

// Client -> Server messages
export interface CreateRoomMessage {
  type: 'CREATE_ROOM';
  userId: string;
  userName?: string;
}

export interface JoinRoomMessage {
  type: 'JOIN_ROOM';
  roomId: string;
  userId: string;
  userName?: string;
}

export interface LeaveRoomMessage {
  type: 'LEAVE_ROOM';
  roomId: string;
  userId: string;
}

export interface SyncEventMessage {
  type: 'SYNC_EVENT';
  roomId: string;
  userId: string;
  event: SyncEvent;
}

export interface NavigateMessage {
  type: 'NAVIGATE';
  roomId: string;
  userId: string;
  navigation: NavigationEvent;
}

export interface RequestStateMessage {
  type: 'REQUEST_STATE';
  roomId: string;
  userId: string;
}

export interface StateResponseMessage {
  type: 'STATE_RESPONSE';
  roomId: string;
  userId: string;
  isPlaying: boolean;
  currentTime: number;
}

export interface KickUserMessage {
  type: 'KICK_USER';
  roomId: string;
  userId: string;
  targetUserId: string;
}

export interface SetPermissionMessage {
  type: 'SET_PERMISSION';
  roomId: string;
  userId: string;
  targetUserId: string;
  canControl: boolean;
}

export interface SetNameMessage {
  type: 'SET_NAME';
  userId: string;
  name: string;
}

export interface GetUsersMessage {
  type: 'GET_USERS';
  roomId: string;
  userId: string;
}

export interface HeartbeatMessage {
  type: 'HEARTBEAT';
  userId: string;
}

export interface JoinerReadyMessage {
  type: 'JOINER_READY';
  roomId: string;
  userId: string;
}

export type ClientMessage =
  | CreateRoomMessage
  | JoinRoomMessage
  | LeaveRoomMessage
  | SyncEventMessage
  | NavigateMessage
  | RequestStateMessage
  | StateResponseMessage
  | KickUserMessage
  | SetPermissionMessage
  | SetNameMessage
  | GetUsersMessage
  | HeartbeatMessage
  | JoinerReadyMessage;

// Server -> Client messages
export interface RoomCreatedMessage {
  type: 'ROOM_CREATED';
  roomId: string;
  isHost: boolean;
  oderId: string;
}

export interface RoomJoinedMessage {
  type: 'ROOM_JOINED';
  roomId: string;
  userCount: number;
  isHost: boolean;
  users: UserInfo[];
  oderId: string;
}

export interface RoomLeftMessage {
  type: 'ROOM_LEFT';
  roomId: string;
}

export interface ServerSyncEventMessage {
  type: 'SYNC_EVENT';
  roomId: string;
  oderId: string;
  event: SyncEvent;
}

export interface ServerNavigateMessage {
  type: 'NAVIGATE';
  roomId: string;
  oderId: string;
  navigation: NavigationEvent;
}

export interface StateRequestMessage {
  type: 'STATE_REQUEST';
  roomId: string;
  requesterId: string;
}

export interface StateUpdateMessage {
  type: 'STATE_UPDATE';
  roomId: string;
  isPlaying: boolean;
  currentTime: number;
}

export interface UserJoinedMessage {
  type: 'USER_JOINED';
  roomId: string;
  oderId: string;
  userName: string;
  userCount: number;
  users: UserInfo[];
}

export interface UserLeftMessage {
  type: 'USER_LEFT';
  roomId: string;
  oderId: string;
  userCount: number;
  newHostId?: string;
  users: UserInfo[];
}

export interface UserKickedMessage {
  type: 'USER_KICKED';
  roomId: string;
  oderId: string;
  reason: string;
}

export interface UsersListMessage {
  type: 'USERS_LIST';
  roomId: string;
  users: UserInfo[];
}

export interface PermissionChangedMessage {
  type: 'PERMISSION_CHANGED';
  roomId: string;
  oderId: string;
  canControl: boolean;
}

export interface ErrorMessage {
  type: 'ERROR';
  code: string;
  message: string;
}

export interface HeartbeatAckMessage {
  type: 'HEARTBEAT_ACK';
}

export interface JoinerReadyNotification {
  type: 'JOINER_READY_NOTIFICATION';
  roomId: string;
  joinerUserId: string;
}

export type ServerMessage =
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomLeftMessage
  | ServerSyncEventMessage
  | ServerNavigateMessage
  | StateRequestMessage
  | StateUpdateMessage
  | UserJoinedMessage
  | UserLeftMessage
  | UserKickedMessage
  | UsersListMessage
  | PermissionChangedMessage
  | ErrorMessage
  | HeartbeatAckMessage
  | JoinerReadyNotification;

// Utility to generate unique IDs
export function generateUserId(): string {
  return 'user_' + crypto.randomUUID().slice(0, 8);
}

export function generateRoomId(): string {
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}

// Constants
export const DRIFT_THRESHOLD_MS = 500;
export const HEARTBEAT_INTERVAL_MS = 30000;
export const RECONNECT_DELAY_MS = 3000;
export const MAX_RECONNECT_ATTEMPTS = 5;
export const PLAYER_DETECTION_RETRY_MS = 1000;
export const PLAYER_DETECTION_MAX_RETRIES = 30;
