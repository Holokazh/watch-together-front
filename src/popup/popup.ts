// Watch Together Popup Script
// Handles UI interactions and communicates with background service worker

interface UserInfo {
  oderId: string;
  name: string;
  canControl: boolean;
  isHost: boolean;
}

interface StatusPayload {
  connected: boolean;
  roomId: string | null;
  isHost: boolean;
  userCount: number;
  syncStatus: 'OK' | 'DESYNC' | 'DISCONNECTED';
  users: UserInfo[];
  userId: string;
}

interface ErrorPayload {
  code: string;
  message: string;
}

// DOM Elements
const elements = {
  statusIndicator: document.getElementById('status-indicator') as HTMLDivElement,
  statusText: document.getElementById('status-text') as HTMLSpanElement,
  notInRoomSection: document.getElementById('not-in-room') as HTMLElement,
  inRoomSection: document.getElementById('in-room') as HTMLElement,
  usernameInput: document.getElementById('username-input') as HTMLInputElement,
  randomizeNameBtn: document.getElementById('randomize-name-btn') as HTMLButtonElement,
  createRoomBtn: document.getElementById('create-room-btn') as HTMLButtonElement,
  roomIdInput: document.getElementById('room-id-input') as HTMLInputElement,
  joinRoomBtn: document.getElementById('join-room-btn') as HTMLButtonElement,
  currentRoomId: document.getElementById('current-room-id') as HTMLSpanElement,
  copyRoomIdBtn: document.getElementById('copy-room-id') as HTMLButtonElement,
  shareRoomBtn: document.getElementById('share-room-btn') as HTMLButtonElement,
  userCount: document.getElementById('user-count') as HTMLSpanElement,
  userRole: document.getElementById('user-role') as HTMLSpanElement,
  syncStatus: document.getElementById('sync-status') as HTMLSpanElement,
  usersList: document.getElementById('users-list') as HTMLUListElement,
  forceSyncBtn: document.getElementById('force-sync-btn') as HTMLButtonElement,
  leaveRoomBtn: document.getElementById('leave-room-btn') as HTMLButtonElement,
  errorDisplay: document.getElementById('error-display') as HTMLDivElement
};

// Random name generation (same as backend)
const ADJECTIVES = [
  'Happy', 'Lazy', 'Sneaky', 'Clever', 'Swift', 'Brave', 'Calm', 'Wild',
  'Cosmic', 'Mystic', 'Shadow', 'Golden', 'Silver', 'Crystal', 'Thunder',
  'Fluffy', 'Mighty', 'Sleepy', 'Speedy', 'Lucky', 'Jolly', 'Frosty',
  'Blazing', 'Silent', 'Noble', 'Ancient', 'Neon', 'Pixel', 'Turbo'
];

const ANIMALS = [
  'Panda', 'Fox', 'Cat', 'Dog', 'Owl', 'Bear', 'Wolf', 'Tiger',
  'Dragon', 'Phoenix', 'Falcon', 'Penguin', 'Koala', 'Raccoon', 'Otter',
  'Bunny', 'Dolphin', 'Hawk', 'Raven', 'Lynx', 'Badger', 'Jaguar',
  'Sloth', 'Hamster', 'Squirrel', 'Hedgehog', 'Corgi', 'Shiba', 'Tanuki'
];

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}${animal}`;
}

// State
let currentStatus: StatusPayload = {
  connected: false,
  roomId: null,
  isHost: false,
  userCount: 0,
  syncStatus: 'DISCONNECTED',
  users: [],
  userId: ''
};

// Initialize popup
async function init(): Promise<void> {
  // Check if we're on a supported site
  const isSupported = await checkIfSupportedSite();
  if (!isSupported) {
    showUnsupportedSiteWarning();
    return;
  }

  await loadUsername();
  await getStatus();
  setupEventListeners();
  setupMessageListener();
}

// Check if current tab is on a supported site
async function checkIfSupportedSite(): Promise<boolean> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0];

    if (!currentTab?.url) {
      return false;
    }

    const url = currentTab.url;
    const supportedDomains = [
      'youtube.com',
      'netflix.com',
      'crunchyroll.com',
      'vimeo.com',
      'dailymotion.com',
      'animedigitalnetwork.fr',
      'anime-sama.si',
      'twitch.tv',
      'disneyplus.com',
      'primevideo.com',
      'amazon.com/gp/video',
      'max.com',
      'play.max.com'
    ];

    return supportedDomains.some(domain => url.includes(domain));
  } catch (e) {
    console.error('[WatchTogether] Failed to check site:', e);
    return false;
  }
}

// Show warning when on unsupported site
function showUnsupportedSiteWarning(): void {
  // Hide normal sections
  elements.notInRoomSection.classList.add('hidden');
  elements.inRoomSection.classList.add('hidden');

  // Show beautiful unsupported site page
  const container = document.querySelector('.container') as HTMLElement;
  if (container) {
    container.innerHTML = `
      <div class="unsupported-container">
        <div class="unsupported-header">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="url(#gradient)" stroke-width="2" style="margin-bottom: 16px;">
            <defs>
              <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#ff6348;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#ff4757;stop-opacity:1" />
              </linearGradient>
            </defs>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <h2>Site Non Compatible</h2>
          <p class="subtitle">Watch Together nécessite un site de streaming vidéo</p>
        </div>

        <div class="platforms-grid">
          <button class="platform-btn youtube-btn" data-url="https://www.youtube.com">
            <span class="platform-name">YouTube</span>
          </button>

          <button class="platform-btn netflix-btn" data-url="https://www.netflix.com">
            <span class="platform-name">Netflix</span>
          </button>

          <button class="platform-btn crunchyroll-btn" data-url="https://www.crunchyroll.com">
            <span class="platform-name">Crunchyroll</span>
          </button>

          <button class="platform-btn vimeo-btn" data-url="https://www.vimeo.com">
            <span class="platform-name">Vimeo</span>
          </button>

          <button class="platform-btn dailymotion-btn" data-url="https://www.dailymotion.com">
            <span class="platform-name">Dailymotion</span>
          </button>

          <button class="platform-btn adn-btn" data-url="https://animedigitalnetwork.fr">
            <span class="platform-name">ADN</span>
          </button>

          <button class="platform-btn animesama-btn" data-url="https://anime-sama.si">
            <span class="platform-name">AnimeSama</span>
          </button>

          <button class="platform-btn twitch-btn" data-url="https://www.twitch.tv">
            <span class="platform-name">Twitch</span>
          </button>

          <button class="platform-btn disney-btn" data-url="https://www.disneyplus.com">
            <span class="platform-name">Disney+</span>
          </button>

          <button class="platform-btn prime-btn" data-url="https://www.primevideo.com">
            <span class="platform-name">Prime Video</span>
          </button>

          <button class="platform-btn max-btn" data-url="https://www.max.com">
            <span class="platform-name">Max</span>
          </button>
        </div>

        <div class="unsupported-footer">
          <p>💡 Cliquez sur une plateforme pour y accéder</p>
        </div>
      </div>
    `;

    // Add click handlers for platform buttons
    const platformBtns = container.querySelectorAll('.platform-btn');
    platformBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url;
        if (url) {
          chrome.tabs.create({ url });
        }
      });
    });
  }
}

// Load username from storage or generate one
async function loadUsername(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(['userName']);
    if (result.userName) {
      elements.usernameInput.value = result.userName;
    } else {
      // Generate a random name for first-time users
      const randomName = generateRandomName();
      elements.usernameInput.value = randomName;
      await saveUsername(randomName);
    }
  } catch (e) {
    console.error('[WatchTogether] Failed to load username:', e);
    elements.usernameInput.value = generateRandomName();
  }
}

// Save username to storage
async function saveUsername(name: string): Promise<void> {
  try {
    await chrome.storage.local.set({ userName: name });
    // Also send to background to update server
    await chrome.runtime.sendMessage({
      type: 'SET_NAME',
      payload: { name }
    });
  } catch (e) {
    console.error('[WatchTogether] Failed to save username:', e);
  }
}

// Get current username
function getUsername(): string {
  return elements.usernameInput.value.trim() || generateRandomName();
}

// Get current status from background
async function getStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as {
      success: boolean;
      status?: StatusPayload;
    };

    if (response?.success && response.status) {
      updateUI(response.status);
    }
  } catch (e) {
    console.error('[WatchTogether] Failed to get status:', e);
    showError('Failed to connect to extension');
  }
}

// Set up event listeners
function setupEventListeners(): void {
  // Username input - save on change
  let usernameTimeout: ReturnType<typeof setTimeout> | null = null;
  elements.usernameInput.addEventListener('input', () => {
    // Debounce saving
    if (usernameTimeout) clearTimeout(usernameTimeout);
    usernameTimeout = setTimeout(() => {
      const name = elements.usernameInput.value.trim();
      if (name) {
        saveUsername(name);
      }
    }, 500);
  });

  // Randomize name button
  elements.randomizeNameBtn.addEventListener('click', async () => {
    const randomName = generateRandomName();
    elements.usernameInput.value = randomName;
    await saveUsername(randomName);
  });

  // Create room button
  elements.createRoomBtn.addEventListener('click', async () => {
    const userName = getUsername();
    setLoading(true);
    hideError();

    try {
      await chrome.runtime.sendMessage({
        type: 'CREATE_ROOM',
        payload: { userName }
      });
      // Status will be updated via message listener
    } catch (e) {
      showError('Failed to create room');
    } finally {
      setLoading(false);
    }
  });

  // Join room button
  elements.joinRoomBtn.addEventListener('click', async () => {
    const roomId = elements.roomIdInput.value.trim().toUpperCase();
    const userName = getUsername();

    if (!roomId) {
      showError('Please enter a room ID');
      return;
    }

    if (roomId.length < 8) {
      showError('Room ID must be 8 characters');
      return;
    }

    setLoading(true);
    hideError();

    try {
      await chrome.runtime.sendMessage({
        type: 'JOIN_ROOM',
        payload: { roomId, userName }
      });
    } catch (e) {
      showError('Failed to join room');
    } finally {
      setLoading(false);
    }
  });

  // Room ID input - handle enter key and formatting
  elements.roomIdInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') {
      elements.joinRoomBtn.click();
    }
  });

  elements.roomIdInput.addEventListener('input', () => {
    // Force uppercase
    elements.roomIdInput.value = elements.roomIdInput.value.toUpperCase();
  });

  // Copy room ID button
  elements.copyRoomIdBtn.addEventListener('click', async () => {
    const roomId = elements.currentRoomId.textContent;
    if (roomId && roomId !== '--------') {
      try {
        await navigator.clipboard.writeText(roomId);
        // Visual feedback
        const originalColor = elements.copyRoomIdBtn.style.color;
        elements.copyRoomIdBtn.style.color = '#2ed573';
        setTimeout(() => {
          elements.copyRoomIdBtn.style.color = originalColor;
        }, 1000);
      } catch (e) {
        showError('Failed to copy room ID');
      }
    }
  });

  // Share room button - copy shareable link with room code
  elements.shareRoomBtn.addEventListener('click', async () => {
    const roomId = elements.currentRoomId.textContent;
    if (!roomId || roomId === '--------') {
      showError('No room to share');
      return;
    }

    try {
      // Get the current tab's URL
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];

      if (!currentTab?.url) {
        showError('Cannot get current page URL');
        return;
      }

      // Create shareable URL with room code parameter
      const url = new URL(currentTab.url);
      url.searchParams.set('wt', roomId);
      const shareableUrl = url.toString();

      // Copy to clipboard
      await navigator.clipboard.writeText(shareableUrl);

      // Visual feedback
      const originalColor = elements.shareRoomBtn.style.color;
      elements.shareRoomBtn.style.color = '#2ed573';
      setTimeout(() => {
        elements.shareRoomBtn.style.color = originalColor;
      }, 1000);
    } catch (e) {
      showError('Failed to copy shareable link');
    }
  });

  // Force sync button
  elements.forceSyncBtn.addEventListener('click', async () => {
    elements.forceSyncBtn.disabled = true;
    hideError();

    try {
      const response = await chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }) as { success: boolean; error?: string };
      if (response?.success) {
        // Visual feedback
        const originalText = elements.forceSyncBtn.innerHTML;
        elements.forceSyncBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Synced!';
        setTimeout(() => {
          elements.forceSyncBtn.innerHTML = originalText;
        }, 1500);
      } else {
        showError(response?.error || 'Failed to sync');
      }
    } catch (e) {
      showError('Failed to sync');
    } finally {
      elements.forceSyncBtn.disabled = false;
    }
  });

  // Leave room button
  elements.leaveRoomBtn.addEventListener('click', async () => {
    setLoading(true);
    hideError();

    try {
      await chrome.runtime.sendMessage({ type: 'LEAVE_ROOM' });
    } catch (e) {
      showError('Failed to leave room');
    } finally {
      setLoading(false);
    }
  });
}

// Listen for messages from background
function setupMessageListener(): void {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'STATUS_UPDATE' && message.payload) {
      updateUI(message.payload as StatusPayload);
    } else if (message.type === 'ERROR' && message.payload) {
      const error = message.payload as ErrorPayload;
      showError(error.message);
    } else if (message.type === 'KICKED') {
      // User was kicked from the room
      showKickedNotification(message.payload?.reason);
      // Force UI update to show "not in room" state
      updateUI({
        connected: true,
        roomId: null,
        isHost: false,
        userCount: 0,
        syncStatus: 'DISCONNECTED',
        users: [],
        userId: currentStatus.userId
      });
    }
  });
}

// Update UI based on status
function updateUI(status: StatusPayload): void {
  currentStatus = status;

  // Update connection status
  updateConnectionStatus(status.connected, status.roomId !== null);

  // Show appropriate section
  if (status.roomId) {
    elements.notInRoomSection.classList.add('hidden');
    elements.inRoomSection.classList.remove('hidden');

    // Update room info
    elements.currentRoomId.textContent = status.roomId;
    elements.userCount.textContent = status.userCount.toString();
    elements.userRole.textContent = status.isHost ? 'Host' : 'Guest';

    // Update sync status
    updateSyncStatus(status.syncStatus);

    // Update users list
    updateUsersList(status.users, status.userId, status.isHost);
  } else {
    elements.notInRoomSection.classList.remove('hidden');
    elements.inRoomSection.classList.add('hidden');
    elements.roomIdInput.value = '';
  }
}

// Update users list
function updateUsersList(users: UserInfo[], currentUserId: string, isHost: boolean): void {
  elements.usersList.innerHTML = '';

  for (const user of users) {
    const li = document.createElement('li');
    li.className = 'user-item';
    li.dataset.userId = user.oderId;

    const isCurrentUser = user.oderId === currentUserId;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.textContent = getInitials(user.name);
    li.appendChild(avatar);

    // User info
    const info = document.createElement('div');
    info.className = 'user-info';

    const name = document.createElement('div');
    name.className = 'user-name';
    name.textContent = user.name || 'Anonymous';
    info.appendChild(name);

    const badges = document.createElement('div');
    badges.className = 'user-badges';

    if (user.isHost) {
      const hostBadge = document.createElement('span');
      hostBadge.className = 'user-badge badge-host';
      hostBadge.textContent = 'Host';
      badges.appendChild(hostBadge);
    }

    if (isCurrentUser) {
      const youBadge = document.createElement('span');
      youBadge.className = 'user-badge badge-you';
      youBadge.textContent = 'You';
      badges.appendChild(youBadge);
    }

    if (!user.canControl && !user.isHost) {
      const noControlBadge = document.createElement('span');
      noControlBadge.className = 'user-badge badge-no-control';
      noControlBadge.textContent = 'View Only';
      badges.appendChild(noControlBadge);
    }

    info.appendChild(badges);
    li.appendChild(info);

    // Actions (only for host, and not for themselves)
    if (isHost && !isCurrentUser) {
      const actions = document.createElement('div');
      actions.className = 'user-actions';

      // Toggle control button
      const controlBtn = document.createElement('button');
      controlBtn.className = `btn-user-action ${user.canControl ? 'btn-control-on' : 'btn-control-off'}`;
      controlBtn.title = user.canControl ? 'Revoke control' : 'Grant control';
      controlBtn.innerHTML = user.canControl
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 9l6 6M15 9l-6 6"/></svg>';
      controlBtn.addEventListener('click', () => toggleUserControl(user.oderId, !user.canControl));
      actions.appendChild(controlBtn);

      // Kick button
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn-user-action btn-kick';
      kickBtn.title = 'Kick user';
      kickBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
      kickBtn.addEventListener('click', () => kickUser(user.oderId));
      actions.appendChild(kickBtn);

      li.appendChild(actions);
    }

    elements.usersList.appendChild(li);
  }
}

// Get initials from name
function getInitials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Toggle user control permission
async function toggleUserControl(targetUserId: string, canControl: boolean): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'SET_PERMISSION',
      payload: { targetUserId, canControl }
    });
  } catch (e) {
    showError('Failed to change permission');
  }
}

// Kick user from room
async function kickUser(targetUserId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'KICK_USER',
      payload: { targetUserId }
    });
  } catch (e) {
    showError('Failed to kick user');
  }
}

// Update connection status indicator
function updateConnectionStatus(connected: boolean, inRoom: boolean): void {
  elements.statusIndicator.classList.remove('disconnected', 'connected', 'connecting');

  if (connected && inRoom) {
    elements.statusIndicator.classList.add('connected');
    elements.statusText.textContent = 'Connected';
  } else if (connected) {
    elements.statusIndicator.classList.add('connecting');
    elements.statusText.textContent = 'Ready';
  } else {
    elements.statusIndicator.classList.add('disconnected');
    elements.statusText.textContent = 'Disconnected';
  }
}

// Update sync status display
function updateSyncStatus(status: 'OK' | 'DESYNC' | 'DISCONNECTED'): void {
  elements.syncStatus.classList.remove('sync-ok', 'sync-desync', 'sync-disconnected');

  switch (status) {
    case 'OK':
      elements.syncStatus.classList.add('sync-ok');
      elements.syncStatus.textContent = 'OK';
      break;
    case 'DESYNC':
      elements.syncStatus.classList.add('sync-desync');
      elements.syncStatus.textContent = 'Desync';
      break;
    case 'DISCONNECTED':
      elements.syncStatus.classList.add('sync-disconnected');
      elements.syncStatus.textContent = 'N/A';
      break;
  }
}

// Show error message
function showError(message: string): void {
  elements.errorDisplay.textContent = message;
  elements.errorDisplay.classList.remove('hidden');

  // Auto-hide after 5 seconds
  setTimeout(() => {
    hideError();
  }, 5000);
}

// Show kicked notification
function showKickedNotification(reason?: string): void {
  const message = reason || 'You have been kicked from the room by the host';
  elements.errorDisplay.textContent = message;
  elements.errorDisplay.classList.remove('hidden');

  // Keep visible longer for kicked notification (8 seconds)
  setTimeout(() => {
    hideError();
  }, 8000);
}

// Hide error message
function hideError(): void {
  elements.errorDisplay.classList.add('hidden');
}

// Set loading state
function setLoading(loading: boolean): void {
  elements.createRoomBtn.disabled = loading;
  elements.joinRoomBtn.disabled = loading;
  elements.leaveRoomBtn.disabled = loading;
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', init);
