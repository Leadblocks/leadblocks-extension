// =============================================================================
// STATE
// =============================================================================

const ALLOWED_USER_TYPES = ['Admin', 'Chatter', 'Backoffice'];

// Appended to errors that indicate a LinkedIn structure change or extension bug.
// These require a developer fix, not a user action.
const DEV_MSG = ' Please contact the developer.';

// =============================================================================
// SESSION PERSISTENCE — survive sidepanel reloads within the same browser session
// =============================================================================

const SS_ACTIONED  = 'lb_actioned_tasks';
const SS_CH_SENT   = 'lb_chatter_sent';
const SS_CH_DISC   = 'lb_chatter_disconnected';

function saveActionedState() {
  try {
    sessionStorage.setItem(SS_ACTIONED, JSON.stringify(state.actionedTasks));
    sessionStorage.setItem(SS_CH_SENT,  JSON.stringify(state.chatterSent));
    sessionStorage.setItem(SS_CH_DISC,  JSON.stringify(state.chatterDisconnected));
  } catch (_) {}
}

/**
 * After loading a fresh batch of tasks, restore actioned state for any task IDs
 * that were already handled earlier in this browser session.
 */
function restoreActionedStateForTasks(tasks) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SS_ACTIONED) || '{}');
    for (const t of tasks) {
      if (saved[t.id] && !state.actionedTasks[t.id]) state.actionedTasks[t.id] = saved[t.id];
    }
  } catch (_) {}
}

function restoreChatterStateForTasks(tasks) {
  try {
    const savedSent = JSON.parse(sessionStorage.getItem(SS_CH_SENT) || '{}');
    const savedDisc = JSON.parse(sessionStorage.getItem(SS_CH_DISC) || '{}');
    for (const t of tasks) {
      const tid = t.documentId;
      if (savedSent[tid] && !state.chatterSent[tid])       state.chatterSent[tid]       = savedSent[tid];
      if (savedDisc[tid] && !state.chatterDisconnected[tid]) state.chatterDisconnected[tid] = savedDisc[tid];
    }
  } catch (_) {}
}

// =============================================================================
// TOKEN EXPIRY HANDLER
// =============================================================================

/** Called by apiGet / apiPost when the server returns 401/403. */
function handleSessionExpired() {
  setTimeout(async () => {
    await clearAuth();
    Object.assign(state, { token: null, view: 'login', error: null });
    render();
    setTimeout(() => {
      const errEl = document.getElementById('login-error');
      if (errEl) { errEl.textContent = 'Session expired. Please sign in again.'; errEl.style.display = 'block'; }
    }, 50);
  }, 0);
}

const STEPS = [
  { key: 'connection_acceptance', label: 'Connection Acceptance', enabled: true, requiresType: ['Admin', 'Backoffice'] },
  { key: 'chat_scraper', label: 'Messaging', enabled: true, requiresType: ['Admin', 'Backoffice'] },
  { key: 'connection_request', label: 'Connection Request', enabled: true, requiresType: ['Admin', 'Backoffice'] },
  { key: 'follow_up', label: 'Follow-Up', enabled: true, requiresType: ['Admin', 'Backoffice'] },
  { key: 'revoke_connection_request', label: 'Revoke Connection Request', enabled: true, requiresType: ['Admin', 'Backoffice'] },
  { key: 'chatter_tasks', label: 'Chatter Tasks', enabled: true, requiresType: ['Admin', 'Chatter'] },
];

function isStepVisible(step) {
  if (step.requiresType && step.requiresType.length > 0) {
    return step.requiresType.includes(state.userType);
  }
  return true;
}

function firstVisibleStepIndex() {
  for (let i = 0; i < STEPS.length; i++) {
    if (isStepVisible(STEPS[i])) return i;
  }
  return 0;
}

const state = {
  // Auth
  token: null,
  backendUrl: 'https://backend.leadblocks.nl',
  userName: '',          // logged-in user's display name
  userType: '',          // logged-in user's type (e.g. 'Admin', 'Chatter', 'Customer')

  // Current step
  currentStep: 0,

  // Data
  customers: [],
  campaigns: [],
  tasks: [],

  // Pending (unsubmitted) filter selections
  pendingCustomerId: '',
  pendingProfileId: '',
  pendingCampaignId: '',
  pendingProspectId: '',
  pendingProspectName: '',
  pendingProspectUrl: '',   // backup: LinkedIn profile URL from hovering the person's name
  pendingLinkedInSearch: '',

  // Applied (active) filters
  appliedProfileId: '',
  appliedCampaignId: '',
  appliedProspectId: '',
  appliedProspectUrl: '',   // backup: LinkedIn profile URL used when no prospectId was detected
  appliedLinkedInSearch: '',

  // Queue
  currentIndex: 0,
  totalTasks: 0,

  // Per-task state
  actionedTasks: {},      // taskId -> 'connected' | 'revoked' | 'disconnected'
  contactDetails: {},     // taskId -> {email, phone, birthday, date_connected}

  // Connection acceptance overlay warnings
  lastOverlayWarningUrl: '',

  // Chatter Tasks (step 6) per-task state
  chatterAction: {},      // taskDocId -> 'send_message' | 'forward_client' | 'back_campaign' | 'disconnect' | 'other_dmu'
  chatterSent: {},        // taskDocId -> 'message' | 'forwarded' | 'back_campaign'
  chatterDisconnected: {},// taskDocId -> true
  chatterAiSuggestion: {}, // taskDocId -> array of {angle, message} suggestion variants
  chatterAiLoading: {},    // taskDocId -> bool
  chatterAiError: {},      // taskDocId -> error message
  chatterAiNote: {},       // taskDocId -> optional prompt note to tailor the AI suggestion
  disconnectPending: {},  // unused — kept for compatibility
  chatterFollowUp: {},    // taskDocId -> bool (controls follow-up date visibility)
  chatterTaskTags: {},    // taskDocId -> array of {id, tag_name, colour, is_standard}
  chatterTagSelectorOpen: {}, // taskDocId -> bool (is the tag dropdown open)
  chatterNameEditOpen: {},    // taskDocId -> bool (is the inline name editor open)
  availableTagsByProfile: {}, // numericProfileId -> array of tags (cached for chatter tasks tab)
  otherDmuCampaignsByProfile: {}, // numericProfileId -> array of {id, campaign_name} (Other DMU campaigns)
  campaignContentPopup: null, // null | { title, content: [...] , loading: bool, error: string }
  notesPopup: null,           // null | { title, notes: [...] }
  chatPopup: null,            // null | { title, messages, prospectId, loading, error }
  replyTemplatesPopup: null,  // null | { title, options: [], selectedIndex: number, message: string, loading: bool, error: string }

  // Connection acceptance (step 1) state
  acceptanceResult: null,  // null | { status, task?, message? }

  // Chat Scraper state
  chatScraper: {
    status: 'idle',    // 'idle' | 'scraping' | 'ready' | 'sending'
    messages: [],
    profile_id: '',
    customer_id: '',
    contact_name: '',  // display name of the prospect
    thread_url: '',    // URL of the scraped thread
    sentCount: null,   // null | number — set after a successful send
    error: null,
    scraperDays: 0,    // period filter: 7 | 31 | 0 (0 = all time)
    manualSenderOverrides: {}, // messageId → 'sent' | 'received'
  },

  // Follow-up safeguard state
  followUpBlocked: {},    // taskId -> epoch ms until follow-up send is blocked
  followUpChecking: {},   // taskId -> true while we verify the active chat

  // UI
  view: 'login',          // 'login' | 'main'
  viewMode: 'queue',      // 'queue' | 'list'
  loading: false,
  loadingCampaigns: false,
  loadingCustomers: false,
  error: null,
  currentTabUrl: '',
  currentThreadProspectId: '',
  currentOverlayProspectId: '',
  currentOverlayProfileUrl: '',
  lastBlockedReportKey: '',
};

// =============================================================================
// HELPERS
// =============================================================================

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/+$/, '').toLowerCase();
  } catch (_) {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

function urlMatches(taskUrl, tabUrl) {
  if (!taskUrl || !tabUrl) return false;
  return normalizeUrl(taskUrl) === normalizeUrl(tabUrl);
}

function normalizeProspectId(id) {
  if (id == null) return '';
  return String(id).trim().toLowerCase();
}

function isMessagingThreadUrl(url) {
  return /linkedin\.com\/messaging\/(thread|conversations)\//i.test(url);
}

function getCurrentThreadProspectId() {
  if (isMessagingThreadUrl(state.currentTabUrl) && state.chatScraper.thread_url === state.currentTabUrl && state.chatScraper.profile_id) {
    return normalizeProspectId(state.chatScraper.profile_id);
  }
  return normalizeProspectId(state.currentThreadProspectId);
}

function getAvailableProfiles() {
  const customer = state.customers.find(c => String(c.id) === state.pendingCustomerId);
  return customer ? (customer.profiles || []) : [];
}

function getSelectedConnectionProspectId() {
  return normalizeProspectId(state.appliedProspectId || state.pendingProspectId || '');
}

function getSelectedConnectionProspectIdRaw() {
  return state.appliedProspectId || state.pendingProspectId || '';
}

function getSelectedConnectionProfileUrl() {
  return state.appliedProspectUrl || state.pendingProspectUrl || '';
}

function getAppliedProfileName() {
  const customer = state.customers.find(c => (c.profiles || []).some(p => String(p.id) === String(state.appliedProfileId)));
  const profile = customer ? (customer.profiles || []).find(p => String(p.id) === String(state.appliedProfileId)) : null;
  return profile?.profile_name || '';
}

// AI Suggestion (step 6) is gated to the Leadblocks customer for now,
// except for AI Campaign tasks where it is always available.
const AI_SUGGESTION_CUSTOMERS = ['leadblocks'];
// Must match CHATTER_AI_PROMPT_NOTE_MAX_LENGTH in the backend extension controller.
// Sized so a copied LinkedIn post fits.
const AI_PROMPT_NOTE_MAX_LENGTH = 1500;
function isAiSuggestionEnabled(task) {
  if (task?.campaign_prospect?.campaign?.campaign_type === 'AI Campaign') return true;
  const customer = state.customers.find(c => (c.profiles || []).some(p => String(p.id) === String(state.appliedProfileId)));
  return AI_SUGGESTION_CUSTOMERS.includes((customer?.customer_name || '').trim().toLowerCase());
}

function isConnectionAcceptanceOverlayMatch() {
  const overlayId = normalizeProspectId(state.currentOverlayProspectId);
  const selectedId = getSelectedConnectionProspectId();
  const overlayUrl = state.currentOverlayProfileUrl || '';
  const selectedUrl = getSelectedConnectionProfileUrl();
  const idMatch = overlayId && selectedId ? overlayId === selectedId : null;
  const urlMatch = overlayUrl && selectedUrl ? urlMatches(selectedUrl, overlayUrl) : null;

  if (overlayId && selectedId) return idMatch;
  if (overlayUrl && selectedUrl) return urlMatch;

  // Fallback: compare overlay URL directly against the task's known profile URL.
  // Covers the case where prospect_id extraction fails and no prospect is selected,
  // but the overlay URL and the task URL are clearly the same person.
  const taskUrl = state.acceptanceResult?.task?.profile_url || '';
  if (overlayUrl && taskUrl && urlMatches(overlayUrl, taskUrl)) return true;

  return false;
}

function isConnectionAcceptanceOverlayMismatch() {
  const selectedId = getSelectedConnectionProspectId();
  const selectedUrl = getSelectedConnectionProfileUrl();
  const overlayMatch = isConnectionAcceptanceOverlayMatch();

  const mismatch = !overlayMatch && (selectedId || selectedUrl);

  if (overlayMatch) return false;
  if (selectedId || selectedUrl) return true;
  return false;
}

/** Escape HTML special characters to prevent XSS when inserting into innerHTML */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast toast-${type} show`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

const followUpBlockTimers = {};
let followUpBlockInterval = null;
const FOLLOW_UP_BLOCK_MINUTES = 2.5;
const FOLLOW_UP_POLL_INTERVAL_MS = 10000;

function isFollowUpBlocked(taskId) {
  const expiry = state.followUpBlocked[taskId];
  return expiry && expiry > Date.now();
}

function isFollowUpChecking(taskId) {
  return !!state.followUpChecking[taskId];
}

async function autoCheckActiveFollowUpTask() {
  const currentThreadProspectId = getCurrentThreadProspectId();
  if (!currentThreadProspectId || state.tasks.length === 0) return;

  const activeTask = state.tasks.find(t => {
    if (state.actionedTasks[t.id]) return false;
    return t.prospect_id && normalizeProspectId(t.prospect_id) === currentThreadProspectId;
  });
  if (!activeTask) return;
  if (isFollowUpBlocked(activeTask.id) || isFollowUpChecking(activeTask.id)) return;

  state.followUpChecking[activeTask.id] = true;
  render();

  try {
    await ensureFollowUpChatUpToDate(activeTask.id);
  } catch (err) {
    console.error('Auto follow-up chat check failed:', err);
  } finally {
    delete state.followUpChecking[activeTask.id];
    render();
  }
}

function getFollowUpTimeRemaining(taskId) {
  const expiry = state.followUpBlocked[taskId];
  if (!expiry) return 0;
  return Math.max(0, expiry - Date.now());
}

function formatDurationMs(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function getFollowUpBlockTitle(taskId) {
  const remaining = getFollowUpTimeRemaining(taskId);
  const remainingText = remaining ? `Time remaining: ${formatDurationMs(remaining)}.` : '';
  return `Action blocked for up to ${FOLLOW_UP_BLOCK_MINUTES} minutes while the chat syncs — usually unblocks within seconds. ${remainingText}`;
}

function startFollowUpCountdown() {
  if (followUpBlockInterval) return;
  followUpBlockInterval = setInterval(() => {
    const anyBlocked = Object.keys(state.followUpBlocked).some(isFollowUpBlocked);
    if (!anyBlocked) {
      clearInterval(followUpBlockInterval);
      followUpBlockInterval = null;
      return;
    }
    render();
  }, 1000);
}

function blockFollowUpTask(taskId, minutes = FOLLOW_UP_BLOCK_MINUTES) {
  const expiry = Date.now() + minutes * 60 * 1000;
  state.followUpBlocked[taskId] = expiry;
  if (followUpBlockTimers[taskId]) {
    clearTimeout(followUpBlockTimers[taskId]);
  }
  followUpBlockTimers[taskId] = setTimeout(() => {
    if (state.followUpBlocked[taskId] === expiry) {
      delete state.followUpBlocked[taskId];
      delete followUpBlockTimers[taskId];
      if (STEPS[state.currentStep]?.key === 'follow_up') {
        loadAllTasks();
      } else {
        render();
      }
    }
  }, minutes * 60 * 1000);
  startFollowUpCountdown();
}

function blockAndPollFollowUpTask(taskId, newMessageIds) {
  blockFollowUpTask(taskId, FOLLOW_UP_BLOCK_MINUTES);

  function poll() {
    if (!isFollowUpBlocked(taskId)) return;
    apiPost('/api/messages/check-existing', { message_ids: newMessageIds })
      .then(checkRes => {
        if (!isFollowUpBlocked(taskId)) return;
        const existingSet = new Set(checkRes.existing || []);
        const allProcessed = newMessageIds.every(id => existingSet.has(id));
        if (allProcessed) {
          delete state.followUpBlocked[taskId];
          if (followUpBlockTimers[taskId]) {
            clearTimeout(followUpBlockTimers[taskId]);
            delete followUpBlockTimers[taskId];
          }
          if (STEPS[state.currentStep]?.key === 'follow_up') {
            loadAllTasks();
          } else {
            render();
          }
        } else if (isFollowUpBlocked(taskId)) {
          setTimeout(poll, FOLLOW_UP_POLL_INTERVAL_MS);
        }
      })
      .catch(() => {
        if (isFollowUpBlocked(taskId)) setTimeout(poll, FOLLOW_UP_POLL_INTERVAL_MS);
      });
  }

  setTimeout(poll, FOLLOW_UP_POLL_INTERVAL_MS);
}

function scrapeChatFromActiveTab(cutoffMs = 0) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        return reject(new Error('No active tab found.'));
      }
      chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CHAT', cutoffMs }, response => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message || 'Could not reach the LinkedIn page.'));
        }
        if (!response) {
          return reject(new Error('No response from the LinkedIn page.'));
        }
        if (response.error) {
          return reject(new Error(response.error));
        }
        resolve(response.data);
      });
    });
  });
}

function extractProspectIdFromActiveThread() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        return reject(new Error('No active tab found.'));
      }
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_THREAD_CONTACT_ID' }, response => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message || 'Could not reach the LinkedIn page.'));
        }
        if (!response || !response.data) {
          return reject(new Error('No response from the LinkedIn page.'));
        }
        resolve(response.data);
      });
    });
  });
}

let threadProspectRefreshSeq = 0;
const THREAD_PROSPECT_POLL_DELAYS_MS = [0, 500, 1000, 2000, 3500];

function onCurrentThreadProspectIdChanged() {
  if (state.view !== 'main' || state.loading || state.tasks.length === 0) return;
  const step = STEPS[state.currentStep];
  if (step.key === 'follow_up') {
    autoCheckActiveFollowUpTask().catch(() => {});
    render();
  } else if (step.key === 'connection_request') {
    render();
  }
}

async function refreshCurrentThreadProspectId() {
  const seq = ++threadProspectRefreshSeq;
  if (!isMessagingThreadUrl(state.currentTabUrl)) {
    state.currentThreadProspectId = '';
    return;
  }
  // LinkedIn renders the thread header asynchronously after the URL changes —
  // and may briefly still show the previous conversation — so a single read is
  // unreliable. Poll a few times and let the last settled value win; each poll
  // round is abandoned as soon as a newer refresh starts.
  for (const delay of THREAD_PROSPECT_POLL_DELAYS_MS) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (seq !== threadProspectRefreshSeq) return;
    let id = '';
    try {
      const data = await extractProspectIdFromActiveThread();
      id = normalizeProspectId(data.profile_id || '');
    } catch (_) {}
    if (seq !== threadProspectRefreshSeq) return;
    if (id !== state.currentThreadProspectId) {
      state.currentThreadProspectId = id;
      onCurrentThreadProspectIdChanged();
    }
  }
}

async function ensureFollowUpChatUpToDate(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return { upToDate: true };

  const isMessagingThread = /linkedin\.com\/messaging\/(thread|conversations)\//i.test(state.currentTabUrl);
  if (!isMessagingThread) {
    return { upToDate: true };
  }

  const customer = state.customers.find(c => (c.profiles || []).some(p => String(p.id) === String(state.appliedProfileId)));
  const profile = customer ? (customer.profiles || []).find(p => String(p.id) === String(state.appliedProfileId)) : null;
  const customerId = profile?.profile_id || '';
  if (!customerId) {
    throw new Error('Could not determine the selected LinkedIn profile for chat verification. Reload follow-up tasks and try again.');
  }

  const chat = await scrapeChatFromActiveTab(0);
  const unknownSenderCount = chat.messages.filter(m => m.sender_id === null).length;
  if (unknownSenderCount > 0) {
    throw new Error('Unable to verify chat because some messages have unknown sender direction. Open the thread in Messaging step, fix the unknown messages, then try again.');
  }

  const messageIds = chat.messages.map(m => m.message_id).filter(Boolean);
  if (messageIds.length === 0) {
    throw new Error('No chat messages were found in the active thread. Scroll up to load messages and try again.');
  }

  const checkRes = await apiPost('/api/messages/check-existing', { message_ids: messageIds });
  const existingSet = new Set(checkRes.existing || []);
  const newMessages = chat.messages.filter(m => !existingSet.has(m.message_id));
  if (newMessages.length === 0) {
    return { upToDate: true };
  }

  await apiPost('/api/extension/robot-linkedin-chat', {
    messages: newMessages,
    profile_id: chat.profile_id,
    customer_id: customerId,
  });

  const newMessageIds = newMessages.map(m => m.message_id).filter(Boolean);
  blockAndPollFollowUpTask(taskId, newMessageIds);
  return { upToDate: false, newMessageCount: newMessages.length };
}

// =============================================================================
// API
// =============================================================================

async function apiGet(path) {
  if (!state.backendUrl || !state.backendUrl.startsWith('http')) {
    throw new Error(`Invalid backend URL: ${state.backendUrl}. Please log in again.`);
  }
  const fullUrl = `${state.backendUrl}${path}`;
  const res = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (res.status === 401 || res.status === 403) {
    handleSessionExpired();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function apiPost(path, body) {
  if (!state.backendUrl || !state.backendUrl.startsWith('http')) {
    throw new Error(`Invalid backend URL: ${state.backendUrl}. Please log in again.`);
  }
  const fullUrl = `${state.backendUrl}${path}`;
  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    handleSessionExpired();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function reportBlockedUserMistake(report) {
  try {
    const reportKey = `${report.action}|${report.reason}|${report.selectedProspectId || ''}|${report.selectedProspectUrl || ''}|${report.overlayProspectId || ''}|${report.overlayProfileUrl || ''}`;
    if (state.lastBlockedReportKey === reportKey) return;
    state.lastBlockedReportKey = reportKey;
    await apiPost('/api/extension/report-user-mistake', report);
  } catch (_) {
    // Ignore reporting failures; do not interrupt user flow.
  }
}

// =============================================================================
// CHROME STORAGE
// =============================================================================

function loadStoredAuth() {
  return new Promise(resolve => {
    chrome.storage.local.get(['token', 'backendUrl', 'userName', 'userType'], data => {
      if (data.token) state.token = data.token;
      if (data.userName) state.userName = data.userName;
      if (data.userType) state.userType = data.userType;
      // Only update backendUrl if we have a stored value, otherwise keep default
      if (data.backendUrl && typeof data.backendUrl === 'string' && data.backendUrl.trim()) {
        state.backendUrl = data.backendUrl.trim();
      }
      resolve();
    });
  });
}

function saveAuth(token, backendUrl, userName, userType) {
  return new Promise(resolve => chrome.storage.local.set({ token, backendUrl, userName, userType }, resolve));
}

function clearAuth() {
  return new Promise(resolve => chrome.storage.local.remove(['token', 'backendUrl', 'userName', 'userType'], resolve));
}

// =============================================================================
// DATA FETCHING
// =============================================================================

async function loginRequest(backendUrl, email, password) {
  const res = await fetch(`${backendUrl}/api/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Login failed (${res.status})`);
  }
  return res.json();
}

async function fetchCustomers() {
  let all = [];
  let page = 1;
  while (true) {
    const data = await apiGet(
      `/api/customers?populate[profiles]=true&filters[lead_phase][$eq]=Active&pagination[page]=${page}&pagination[pageSize]=100`
    );
    const batch = (data.data || []).map(c => ({
      id: c.id,
      customer_name: c.customer_name,
      profiles: (c.profiles || []).map(p => ({ id: p.id, profile_name: p.profile_name, profile_id: p.profile_id || '' })),
    }));
    all = all.concat(batch);
    if (all.length >= (data.meta?.pagination?.total || 0)) break;
    page++;
  }
  return all.sort((a, b) => a.customer_name.localeCompare(b.customer_name));
}

async function loadCampaigns(profileId) {
  state.loadingCampaigns = true;
  state.campaigns = [];
  try {
    const result = await apiGet(`/api/extension/campaigns?profileId=${profileId}`);
    state.campaigns = (result.data || []).map(c => ({
      id: c.id,
      campaign_name: c.campaign_name,
      live: c.live ?? false,
    }));
  } catch (err) {
    console.error('Failed to load campaigns:', err);
    showToast('Failed to load campaigns: ' + err.message, 'error');
    state.campaigns = [];
  } finally {
    state.loadingCampaigns = false;
    render();
  }
}

async function loadAllTasks() {
  state.loading = true;
  state.error = null;
  state.tasks = [];
  state.currentIndex = 0;
  state.actionedTasks = {};
  state.contactDetails = {};
  render();

  try {
    const step = STEPS[state.currentStep];
    let all = [];

    if (step.key === 'revoke_connection_request') {
      // Use dedicated extension endpoint — single request, no pagination
      const params = new URLSearchParams();
      if (state.appliedProfileId) params.append('profileId', state.appliedProfileId);
      if (state.appliedCampaignId) params.append('campaignId', state.appliedCampaignId);
      if (state.appliedLinkedInSearch) params.append('profileUrlSearch', state.appliedLinkedInSearch);

      const result = await apiGet(`/api/extension/revoke-tasks?${params.toString()}`);
      // Only show tasks with due_date today or in the past
      const today = new Date();
      today.setHours(23, 59, 59, 999);
      all = (result.data || []).filter(t => {
        if (!t.due_date) return true;
        return new Date(t.due_date) <= today;
      });
    } else if (step.key === 'connection_request') {
      // Use dedicated extension endpoint for Connection Request tasks
      const params = new URLSearchParams();
      if (state.appliedProfileId) params.append('profileId', state.appliedProfileId);
      if (state.appliedCampaignId) params.append('campaignId', state.appliedCampaignId);
      if (state.appliedLinkedInSearch) params.append('profileUrlSearch', state.appliedLinkedInSearch);

      const result = await apiGet(`/api/extension/connection-request-tasks?${params.toString()}`);
      all = result.data || [];
    } else if (step.key === 'follow_up') {
      // Use dedicated extension endpoint for Follow-Up tasks
      const params = new URLSearchParams();
      if (state.appliedProfileId) params.append('profileId', state.appliedProfileId);
      if (state.appliedCampaignId) params.append('campaignId', state.appliedCampaignId);
      if (state.appliedLinkedInSearch) params.append('profileUrlSearch', state.appliedLinkedInSearch);

      const result = await apiGet(`/api/extension/follow-up-tasks?${params.toString()}`);
      all = result.data || [];
    } else if (step.key === 'chatter_tasks') {
      // Use dedicated extension endpoint for Chatter Tasks
      const params = new URLSearchParams();
      if (state.appliedProfileId) params.append('profileId', state.appliedProfileId);
      if (state.appliedCampaignId) params.append('campaignId', state.appliedCampaignId);
      if (state.appliedLinkedInSearch) params.append('profileUrlSearch', state.appliedLinkedInSearch);

      const result = await apiGet(`/api/extension/chatter-tasks?${params.toString()}`);
      all = result.data || [];

      // Initialise per-task tag selection from existing prospect tags
      state.chatterTaskTags = {};
      for (const task of all) {
        state.chatterTaskTags[task.documentId] = Array.isArray(task.tags_relation)
          ? task.tags_relation.slice()
          : [];
      }
      // Restore chatter sent/disconnected state from this browser session
      restoreChatterStateForTasks(all);
      // Fire-and-forget: load all available tags for the tag picker
      loadAvailableTags();
      // Fire-and-forget: load Other DMU campaigns per profile
      loadOtherDmuCampaigns(all);
    } else {
      // Default: paginated fetch from all-robot-tasks
      let page = 1;
      const pageSize = 50;

      while (true) {
        const params = new URLSearchParams();
        params.append('page', String(page));
        params.append('pageSize', String(pageSize));
        params.append('profileIds', state.appliedProfileId);
        params.append('dataTypes', 'Connection Details');
        params.append('dataTypes', 'Revoke connection request');
        if (state.appliedLinkedInSearch) params.append('profileUrlSearch', state.appliedLinkedInSearch);
        if (state.appliedCampaignId) params.append('campaignIds', state.appliedCampaignId);

        const result = await apiGet(`/api/all-robot-tasks?${params.toString()}`);
        all = all.concat(result.data || []);
        if (all.length >= (result.meta?.pagination?.total || 0)) break;
        page++;
      }
    }

      // Restore actioned state for any task IDs already handled this session
      restoreActionedStateForTasks(all);

      state.tasks = all;
      state.totalTasks = all.length;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function lookupConnection() {
  state.loading = true;
  state.error = null;
  state.acceptanceResult = null;
  state.tasks = [];
  state.currentIndex = 0;
  state.actionedTasks = {};
  state.contactDetails = {};
  render();

  try {
    const params = new URLSearchParams();
    params.append('profileId', state.appliedProfileId);
    if (state.appliedProspectId) {
      params.append('prospectId', state.appliedProspectId);
    } else if (state.appliedProspectUrl) {
      // Backup: look up by LinkedIn profile URL (extracted from hovering the name)
      params.append('profileUrl', state.appliedProspectUrl);
    }

    const result = await apiGet(`/api/extension/connection-acceptance?${params.toString()}`);
    state.acceptanceResult = result;

    // If a task is returned, put it in the tasks array so the card UI can render it
    if (result.task) {
      state.tasks = [result.task];
      state.totalTasks = 1;
    }

    // Non-actionable results: unpin the prospect so the next hover immediately updates the input.
    // Actionable results (open_task, first_connection) stay pinned so the user can act on them.
    if (result.status === 'already_connected' || result.status === 'already_first_connected') {
      state.pendingProspectId   = '';
      state.pendingProspectName = '';
      state.pendingProspectUrl  = '';
      state.appliedProspectId   = '';
      state.appliedProspectUrl  = '';
    }
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

// =============================================================================
// ACTION HANDLERS
// =============================================================================

async function handleConnect(taskId) {
  if (isConnectionAcceptanceOverlayMismatch()) {
    showToast('Current contact info overlay does not match the selected prospect.', 'error');
    return;
  }

  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  if (state.actionedTasks[taskId]) return; // guard double-click
  const contact = state.contactDetails[taskId] || {};

  // Check if Date Connected is filled
  if (!contact.date_connected || contact.date_connected.trim() === '') {
    showToast('Please fill in the Date Connected field before connecting.', 'error');
    return;
  }

  state.actionedTasks[taskId] = 'sending';
  render();
  try {
    await apiPost('/api/data-senders/connect', {
      ...task,
      email: contact.email || '',
      phone: contact.phone || '',
      birthday: contact.birthday || '',
      date_connected: contact.date_connected || '',
    });
    state.actionedTasks[taskId] = 'connected';
    state.pendingProspectId = '';
    state.pendingProspectName = '';
    state.pendingProspectUrl = '';
    saveActionedState();
    showToast('Connection confirmation sent!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    delete state.actionedTasks[taskId];
    showToast('Error: ' + err.message, 'error');
    render();
  }
}

async function handleConnectionRequest(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  if (state.actionedTasks[taskId]) return; // guard double-click
  state.actionedTasks[taskId] = 'sending'; // optimistic lock
  render();
  try {
    await apiPost('/api/data-senders/connection_request', task);
    state.actionedTasks[taskId] = 'sent';
    saveActionedState();
    showToast('Connection request sent!', 'success');
    render();
  } catch (err) {
    delete state.actionedTasks[taskId];
    showToast('Error: ' + err.message, 'error');
    render();
  }
}

async function handleFollowUp(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  if (state.actionedTasks[taskId]) return; // guard double-click
  if (isFollowUpBlocked(taskId)) {
    showToast('Follow-up is temporarily blocked while we update the chat in the backend.', 'error');
    return;
  }

  state.actionedTasks[taskId] = 'sending'; // optimistic lock
  state.followUpChecking[taskId] = true;
  render();
  try {
    const chatCheck = await ensureFollowUpChatUpToDate(taskId);
    if (!chatCheck.upToDate) {
      await reportBlockedUserMistake({
        action: 'follow_up',
        reason: 'chat_not_up_to_date',
        note: 'System blocked follow-up because the chat had new unread updates before sending.',
        profileId: state.appliedProfileId || null,
        profileName: task.campaign_prospect?.campaign?.profile?.profile_name || getAppliedProfileName() || null,
        taskId: taskId || null,
        taskProfileUrl: task.profile_url || null,
        taskProspectId: task.prospect_id || null,
        currentTabUrl: state.currentTabUrl || null,
        newMessageCount: chatCheck.newMessageCount || 0,
      });
      delete state.actionedTasks[taskId];
      render();
      showToast(`New chat updates were sent to the backend. This follow-up will unblock automatically once the backend has processed them (up to ${FOLLOW_UP_BLOCK_MINUTES} minutes).`, 'error');
      return;
    }

    await apiPost('/api/extension/follow-up', task);
    state.actionedTasks[taskId] = 'sent';
    saveActionedState();
    showToast('Follow-up sent!', 'success');
    render();
  } catch (err) {
    delete state.actionedTasks[taskId];
    showToast('Error: ' + err.message, 'error');
    render();
  } finally {
    delete state.followUpChecking[taskId];
  }
}

async function handleRevoke(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  if (state.actionedTasks[taskId]) return;
  state.actionedTasks[taskId] = 'sending';
  render();
  try {
    await apiPost('/api/data-senders/revoke', task);
    state.actionedTasks[taskId] = 'revoked';
    saveActionedState();
    showToast('Revoke confirmation sent!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    delete state.actionedTasks[taskId];
    showToast('Error: ' + err.message, 'error');
    render();
  }
}

async function handleDisconnect(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId))
    || (state.acceptanceResult?.task && String(state.acceptanceResult.task.id) === String(taskId) ? state.acceptanceResult.task : null);
  if (!task) return;
  if (state.actionedTasks[taskId]) return;
  state.actionedTasks[taskId] = 'sending';
  render();
  try {
    await apiPost('/api/data-senders/disconnect', task);
    state.actionedTasks[taskId] = 'disconnected';
    saveActionedState();
    showToast('Prospect disconnected!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    delete state.actionedTasks[taskId];
    showToast('Error: ' + err.message, 'error');
    render();
  }
}

function advanceQueue() {
  // Move to next non-actioned task
  for (let i = state.currentIndex + 1; i < state.tasks.length; i++) {
    if (!state.actionedTasks[state.tasks[i].id]) {
      state.currentIndex = i;
      render();
      return;
    }
  }
  // All remaining already actioned, just move pointer forward
  if (state.currentIndex < state.tasks.length - 1) {
    state.currentIndex++;
  }
  render();
}

async function handleFirstConnectionConnect() {
  if (isConnectionAcceptanceOverlayMismatch()) {
    showToast('Current contact info overlay does not match the selected prospect.', 'error');
    return;
  }

  const contact = state.contactDetails['fc'] || {};

  if (!contact.date_connected || contact.date_connected.trim() === '') {
    showToast('Please fill in the Date Connected field before connecting.', 'error');
    return;
  }

  try {
    // Use the prospect_id from the applied filter; if missing (URL-backup path),
    // fall back to the id resolved by the backend and returned in the result.
    const prospectId = state.appliedProspectId || state.acceptanceResult?.prospect?.prospect_id || '';
    // Pass the profile URL so the backend can derive a synthetic prospect_id
    // and store the linkedin_url on the prospect record when no real URN is available.
    const profileUrl = state.acceptanceResult?.profileUrl || state.appliedProspectUrl || '';

    await apiPost('/api/extension/connection-acceptance/first-connection', {
      profileId: state.appliedProfileId,
      prospectId,
      profileUrl,
      email: contact.email || '',
      phone: contact.phone || '',
      birthday: contact.birthday || '',
      date_connected: contact.date_connected || '',
    });
    state.actionedTasks['fc'] = 'connected';
    state.pendingProspectId = '';
    state.pendingProspectName = '';
    state.pendingProspectUrl = '';
    showToast('First connection registered!', 'success');
    state.acceptanceResult = { status: 'done' };
    render();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

// =============================================================================
// RENDERING
// =============================================================================

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = (state.view === 'login' ? buildLogin() : buildMain()) + buildCampaignContentPopup() + buildNotesPopup() + buildReplyTemplatesPopup() + buildChatPopup();
  attachListeners();
}

// --- Login ---

function buildLogin() {
  const isProduction = state.backendUrl === 'https://backend.leadblocks.nl';
  return `
    <div class="header">
      <img src="../assets/logo.png" alt="Leadblocks" class="logo" />
    </div>
    <div class="login-form">
      <h2>Sign in</h2>
      <div class="field">
        <label for="chk-production">Environment</label>
        <div class="checkbox-option">
          <input type="checkbox" id="chk-production" ${isProduction ? 'checked' : ''} />
          <span>Production</span>
          <span class="env-hint">${isProduction ? 'backend.leadblocks.nl' : 'localhost:1337'}</span>
        </div>
      </div>
      <div class="field">
        <label>Email</label>
        <input type="email" id="inp-email" placeholder="user@example.com" autocomplete="email" />
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" id="inp-password" placeholder="••••••••" autocomplete="current-password" />
      </div>
      <div id="login-error" class="error-msg" style="display:none"></div>
      <button id="btn-login" class="btn btn-primary">Sign in</button>
    </div>
  `;
}

// --- Main ---

function buildMain() {
  const step = STEPS[state.currentStep];
  return `
    <div class="header">
      <img src="../assets/logo.png" alt="Leadblocks" class="logo" />
      <div class="header-user">
        ${state.userName ? `<span class="header-username">${esc(state.userName)}</span>` : ''}
        <button id="btn-logout" class="btn-link">Logout</button>
      </div>
    </div>
    ${buildSteps()}
    ${buildFilters()}
    <div class="task-area">
      ${buildTaskArea()}
    </div>
  `;
}

// --- Steps ---

function buildSteps() {
  const items = STEPS.map((step, i) => {
    if (!isStepVisible(step)) return '';
    const isActive = i === state.currentStep;
    const isDone = i < state.currentStep;
    const cls = isActive ? 'step active' : isDone ? 'step done' : 'step';
    const num = i + 1;
    const titleText = step.enabled ? step.label : `${step.label} (coming soon)`;
    return `
      <button class="${cls}" data-step="${i}" ${!step.enabled ? 'disabled' : ''} title="${esc(titleText)}">
        <span class="step-num">${num}</span>
        ${isActive ? `<span class="step-label">${esc(step.label)}</span>` : ''}
      </button>
    `;
  }).join('');

  return `<div class="steps-bar">${items}</div>`;
}

// --- Filters ---

function buildFilters() {
  const profiles = getAvailableProfiles();
  const step = STEPS[state.currentStep];
  const isAcceptance = step.key === 'connection_acceptance';
  const isMessaging  = step.key === 'chat_scraper';

  const filtersChanged =
    state.pendingProfileId !== state.appliedProfileId ||
    state.pendingCampaignId !== state.appliedCampaignId ||
    state.pendingProspectId !== state.appliedProspectId ||
    state.pendingProspectUrl !== state.appliedProspectUrl ||
    state.pendingLinkedInSearch !== state.appliedLinkedInSearch;

  // For connection acceptance, require a prospect ID or URL; for other steps, require a profile.
  const canApply = isAcceptance
    ? state.pendingProfileId && (state.pendingProspectId.trim() !== '' || state.pendingProspectUrl.trim() !== '')
    : state.pendingProfileId && filtersChanged;

  const customerOptions = state.customers
    .map(c => `<option value="${c.id}" ${state.pendingCustomerId === String(c.id) ? 'selected' : ''}>${esc(c.customer_name)}</option>`)
    .join('');

  const profileOptions = profiles
    .map(p => `<option value="${p.id}" ${state.pendingProfileId === String(p.id) ? 'selected' : ''}>${esc(p.profile_name)}</option>`)
    .join('');

  const campaignOptions = state.campaigns
    .map(c => `<option value="${c.id}" ${state.pendingCampaignId === String(c.id) ? 'selected' : ''}>${c.live ? '🟢 ' : ''}${esc(c.campaign_name)}</option>`)
    .join('');

  // Messaging tab: only customer + profile, no apply button
  if (isMessaging) {
    return `
      <div class="filters">
        <div class="filter-row">
          <div class="filter-field">
            <label>Customer <button id="btn-refresh-customers" class="btn-refresh" title="Refresh customers & profiles" ${state.loadingCustomers ? 'disabled' : ''}>${state.loadingCustomers ? '⟳' : '↻'}</button></label>
            <select id="sel-customer" ${state.loadingCustomers ? 'disabled' : ''}>
              <option value="">— select —</option>
              ${customerOptions}
            </select>
          </div>
          <div class="filter-field">
            <label>Profile</label>
            <select id="sel-profile" ${profiles.length === 0 ? 'disabled' : ''}>
              <option value="">— select —</option>
              ${profileOptions}
            </select>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="filters">
      <div class="filter-row">
        <div class="filter-field">
          <label>Customer <button id="btn-refresh-customers" class="btn-refresh" title="Refresh customers & profiles" ${state.loadingCustomers ? 'disabled' : ''}>${state.loadingCustomers ? '⟳' : '↻'}</button></label>
          <select id="sel-customer" ${state.loadingCustomers ? 'disabled' : ''}>
            <option value="">— select —</option>
            ${customerOptions}
          </select>
        </div>
        <div class="filter-field">
          <label>Profile</label>
          <select id="sel-profile" ${profiles.length === 0 ? 'disabled' : ''}>
            <option value="">— select —</option>
            ${profileOptions}
          </select>
        </div>
      </div>
      ${isAcceptance ? `
      <div class="filter-row">
        <div class="filter-field" style="flex:1">
          <label>Prospect <span class="info-icon" data-tooltip="Hover the Bericht/Message button to auto-fill. If hover doesn't work, hover the person's name link. As a last resort, paste the LinkedIn profile URL directly.">i</span></label>
          <div class="prospect-input-row">
            <input type="text" id="inp-prospect-id"
              value="${esc(state.pendingProspectName || state.pendingProspectId || state.pendingProspectUrl)}"
              placeholder="Hover Bericht button, hover name, or paste LinkedIn URL…" />
            ${(state.pendingProspectId || state.pendingProspectUrl) ? `<button id="btn-clear-prospect" class="btn-clear" title="Clear">&times;</button>` : ''}
          </div>
        </div>
      </div>
      ` : `
      <div class="filter-row">
        <div class="filter-field">
          <label>Campaign</label>
          <select id="sel-campaign" ${state.campaigns.length === 0 ? 'disabled' : ''}>
            <option value="">— all campaigns —</option>
            ${campaignOptions}
          </select>
        </div>
        <div class="filter-field">
          <label>LinkedIn URL</label>
          <input type="text" id="inp-linkedin" value="${esc(state.pendingLinkedInSearch)}" placeholder="Search URL..." />
        </div>
      </div>
      `}
      <div class="filter-btn-row">
        <button id="btn-apply" class="btn btn-primary btn-filter-full" ${!canApply ? 'disabled' : ''}>Filter</button>
        <button id="btn-reset" class="btn btn-secondary btn-filter-full">Reset</button>
      </div>
    </div>
  `;
}

// --- Task area ---

function buildDisconnectBtn(tid, size = 'btn-sm') {
  return `<button class="btn btn-danger ${size}" data-action="disconnect" data-tid="${esc(tid)}">Disconnect</button>`;
}

function buildTaskArea() {
  const step = STEPS[state.currentStep];

  // Chat Scraper step — fully self-contained, no profile/task guards needed
  if (step.key === 'chat_scraper') {
    return buildChatScraperArea();
  }

  // Steps 2-5 are not yet implemented
  if (!step.enabled) {
    return `<div class="empty-state" style="padding:32px 0"><strong>${esc(step.label)}</strong><br><br>Coming soon — this step is being built.</div>`;
  }

  if (state.loading) {
    return `<div class="loading"><div class="spinner"></div><span>Loading tasks…</span></div>`;
  }
  if (state.error) {
    return `<div class="error-msg">Couldn't load tasks: ${esc(state.error)}</div>`;
  }
  if (!state.appliedProfileId) {
    return `<div class="empty-state">👆 Pick a customer & profile above, then press <strong>Filter</strong>.</div>`;
  }

  // Step 1: Connection acceptance — single-lookup flow
  if (step.key === 'connection_acceptance') {
    return buildConnectionAcceptanceArea();
  }

  if (state.tasks.length === 0) {
    return `<div class="empty-state">🎉 All caught up — no ${esc(step.label.toLowerCase())} tasks right now.</div>`;
  }

  // Revoke step uses compact list view
  if (step.key === 'revoke_connection_request') {
    return buildRevokeList();
  }

  // Connection Request step uses compact list view
  if (step.key === 'connection_request') {
    return buildConnectionRequestList();
  }

  // Follow-Up step uses compact list view
  if (step.key === 'follow_up') {
    return buildFollowUpList();
  }

  // Chatter Tasks step
  if (step.key === 'chatter_tasks') {
    return buildChatterTasksList();
  }

  return `${buildQueueMode()}`;
}

// --- Connection acceptance (step 1) ---

function buildConnectionAcceptanceArea() {
  const r = state.acceptanceResult;

  // No lookup performed yet
  if (!r) {
    return `<div class="empty-state">Go to <a href="https://www.linkedin.com/mynetwork/invite-connect/connections/" target="_blank" class="hint-link">your connections page</a> and hover over the <strong>Bericht</strong> button for the prospect that connected. The prospect filter will be filled, then press Filter. If the button isn't detected, hover their <strong>name</strong> instead, or paste the LinkedIn URL directly.</div>`;
  }

  // Already actioned in this session
  if (r.task && state.actionedTasks[r.task.id]) {
    const label = state.actionedTasks[r.task.id];
    return `
      <div class="success-card">
        <div class="success-icon">✓</div>
        <div class="success-title">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</div>
        <div class="success-hint">Hover over the next <strong>Bericht</strong> button (or their name) and press Filter again.</div>
      </div>
    `;
  }

  // status: 'open_task' — revoke task found, show card so user can handle it
  if (r.status === 'open_task' && r.task) {
    const task = r.task;
    const contact = state.contactDetails[task.id] || { email: '', phone: '', birthday: '', date_connected: '' };
    const campaignHtml = buildCampaignPill(task);
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
    const overlayMismatch = isConnectionAcceptanceOverlayMismatch();

    return `
      <div class="task-card" style="margin:12px 0">
        ${task.profile_url ? `<div class="task-url"><a href="${esc(task.profile_url)}" class="profile-url" target="_blank">${esc(task.profile_url)}</a></div>` : ''}
        <div class="task-meta">
          <span class="badge badge-accept">Accept</span>
          ${campaignHtml}
          ${dueHtml}
        </div>

        <div class="task-section">
          <div class="contact-grid">
            <div class="contact-field">
              <label>Email <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="email" class="ci" data-tid="${task.id}" data-field="email" value="${esc(contact.email)}" placeholder="email@example.com" />
            </div>
            <div class="contact-field">
              <label>Phone <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="tel" class="ci" data-tid="${task.id}" data-field="phone" value="${esc(contact.phone)}" placeholder="+31 6 ..." />
            </div>
            <div class="contact-field">
              <label>Birthday <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="text" class="ci" data-tid="${task.id}" data-field="birthday" value="${esc(contact.birthday)}" placeholder="DD-MM-YYYY" />
            </div>
            <div class="contact-field">
              <label>Date Connected <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="date" class="ci" data-tid="${task.id}" data-field="date_connected" value="${esc(contact.date_connected)}" />
            </div>
          </div>
        </div>
        <div class="task-actions">
          <button class="btn btn-primary btn-sm" data-action="connect" data-tid="${task.id}"${overlayMismatch ? ' disabled title="Current contact info does not match selected prospect, navigate to the correct prospect please" data-tooltip="Current contact info does not match selected prospect, navigate to the correct prospect please"' : ''}>Connect</button>
          <button class="btn btn-revoke btn-sm" data-action="revoke" data-tid="${task.id}">Revoke</button>
          ${buildDisconnectBtn(task.id, 'btn-sm')}
        </div>
      </div>
    `;
  }

  // status: 'already_connected' or 'already_first_connected' — no action needed
  if (r.status === 'already_connected' || r.status === 'already_first_connected') {
    const msg = r.status === 'already_first_connected'
      ? 'Already registered as a first connection.'
      : 'This prospect was already processed. No action needed.';
    return `
      <div class="empty-state" style="padding:24px 0">
        <strong>Already connected</strong><br><br>
        ${msg}<br>
        Hover over the next Bericht button and press Filter.
      </div>
    `;
  }

  // status: 'first_connection' — no revoke task found, allow first-connection connect
  if (r.status === 'first_connection') {
    const contact = state.contactDetails['fc'] || { email: '', phone: '', birthday: '', date_connected: '' };
    const prospect = r.prospect;
    const displayName = state.pendingProspectName || (prospect ? `${prospect.first_name || ''} ${prospect.last_name || ''}`.trim() : '') || state.appliedProspectId;
    const prospectLabel = prospect
      ? `Known prospect${prospect.first_name || prospect.last_name ? `: ${esc(prospect.first_name)} ${esc(prospect.last_name)}`.trim() : ''}`
      : 'New prospect';
    const overlayMismatch = isConnectionAcceptanceOverlayMismatch();

    return `
      <div class="task-card" style="margin:12px 0">
        <div class="task-url"><span class="profile-url">${esc(displayName)}</span></div>
        <div class="task-meta">
          <span class="badge badge-accept">First Connection</span>
        </div>
        <p style="font-size:11px;color:var(--muted);margin:6px 0 10px;padding-left:16px;line-height:1.4;opacity:0.8">${prospectLabel}</p>

        <div class="task-section">
          <div class="contact-grid">
            <div class="contact-field">
              <label>Email <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="email" class="ci" data-tid="fc" data-field="email" value="${esc(contact.email)}" placeholder="email@example.com" />
            </div>
            <div class="contact-field">
              <label>Phone <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="tel" class="ci" data-tid="fc" data-field="phone" value="${esc(contact.phone)}" placeholder="+31 6 ..." />
            </div>
            <div class="contact-field">
              <label>Birthday <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="text" class="ci" data-tid="fc" data-field="birthday" value="${esc(contact.birthday)}" placeholder="DD-MM-YYYY" />
            </div>
            <div class="contact-field">
              <label>Date Connected <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
              <input type="date" class="ci" data-tid="fc" data-field="date_connected" value="${esc(contact.date_connected)}" />
            </div>
          </div>
        </div>
        <div class="task-actions">
          <button class="btn btn-primary btn-sm" id="btn-fc-connect"${overlayMismatch ? ' disabled title="Current contact info does not match selected prospect, navigate to the correct prospect please" data-tooltip="Current contact info does not match selected prospect, navigate to the correct prospect please"' : ''}>Connect</button>
        </div>
      </div>
    `;
  }

  // Fallback
  return `<div class="empty-state">No result. Hover over the Bericht button and press Filter.</div>`;
}

// --- Connection Request list ---

function buildConnectionRequestList() {
  // If the user is currently on a LinkedIn profile that matches one of the pending tasks,
  // only show that task — hide all others to prevent accidentally copying/sending the wrong message.
  const activeTask = state.tasks.find(t => !state.actionedTasks[t.id] && t.profile_url && urlMatches(t.profile_url, state.currentTabUrl));
  const visibleTasks = activeTask ? state.tasks.filter(t => state.actionedTasks[t.id] || t.id === activeTask.id) : state.tasks;
  const hiddenCount = state.tasks.length - visibleTasks.length;

  const rows = visibleTasks.map(task => {
    const isActioned = !!state.actionedTasks[task.id];
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
    const campaignHtml = buildCampaignPill(task);
    const name = [task.first_name, task.last_name].filter(Boolean).join(' ');

    const isActive = !isActioned && task.profile_url && urlMatches(task.profile_url, state.currentTabUrl);

    if (isActioned) {
      return `
        <div class="revoke-row revoke-row-actioned">
          <div class="revoke-line1">
            ${task.profile_url ? `<a href="${esc(task.profile_url)}" class="revoke-url" data-cr-nav="${esc(task.profile_url)}">${esc(task.profile_url)}</a>` : ''}
            ${dueHtml}
          </div>
          <div class="revoke-line2">
            ${campaignHtml}
            <span class="actioned-inline">sent</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="revoke-row${isActive ? ' cr-row-active' : ''}">
        <div class="revoke-line1">
          ${task.profile_url
            ? `<a href="${esc(task.profile_url)}" class="revoke-url" data-cr-nav="${esc(task.profile_url)}">${esc(task.profile_url)}</a>`
            : `<span class="revoke-url muted">${name || 'Unknown prospect'}</span>`}
          ${dueHtml}
        </div>
        <div class="revoke-line2">
          ${campaignHtml}
          <span class="revoke-actions">
            <button class="btn btn-send btn-xs${isActive ? ' cr-send-active' : ''}" data-action="connection_request" data-tid="${task.id}"${!isActive ? ' disabled title="Navigate to this profile to enable the Send button"' : ''}>Send</button>
            ${!isActioned && !isActive && task.profile_url ? `<button class="btn btn-ghost btn-xs" data-action="force_cr" data-tid="${task.id}" title="Force send: use only if this prospect's LinkedIn URL has changed">Force</button>` : ''}
            ${buildDisconnectBtn(task.id, 'btn-xs')}
          </span>
        </div>
        ${task.content ? `
        <div class="cr-content-wrap">
          <button class="cr-copy-btn" data-copy="${esc(task.content)}" title="Copy message">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          <div class="cr-content">${esc(task.content)}</div>
        </div>` : ''}
      </div>
    `;
  }).join('');

  const hiddenBanner = hiddenCount > 0
    ? `<div class="cr-hidden-banner">${hiddenCount} other task${hiddenCount !== 1 ? 's' : ''} hidden — navigate away from this profile to see all tasks</div>`
    : '';
  const checkBanner = activeTask
    ? `<div class="cr-check-banner">⚠ Double-check the message below before sending — make sure you're sending the right content to this prospect.</div>`
    : '';

  return `
    <div class="revoke-summary">${state.tasks.length} Connection Request task${state.tasks.length !== 1 ? 's' : ''} due</div>
    ${hiddenBanner}
    ${checkBanner}
    <div class="revoke-list">${rows}</div>
  `;
}

// --- Follow-Up list ---

function getFollowUpLabel(dataType) {
  const numMatch = dataType && dataType.match(/(\d)/);
  const num = numMatch ? numMatch[1] : '?';
  const isMessenger = dataType && dataType.includes('messenger');
  return `FU${num}${isMessenger ? ' (Msg)' : ''}`;
}

function buildFollowUpList() {
  const currentThreadProspectId = getCurrentThreadProspectId();
  // Primary: match the prospect of the open messaging thread.
  // Backup: the prospect can't always be found in the messaging page — also
  // unlock when the user is on the prospect's profile page itself.
  const activeTask = state.tasks.find(t => {
    if (state.actionedTasks[t.id]) return false;
    return currentThreadProspectId && t.prospect_id && normalizeProspectId(t.prospect_id) === currentThreadProspectId;
  }) || state.tasks.find(t =>
    !state.actionedTasks[t.id] && t.profile_url && urlMatches(t.profile_url, state.currentTabUrl)
  );
  const sortedTasks = activeTask ? [activeTask, ...state.tasks.filter(t => t.id !== activeTask.id)] : state.tasks;
  const hasActiveTask = !!activeTask;

  const rows = sortedTasks.map(task => {
    const isActioned = !!state.actionedTasks[task.id];
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
    const campaignHtml = buildCampaignPill(task);
    const name = [task.first_name, task.last_name].filter(Boolean).join(' ');
    const fuLabel = getFollowUpLabel(task.data_type);

    const isActive = !isActioned && hasActiveTask ? task.id === activeTask.id : false;
    const isBlocked = isFollowUpBlocked(task.id);
    const isChecking = isFollowUpChecking(task.id);
    const blockTitle = isBlocked ? getFollowUpBlockTitle(task.id) : '';
    const followUpButtonActive = isActive && !isBlocked && !isChecking;
    const notRightChatTitle = "Open this prospect's chat or profile page to enable";
    const sendButtonTitle = isChecking
      ? 'Checking the chat...'
      : isBlocked
        ? blockTitle
        : (!followUpButtonActive ? notRightChatTitle : '');
    const disconnectDisabled = hasActiveTask ? !isActive : true;
    const copyButtonDisabled = hasActiveTask ? !isActive || isBlocked || isChecking : true;
    const rowClass = isActioned ? '' : (isActive ? ' cr-row-active' : ' cr-row-inactive');
    const rowStyle = isActive && (isBlocked || isChecking) ? 'position:relative;' : '';
    const overlayHtml = isActive && (isBlocked || isChecking) ? `
        <div style="position:absolute; inset:0; background:rgba(255,255,255,0.92); display:flex; align-items:center; justify-content:center; padding:14px; text-align:center; z-index:2; line-height:1.4;">
          <div style="max-width:320px;">
            <div style="font-weight:600; margin-bottom:8px; display:flex; align-items:center; justify-content:center; gap:8px;">
              <span style="font-size:16px;">⏳</span>
              ${isChecking ? 'Checking chat…' : 'Synchronizing chat…'}
            </div>
            <div style="font-size:13px; color:#333;">
              ${isChecking
                ? 'This is the correct task for the prospect, but actions are temporarily blocked while the chat is verified first.'
                : 'If you have already sent the follow-up before the check is over, delete it NOW (LinkedIn gives us 5 minutes to do this).'}
            </div>
          </div>
        </div>` : '';

    if (isActioned) {
      return `
        <div class="revoke-row revoke-row-actioned">
          <div class="revoke-line1">
            ${task.profile_url ? `<a href="${esc(task.profile_url)}" class="revoke-url" data-cr-nav="${esc(task.profile_url)}">${esc(task.profile_url)}</a>` : ''}
            <span class="badge badge-fu">${esc(fuLabel)}</span>
            ${dueHtml}
          </div>
          <div class="revoke-line2">
            ${campaignHtml}
            <span class="actioned-inline">sent</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="revoke-row${rowClass}"${rowStyle ? ` style="${rowStyle}"` : ''}>
        ${overlayHtml}
        <div class="revoke-line1">
          ${task.profile_url
            ? `<a href="${esc(task.profile_url)}" class="revoke-url" data-cr-nav="${esc(task.profile_url)}">${esc(task.profile_url)}</a>`
            : `<span class="revoke-url muted">${name || 'Unknown prospect'}</span>`}
          <span class="badge badge-fu">${esc(fuLabel)}</span>
          ${dueHtml}
        </div>
        <div style="display: flex; gap: 6px; margin-top: 4px;">
          ${name ? `<button class="fu-name-chip" data-copy="${esc(name)}" title="Click to copy name">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${esc(name)}
          </button>` : ''}
          ${task.first_name ? `<button class="fu-name-chip" data-copy="${esc(task.first_name)}" title="Click to copy first name">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${esc(task.first_name)}
          </button>` : ''}
        </div>
        <div class="revoke-line2">
          ${campaignHtml}
          <span class="revoke-actions">
            <button class="btn btn-send btn-xs${followUpButtonActive ? ' cr-send-active' : ''}" data-action="follow_up" data-tid="${task.id}"${!followUpButtonActive ? ' disabled' : ''}${sendButtonTitle ? ` title="${esc(sendButtonTitle)}"` : ''}>Send</button>
            <button class="btn btn-danger btn-xs" data-action="disconnect" data-tid="${task.id}"${disconnectDisabled ? ` disabled title="${esc(notRightChatTitle)}"` : ''}>Disconnect</button>
          </span>
        </div>
        ${(isBlocked || isChecking) ? `<div class="small-note" style="margin-top:4px;color:#666;">${isChecking ? 'This task belongs to the correct prospect; the chat is being verified now. Actions are temporarily blocked.' : 'If you already sent the follow-up before the check is over, delete it NOW (LinkedIn gives us 5 minutes to do this).'} </div>` : ''}
        ${task.content && isActive ? `
        <div class="cr-content-wrap">
          <button class="cr-copy-btn" data-copy="${esc(task.content)}" title="${copyButtonDisabled ? esc(notRightChatTitle) : 'Copy message'}"${copyButtonDisabled ? ' disabled' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          <div class="cr-content">${esc(task.content)}</div>
        </div>` : ''}
      </div>
    `;
  });

  // Split the list so the single unlocked task is unmistakable: it sits alone
  // under "Ready to send"; everything else is grouped under "Locked".
  let listHtml;
  if (hasActiveTask) {
    const [activeRow, ...restRows] = rows;
    listHtml = `
      <div class="fu-list-label fu-list-label-ready">✓ Ready to send</div>
      ${activeRow}
      ${restRows.length ? `<div class="fu-list-label">🔒 Locked — open the prospect's chat or profile page to unlock</div>${restRows.join('')}` : ''}
    `;
  } else {
    listHtml = rows.join('');
  }

  const hasOpenTasks = state.tasks.some(t => !state.actionedTasks[t.id]);
  const noActiveBanner = !hasActiveTask && hasOpenTasks
    ? `<div class="cr-check-banner">
         <div>No task is unlocked. Open a prospect's chat to unlock their Send button.</div>
         <div class="fu-banner-tip">💡 Task not unlocking? Try <strong>switching chats</strong> first. If that doesn't work, try <strong>refreshing the page</strong> to sync the chat. If that still doesn't work, you can send from the prospect's <strong>profile page</strong> (click the task's link) as a last resort.</div>
       </div>`
    : '';

  return `
    <div class="revoke-summary">${state.tasks.length} Follow-Up task${state.tasks.length !== 1 ? 's' : ''} due</div>
    ${noActiveBanner}
    <div class="revoke-list">${listHtml}</div>
  `;
}

// --- Chatter Tasks list ---

function buildChatterTasksList() {
  const rows = state.tasks.map(task => {
    const tid = task.documentId;
    const action = state.chatterAction[tid] || '';
    const aiVariants = state.chatterAiSuggestion[tid] || [];
    const aiLoading = !!state.chatterAiLoading[tid];
    const aiError = state.chatterAiError[tid] || null;
    const aiNote = state.chatterAiNote[tid] || '';
    const aiSuggestionEnabled = isAiSuggestionEnabled(task);
    const sentKind = state.chatterSent[tid];
    const isDisconnected = !!state.chatterDisconnected[tid];
    const followUpChecked = !!state.chatterFollowUp[tid];
    const profileNumericId = task.campaign_prospect?.campaign?.profile?.id;
    const otherDmuCampaigns = profileNumericId
      ? (state.otherDmuCampaignsByProfile[String(profileNumericId)] || [])
      : [];
    const hasOtherDmuCampaigns = otherDmuCampaigns.length > 0;

    const name = [task.first_name, task.last_name].filter(Boolean).join(' ');
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
    const campaignName = task.campaign_prospect?.campaign?.campaign_name || '';
    const currentTags = state.chatterTaskTags[tid] || [];
    const allForProfile = profileNumericId
      ? (state.availableTagsByProfile[String(profileNumericId)] || [])
      : [];
    const selectableTags = allForProfile
      .filter(t => !currentTags.some(c => String(c.id) === String(t.id)))
      .sort((a, b) => {
        const order = ['#018531', '#b8860b', '#960303'];
        const ia = order.indexOf((a.colour || '').toLowerCase());
        const ib = order.indexOf((b.colour || '').toLowerCase());
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return (a.tag_name || '').localeCompare(b.tag_name || '');
      });
    const tagsExpanded = !!state.chatterTagSelectorOpen[tid];
    const tagsHtml = (currentTags.length || selectableTags.length) ? `
      <div class="ct-tags-row ${tagsExpanded ? 'expanded' : 'collapsed'}">
        <span class="ct-tags-label">Tags</span>
        <div class="ct-tags-scroll">
          ${currentTags.map(t => `
            <span class="ct-tag-chip selected" style="background:${esc(t.colour || '#64748b')}" title="Click × to remove">
              ${esc(t.tag_name)}
              <button class="ct-tag-remove" data-ct-remove-tag="${esc(tid)}" data-tag-id="${esc(t.id)}" title="Remove tag">&times;</button>
            </span>`).join('')}
          ${selectableTags.map(t => `
            <button class="ct-tag-chip ct-tag-add" data-ct-add-tag="${esc(tid)}" data-tag-id="${esc(t.id)}" style="background:${esc(t.colour || '#64748b')}" title="Click to add">
              + ${esc(t.tag_name)}
            </button>`).join('')}
        </div>
        ${selectableTags.length > 0 ? `
          <button class="ct-tags-expand" data-ct-tag-toggle="${esc(tid)}" title="${tagsExpanded ? 'Collapse' : 'Show all tags'}">
            ${tagsExpanded ? '▴ Less' : `▾ +${selectableTags.length}`}
          </button>` : ''}
      </div>` : '';
    const isAiCampaign = task.campaign_prospect?.campaign?.campaign_type === 'AI Campaign';
    const campaignHtml = campaignName
      ? `<span class="campaign-pill"><span class="campaign-dot${task.campaign_prospect?.campaign?.live ? ' live' : ''}"></span>${esc(campaignName)}</span>
         ${isAiCampaign ? '<span class="badge badge-ai" title="AI Campaign — reply using the AI suggestion">🤖 AI</span>' : ''}
         <button class="ct-view-campaign-btn" data-ct-view-campaign="${esc(campaignName)}" title="View campaign content">
           <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
         </button>`
      : '';
    const hasNotes = Array.isArray(task.chatter_notes) && task.chatter_notes.length > 0;
    const notesBtn = hasNotes
      ? `<button class="ct-icon-btn ct-notes-btn" data-ct-view-notes="${esc(tid)}" title="View chatter notes (${task.chatter_notes.length})">
           <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
         </button>`
      : '';
    const chatBtn = (task.profile_id && task.prospect_id)
      ? `<button class="ct-icon-btn ct-chat-btn" data-ct-view-chat="${esc(tid)}" title="View LinkedIn chat">
           <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
         </button>`
      : '';

    const replyTemplatesBtn = (task.campaign_prospect?.campaign?.profile?.id && task.profile_id && task.prospect_id)
      ? `<button class="ct-icon-btn ct-reply-btn" data-ct-view-reply-templates="${esc(tid)}" title="View reply templates">
           <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12v16H4z"></path><path d="M8 8h6M8 12h6M8 16h4"></path></svg>
         </button>`
      : '';

    return `
      <div class="ct-card" data-tid="${esc(tid)}">
        <div class="ct-line1">
          ${task.profile_url
            ? `<a href="${esc(task.profile_url)}" class="revoke-url" data-cr-nav="${esc(task.profile_url)}">${esc(task.profile_url)}</a>`
            : `<span class="revoke-url muted">${esc(name) || 'Unknown prospect'}</span>`}
          ${task.data_type ? `<span class="badge badge-fu">${esc(task.data_type)}</span>` : ''}
          ${dueHtml}
        </div>
        ${task.campaign_prospect?.id ? `
        <div class="ct-name-row">
          ${name ? `<button class="fu-name-chip" data-copy="${esc(name)}" title="Click to copy name">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            ${esc(name)}
          </button>` : '<span class="revoke-url muted">No name</span>'}
          <button class="ct-icon-btn ct-name-edit-btn" data-ct-name-edit="${esc(tid)}" title="Edit prospect name">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </div>
        ${state.chatterNameEditOpen[tid] ? `
        <div class="ct-form ct-name-edit-form">
          <div class="ct-form-row">
            <div class="ct-form-col">
              <label class="ct-label">First name</label>
              <input type="text" class="ct-inpNaut" id="ct-name-fname-${esc(tid)}" value="${esc(task.first_name || '')}" placeholder="First name" />
            </div>
            <div class="ct-form-col">
              <label class="ct-label">Last name</label>
              <input type="text" class="ct-input" id="ct-name-lname-${esc(tid)}" value="${esc(task.last_name || '')}" placeholder="Last name" />
            </div>
          </div>
          <div class="ct-name-edit-actions">
            <button class="btn btn-ghost btn-xs" data-ct-name-edit-cancel="${esc(tid)}">Cancel</button>
            <button class="btn btn-primary btn-xs" data-ct-action="edit_prospect_name" data-ct-tid="${esc(tid)}">Save name</button>
          </div>
        </div>` : ''}` : ''}
        ${campaignHtml || hasNotes || chatBtn || replyTemplatesBtn ? `<div class="ct-line2">${campaignHtml}${notesBtn}${chatBtn}${replyTemplatesBtn}</div>` : ''}
        ${task.content ? `
        <div class="cr-content-wrap">
          <button class="cr-copy-btn" data-copy="${esc(task.content)}" title="Copy message">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Copy
          </button>
          <div class="cr-content">${esc(task.content)}</div>
        </div>` : ''}

        ${tagsHtml}

        <div class="ct-actions">
          <div class="ct-action-tabs" role="tablist">
            <button class="ct-action-tab ${action === 'send_message' ? 'active' : ''}" data-ct-set-action="send_message" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
              Send
            </button>
            <button class="ct-action-tab ${action === 'forward_client' ? 'active' : ''}" data-ct-set-action="forward_client" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"></polyline><path d="M4 18v-2a4 4 0 0 1 4-4h12"></path></svg>
              Forward
            </button>
            <button class="ct-action-tab ${action === 'back_campaign' ? 'active' : ''}" data-ct-set-action="back_campaign" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
              Back to campaign
            </button>
            ${aiSuggestionEnabled ? `
            <button class="ct-action-tab ${action === 'ai_suggestion' ? 'active' : ''}" data-ct-set-action="ai_suggestion" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-7.07 17.07L12 22l7.07-2.93A10 10 0 0 0 12 2zm0 3a4 4 0 1 1-4 4 4 4 0 0 1 4-4zm0 14.5c-2.33 0-4.4-1.17-5.7-2.95.35-1.89 3.8-2.95 5.7-2.95s5.35 1.06 5.7 2.95C16.4 18.33 14.33 19.5 12 19.5z"></path></svg>
              AI Suggestion
            </button>` : `
            <button class="ct-action-tab" disabled title="Coming soon" style="opacity:0.45;cursor:not-allowed;">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-7.07 17.07L12 22l7.07-2.93A10 10 0 0 0 12 2zm0 3a4 4 0 1 1-4 4 4 4 0 0 1 4-4zm0 14.5c-2.33 0-4.4-1.17-5.7-2.95.35-1.89 3.8-2.95 5.7-2.95s5.35 1.06 5.7 2.95C16.4 18.33 14.33 19.5 12 19.5z"></path></svg>
              AI Suggestion
            </button>`}
            ${hasOtherDmuCampaigns ? `
            <button class="ct-action-tab ${action === 'other_dmu' ? 'active' : ''}" data-ct-set-action="other_dmu" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
              Other DMU
            </button>` : `
            <button class="ct-action-tab" disabled title="No Other DMU campaign available for this profile." style="opacity:0.45;cursor:not-allowed;">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
              Other DMU
            </button>`}
            <button class="ct-action-tab danger ${action === 'disconnect' ? 'active' : ''}" data-ct-set-action="disconnect" data-ct-tid="${esc(tid)}">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
              Disconnect
            </button>
          </div>

          ${action === 'send_message' ? `
          <div class="ct-form">
            <label class="ct-label">Message <span class="ct-label-hint">— what you sent to the prospect</span></label>
            <textarea class="ct-input" id="ct-msg-${esc(tid)}" placeholder="Type the message you sent…" rows="3"></textarea>
            <label class="ct-label">Date sent</label>
            <input type="date" class="ct-input" id="ct-date-${esc(tid)}" />
            <label class="ct-checkbox-row">
              <input type="checkbox" class="ct-followup-toggle" data-ct-tid="${esc(tid)}" ${followUpChecked ? 'checked' : ''} />
              Schedule a follow-up
            </label>
            ${followUpChecked ? `
              <label class="ct-label">Follow-up date</label>
              <input type="date" class="ct-input" id="ct-fudate-${esc(tid)}" />` : ''}
            <button class="btn btn-primary btn-xs" data-ct-action="send_message" data-ct-tid="${esc(tid)}" ${sentKind === 'message' ? 'disabled' : ''}>
              ${sentKind === 'message' ? '✓ Message recorded' : 'Confirm message sent'}
            </button>
          </div>` : ''}

          ${action === 'forward_client' ? `
          <div class="ct-form">
            <p class="ct-hint">Pass this prospect's contact details to the client.</p>
            <label class="ct-label">Prospect email</label>
            <input type="email" class="ct-input" id="ct-email-${esc(tid)}" placeholder="name@example.com" />
            <label class="ct-label">Prospect phone</label>
            <input type="tel" class="ct-input" id="ct-phone-${esc(tid)}" placeholder="+31 6 …" />
            <button class="btn btn-primary btn-xs" data-ct-action="forward_client" data-ct-tid="${esc(tid)}" ${sentKind === 'forwarded' ? 'disabled' : ''}>
              ${sentKind === 'forwarded' ? '✓ Forwarded to client' : 'Forward to client'}
            </button>
          </div>` : ''}

          ${action === 'back_campaign' ? `
          <div class="ct-form">
            <p class="ct-hint">Send this prospect back into the campaign flow (a new follow-up will be scheduled).</p>
            <button class="btn btn-primary btn-xs" data-ct-action="back_campaign" data-ct-tid="${esc(tid)}" ${sentKind === 'back_campaign' ? 'disabled' : ''}>
              ${sentKind === 'back_campaign' ? '✓ Sent back to campaign' : 'Send back to campaign'}
            </button>
          </div>` : ''}

          ${action === 'ai_suggestion' ? (aiSuggestionEnabled ? `
          <div class="ct-form">
            <p class="ct-hint">Generates up to 3 message suggestions with different angles, based on the chat history, campaign context, the prospect's company and recent news (when found).</p>
            <label class="ct-label">Prompt note (optional)</label>
            <textarea class="ct-input ct-ai-note" data-tid="${esc(tid)}" rows="3" maxlength="${AI_PROMPT_NOTE_MAX_LENGTH}" placeholder="Extra instructions for the AI — or paste a recent LinkedIn post of the prospect to reference.">${esc(aiNote)}</textarea>
            ${aiError ? `<div class="error-msg">${esc(aiError)}</div>` : ''}
            ${aiVariants.map(v => `
            <div class="ct-reply-textarea-wrap">
              ${v.angle ? `<div class="ct-ai-angle">${esc(v.angle)}</div>` : ''}
              <textarea class="ct-input ct-reply-textarea" readonly rows="5">${esc(v.message)}</textarea>
              <button class="cr-copy-btn" data-copy="${esc(v.message)}" title="Copy suggestion">Copy</button>
            </div>`).join('')}
            <button class="btn btn-primary btn-xs" data-ct-action="generate_ai_suggestion" data-ct-tid="${esc(tid)}" ${aiLoading ? 'disabled' : ''}>
              ${aiLoading ? 'Generating…' : (aiVariants.length ? 'Regenerate suggestions' : 'Generate suggestions')}
            </button>
          </div>` : `
          <div class="ct-form">
            <p class="ct-hint">AI Suggestion is coming soon.</p>
          </div>`) : ''}

          ${action === 'disconnect' ? `
          <div class="ct-form">
            <p class="ct-hint">⚠ Use when the LinkedIn URL is no longer valid or the prospect has disconnected. This removes them from the campaign.</p>
            <button class="btn btn-danger btn-xs" data-ct-action="disconnect" data-ct-tid="${esc(tid)}" ${isDisconnected ? 'disabled' : ''}>
              ${isDisconnected ? '✓ Disconnected' : 'Confirm disconnect'}
            </button>
          </div>` : ''}

          ${action === 'other_dmu' ? `
          <div class="ct-form">
            <p class="ct-hint">Referred by: <strong>${esc([task.first_name, task.last_name].filter(Boolean).join(' '))}</strong></p>
            <label class="ct-label">Campaign</label>
            <select class="ct-input" id="ct-dmu-campaign-${esc(tid)}">
              ${otherDmuCampaigns.map(c => `<option value="${esc(String(c.id))}">${esc(c.campaign_name)}</option>`).join('')}
            </select>
            <label class="ct-label">LinkedIn URL</label>
            <input type="url" class="ct-input" id="ct-dmu-url-${esc(tid)}" placeholder="https://www.linkedin.com/in/slug/" />
            <div class="ct-form-row">
              <div class="ct-form-col">
                <label class="ct-label">First name</label>
                <input type="text" class="ct-input" id="ct-dmu-fname-${esc(tid)}" placeholder="First name" />
              </div>
              <div class="ct-form-col">
                <label class="ct-label">Last name</label>
                <input type="text" class="ct-input" id="ct-dmu-lname-${esc(tid)}" placeholder="Last name" />
              </div>
            </div>
            <label class="ct-label">Status</label>
            <div class="ct-seg-toggle" id="ct-dmu-toggle-${esc(tid)}">
              <button type="button" class="ct-seg-btn ct-seg-red ct-seg-active" data-ct-action="dmu_toggle" data-ct-tid="${esc(tid)}" data-ct-val="not_connected">
                Not Connected
              </button>
              <button type="button" class="ct-seg-btn ct-seg-green" data-ct-action="dmu_toggle" data-ct-tid="${esc(tid)}" data-ct-val="connected">
                Connected
              </button>
            </div>
            <input type="hidden" id="ct-dmu-conn-${esc(tid)}" value="not_connected" />
            <div id="ct-dmu-date-row-${esc(tid)}" style="display:none;margin-bottom:4px">
              <label class="ct-label">Date connected</label>
              <input type="date" class="ct-input" id="ct-dmu-date-${esc(tid)}" />
            </div>
            <button class="btn btn-primary btn-xs" data-ct-action="other_dmu" data-ct-tid="${esc(tid)}" ${sentKind === 'other_dmu' ? 'disabled' : ''}>
              ${sentKind === 'other_dmu' ? '✓ Other DMU created' : 'Create Other DMU'}
            </button>
          </div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="revoke-summary">${state.tasks.length} Chatter task${state.tasks.length !== 1 ? 's' : ''}</div>
    <div class="revoke-list">${rows}</div>
  `;
}

// --- Chatter Tasks action handlers ---

function getChatterTask(tid) {
  return state.tasks.find(t => String(t.documentId) === String(tid));
}

// Fetch all tags once and group by profile id (numeric)
async function loadAvailableTags() {
  // Skip if already loaded
  if (Object.keys(state.availableTagsByProfile).length > 0) return;
  try {
    const pageSize = 100;
    const buildUrl = (page) =>
      `/api/tags?fields[0]=id&fields[1]=tag_name&fields[2]=colour&fields[3]=is_standard` +
      `&populate[profiles][fields][0]=id` +
      `&pagination[page]=${page}&pagination[pageSize]=${pageSize}`;

    const first = await apiGet(buildUrl(1));
    let all = Array.isArray(first?.data) ? first.data.slice() : [];
    const pageCount = first?.meta?.pagination?.pageCount || 1;
    if (pageCount > 1) {
      const rest = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => apiGet(buildUrl(i + 2)))
      );
      for (const page of rest) {
        if (Array.isArray(page?.data)) all = all.concat(page.data);
      }
    }
    // Group by profile numeric id
    const byProfile = {};
    for (const tag of all) {
      const profiles = Array.isArray(tag.profiles?.data)
        ? tag.profiles.data.map(p => p.id)
        : Array.isArray(tag.profiles)
          ? tag.profiles.map(p => p.id)
          : [];
      const flat = {
        id: tag.id ?? tag.attributes?.id,
        tag_name: tag.tag_name ?? tag.attributes?.tag_name,
        colour: tag.colour ?? tag.attributes?.colour,
        is_standard: tag.is_standard ?? tag.attributes?.is_standard,
      };
      for (const pid of profiles) {
        const key = String(pid);
        if (!byProfile[key]) byProfile[key] = [];
        byProfile[key].push(flat);
      }
    }
    state.availableTagsByProfile = byProfile;
    if (STEPS[state.currentStep]?.key === 'chatter_tasks') render();
  } catch (err) {
    console.warn('[Tags] Failed to load available tags:', err?.message);
  }
}

async function loadOtherDmuCampaigns(tasks) {
  // Collect unique numeric profile IDs from the task list
  const profileIds = [...new Set(
    tasks
      .map(t => t.campaign_prospect?.campaign?.profile?.id)
      .filter(Boolean)
  )];
  if (profileIds.length === 0) return;

  try {
    const byProfile = { ...state.otherDmuCampaignsByProfile };
    await Promise.all(profileIds.map(async (profileId) => {
      const url =
        `/api/campaigns?filters[profile][id][$eq]=${profileId}` +
        `&filters[campaign_type][$eq]=Other DMU` +
        `&fields[0]=id&fields[1]=campaign_name` +
        `&pagination[pageSize]=50`;
      const result = await apiGet(url);
      byProfile[String(profileId)] = (result?.data || []).map(c => ({
        id: c.id,
        campaign_name: c.campaign_name ?? c.attributes?.campaign_name,
      }));
    }));
    state.otherDmuCampaignsByProfile = byProfile;
    if (STEPS[state.currentStep]?.key === 'chatter_tasks') render();
  } catch (err) {
    console.warn('[OtherDMU] Failed to load Other DMU campaigns:', err?.message);
  }
}

async function handleChatterSendMessage(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const message = el(`ct-msg-${tid}`)?.value || '';
  const dateSent = el(`ct-date-${tid}`)?.value || '';
  const followUp = !!state.chatterFollowUp[tid];
  const followUpDate = el(`ct-fudate-${tid}`)?.value || '';

  if (message && !dateSent) {
    showToast('Please fill in the date sent when you provide a message.', 'error');
    return;
  }
  if (followUp && !followUpDate) {
    showToast('Please fill in the follow-up date.', 'error');
    return;
  }

  try {
    const selectedTagIds = (state.chatterTaskTags[tid] || []).map(t => t.id);
    await apiPost('/api/data-senders/message_sent', {
      ...task,
      documentId: tid,
      prospect_id: task.prospect_id,
      campaign_id: task.campaign_id,
      message,
      date_sent: dateSent,
      selected_tag_ids: selectedTagIds,
      follow_up: followUp,
      follow_up_date: followUp ? followUpDate : null,
    });
    state.chatterSent[tid] = 'message';
    saveActionedState();
    showToast('Message sent successfully!');
    render();
  } catch (err) {
    showToast(`Failed to send message: ${err.message}`, 'error');
  }
}

async function handleChatterForwardClient(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const email = el(`ct-email-${tid}`)?.value || '';
  const phone = el(`ct-phone-${tid}`)?.value || '';
  if (!email || !phone) {
    showToast('Please fill in both email and phone number.', 'error');
    return;
  }
  try {
    const selectedTagIds = (state.chatterTaskTags[tid] || []).map(t => t.id);
    await apiPost('/api/data-senders/forward_to_client', {
      ...task,
      documentId: tid,
      prospect_id: task.prospect_id,
      campaign_id: task.campaign_id,
      email,
      phone,
      selected_tag_ids: selectedTagIds,
    });
    state.chatterSent[tid] = 'forwarded';
    saveActionedState();
    showToast('Forwarded to client successfully!');
    render();
  } catch (err) {
    showToast(`Failed to forward: ${err.message}`, 'error');
  }
}

async function handleChatterBackCampaign(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  try {
    const selectedTagIds = (state.chatterTaskTags[tid] || []).map(t => t.id);
    await apiPost('/api/data-senders/back_campaign', {
      ...task,
      documentId: tid,
      prospect_id: task.prospect_id,
      campaign_id: task.campaign_id,
      email: '',
      phone: '',
      selected_tag_ids: selectedTagIds,
    });
    state.chatterSent[tid] = 'back_campaign';
    saveActionedState();
    showToast('Sent back to campaign successfully!');
    render();
  } catch (err) {
    showToast(`Failed to send back to campaign: ${err.message}`, 'error');
  }
}

async function handleChatterDisconnect(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  try {
    await apiPost('/api/data-senders/disconnect', {
      ...task,
      documentId: tid,
    });
    state.chatterDisconnected[tid] = true;
    saveActionedState();
    showToast('Prospect disconnected successfully!');
    render();
  } catch (err) {
    showToast(`Failed to disconnect: ${err.message}`, 'error');
  }
}

async function handleChatterAiSuggestion(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  state.chatterAiLoading[tid] = true;
  state.chatterAiError[tid] = null;
  render();

  try {
    const promptNote = (state.chatterAiNote[tid] || '').slice(0, AI_PROMPT_NOTE_MAX_LENGTH).trim();
    const result = await apiPost('/api/extension/chatter-ai-suggestion', {
      documentId: task.documentId || tid,
      ...(promptNote ? { promptNote } : {}),
    });
    const variants = Array.isArray(result?.suggestions)
      ? result.suggestions.filter(v => v && typeof v.message === 'string' && v.message.trim())
      : (result?.suggestion ? [{ angle: '', message: result.suggestion }] : []);
    if (!variants.length) {
      throw new Error(result?.message || 'No suggestion returned');
    }
    state.chatterAiSuggestion[tid] = variants;
  } catch (err) {
    state.chatterAiError[tid] = err?.message || String(err);
  } finally {
    state.chatterAiLoading[tid] = false;
    render();
  }
}

function ctDmuToggle(tid, val) {
  const hidden = document.getElementById(`ct-dmu-conn-${tid}`);
  if (hidden) hidden.value = val;
  const toggle = document.getElementById(`ct-dmu-toggle-${tid}`);
  if (!toggle) return;
  toggle.querySelectorAll('.ct-seg-btn').forEach(btn => {
    const isActive = btn.dataset.ctVal === val;
    btn.classList.toggle('ct-seg-active', isActive);
  });
  const dateRow = document.getElementById(`ct-dmu-date-row-${tid}`);
  if (dateRow) dateRow.style.display = val === 'connected' ? '' : 'none';
}

async function handleChatterOtherDmu(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const otherDmuCampaignId = parseInt(el(`ct-dmu-campaign-${tid}`)?.value || '0', 10);
  const dmuLinkedInUrl = el(`ct-dmu-url-${tid}`)?.value?.trim() || '';
  const dmuFirstName   = el(`ct-dmu-fname-${tid}`)?.value?.trim() || '';
  const dmuLastName    = el(`ct-dmu-lname-${tid}`)?.value?.trim() || '';
  const isConnected    = document.getElementById(`ct-dmu-conn-${tid}`)?.value === 'connected';
  const dateConnected  = isConnected ? (el(`ct-dmu-date-${tid}`)?.value?.trim() || '') : '';

  if (!otherDmuCampaignId) {
    showToast('Please select an Other DMU campaign.', 'error');
    return;
  }
  if (!dmuLinkedInUrl) {
    showToast('Please enter a LinkedIn URL.', 'error');
    return;
  }
  const linkedInUrlPattern = /^https:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9\-_%]+\/?$/;
  if (!linkedInUrlPattern.test(dmuLinkedInUrl)) {
    showToast('LinkedIn URL must be in the format: https://www.linkedin.com/in/slug/', 'error');
    return;
  }
  if (!dmuFirstName || !dmuLastName) {
    showToast('Please fill in first name and last name.', 'error');
    return;
  }
  if (isConnected && !dateConnected) {
    showToast('Please fill in the date connected.', 'error');
    return;
  }

  try {
    await apiPost('/api/data-senders/other_dmu_referral', {
      source_campaign_prospect_id: task.campaign_prospect?.id,
      source_task_document_id: tid,
      other_dmu_campaign_id: otherDmuCampaignId,
      dmu_linkedin_url: dmuLinkedInUrl,
      dmu_first_name: dmuFirstName,
      dmu_last_name: dmuLastName,
      is_connected: isConnected,
      date_connected: dateConnected || null,
      profile_id: task.profile_id,
      prospect_id: task.prospect_id,
    });
    state.chatterSent[tid] = 'other_dmu';
    saveActionedState();
    showToast('Other DMU toegevoegd!');
    render();
  } catch (err) {
    showToast(`Mislukt: ${err.message}`, 'error');
  }
}

async function handleChatterEditProspectName(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const campaignProspectId = task.campaign_prospect?.id;
  if (!campaignProspectId) {
    showToast('Cannot edit: no campaign prospect linked.', 'error');
    return;
  }
  const firstName = el(`ct-name-fname-${tid}`)?.value?.trim() || '';
  const lastName  = el(`ct-name-lname-${tid}`)?.value?.trim() || '';
  if (!firstName || !lastName) {
    showToast('Please fill in both first and last name.', 'error');
    return;
  }
  // No-op if nothing changed
  if (firstName === (task.first_name || '') && lastName === (task.last_name || '')) {
    state.chatterNameEditOpen[tid] = false;
    render();
    return;
  }

  try {
    await apiPost('/api/data-senders/edit_prospect_name', {
      campaign_prospect_id: campaignProspectId,
      source_task_document_id: tid,
      first_name: firstName,
      last_name: lastName,
    });
    // Optimistically reflect the cleaned name in the UI.
    task.first_name = firstName;
    task.last_name = lastName;
    state.chatterNameEditOpen[tid] = false;
    showToast('Name edited');
    render();
  } catch (err) {
    showToast(`Mislukt: ${err.message}`, 'error');
  }
}

// Builds the placeholder lookup map from a chatter task, matching the keys
// Strapi uses when personalising campaign content (see connect.ts): standard
// fields plus any per-prospect custom placeholders (name → value, spaces
// normalised to underscores).
function buildPlaceholderMap(task) {
  const map = {
    first_name: task.first_name || '',
    last_name: task.last_name || '',
    full_name: [task.first_name, task.last_name].filter(Boolean).join(' '),
    job_title: task.job_title || '',
    company_name: task.company_name || '',
    linkedin_group: task.linkedin_group || '',
  };
  for (const p of task.placeholders || []) {
    if (!p?.name) continue;
    const key = p.name.trim().replace(/\s+/g, '_').toLowerCase();
    map[key] = p.value || '';
  }
  const ref = task.referral;
  if (ref) {
    for (const [field, val] of Object.entries(ref)) {
      map[`${field}_referral`] = val || '';
    }
  }
  return map;
}

// Mirrors the campaign-content convention in Strapi (replacePlaceholders in
// queues/handlers/utils.ts): any *key* or {key} token is looked up in the
// placeholder map. Unknown tokens are left in place so they stay visible
// instead of being silently dropped.
function replaceTemplatePlaceholders(template, placeholders) {
  if (!template) return '';
  const lookup = (key) => {
    const k = key.toLowerCase();
    // Accept *firstname* / *first_name* and the full-name aliases.
    const aliases = {
      firstname: 'first_name',
      lastname: 'last_name',
      name: 'full_name',
      fullname: 'full_name',
    };
    const resolved = aliases[k] || k;
    const value = placeholders[resolved];
    return value != null && value !== '' ? value : null;
  };
  return template
    .replace(/\*(\w+)\*/g, (match, key) => lookup(key) ?? match)
    .replace(/\{(\w+)\}/g, (match, key) => lookup(key) ?? match);
}

async function showReplyTemplatesPopup(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const profileId = task.campaign_prospect?.campaign?.profile?.id || task.profile_id;
  state.replyTemplatesPopup = {
    title: `Reply templates for ${[task.first_name, task.last_name].filter(Boolean).join(' ')}`.trim() || 'Reply templates',
    options: [],
    selectedIndex: -1,
    message: '',
    loading: true,
    error: null,
    placeholders: buildPlaceholderMap(task),
  };
  render();

  if (!profileId) {
    state.replyTemplatesPopup = {
      ...state.replyTemplatesPopup,
      loading: false,
      error: 'No profile available to load reply templates.',
    };
    render();
    return;
  }

  try {
    const data = await apiGet(`/api/extension/reply-templates?profileId=${encodeURIComponent(profileId)}`);
    const replyTemplates = data?.data || null;
    const options = Array.isArray(replyTemplates?.rows) ? replyTemplates.rows : [];
    const selectedIndex = options.length > 0 ? 0 : -1;
    const message = selectedIndex >= 0
      ? replaceTemplatePlaceholders(options[selectedIndex][1] || '', state.replyTemplatesPopup.placeholders)
      : '';
    state.replyTemplatesPopup = {
      ...state.replyTemplatesPopup,
      options,
      selectedIndex,
      message,
      loading: false,
      error: options.length === 0 ? 'No reply templates found for this customer.' : null,
    };
  } catch (err) {
    state.replyTemplatesPopup = {
      ...state.replyTemplatesPopup,
      loading: false,
      error: err.message || 'Failed to load reply templates.',
    };
  }
  render();
}

function buildReplyTemplatesPopup() {
  const p = state.replyTemplatesPopup;
  if (!p) return '';
  const body = p.loading
    ? `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`
    : p.error
      ? `<div class="error-msg">${esc(p.error)}</div>`
      : p.options.length === 0
        ? `<p class="muted" style="text-align:center">No reply templates available for this customer.</p>`
        : `
          <label for="ct-reply-template-select" class="ct-label">Select a template</label>
          <select id="ct-reply-template-select" class="ct-input">
            ${p.options.map((row, index) => `<option value="${index}" ${p.selectedIndex === index ? 'selected' : ''}>${esc(row[0] || `Option ${index + 1}`)}</option>`).join('')}
          </select>
          <label for="ct-reply-textarea" class="ct-label">Reply text</label>
          <div class="ct-reply-textarea-wrap">
            <textarea id="ct-reply-textarea" class="ct-input ct-reply-textarea" readonly rows="5">${esc(p.message)}</textarea>
            <button class="cr-copy-btn" data-copy="${esc(p.message)}" title="Copy reply">Copy reply</button>
          </div>
        `;

  return `
    <div class="ct-cc-overlay" id="ct-reply-overlay">
      <div class="ct-cc-modal">
        <div class="ct-cc-header">
          <h3>${esc(p.title)}</h3>
          <button class="ct-cc-close" id="ct-reply-close" title="Close">×</button>
        </div>
        <div class="ct-cc-body">${body}</div>
      </div>
    </div>
  `;
}

async function showCampaignContentPopup(campaignName) {
  state.campaignContentPopup = { title: campaignName, content: [], loading: true, error: null };
  render();
  try {
    const data = await apiGet(`/api/campaigns?filters[campaign_name][$eq]=${encodeURIComponent(campaignName)}&populate=Content`);
    const contentArr = data?.data?.[0]?.Content || [];
    state.campaignContentPopup = { title: campaignName, content: contentArr, loading: false, error: null };
  } catch (err) {
    state.campaignContentPopup = { title: campaignName, content: [], loading: false, error: err.message };
  }
  render();
}

function buildCampaignContentPopup() {
  const p = state.campaignContentPopup;
  if (!p) return '';
  const body = p.loading
    ? `<div class="loading"><div class="spinner"></div><span>Loading…</span></div>`
    : p.error
      ? `<div class="error-msg">${esc(p.error)}</div>`
      : p.content.length === 0
        ? `<p class="muted" style="text-align:center">No content found for this campaign.</p>`
        : p.content.map(msg => `
            <div class="ct-cc-bubble">
              <div class="ct-cc-text">${esc(msg.message_content || '')}</div>
              ${msg.message_delay !== undefined ? `<div class="ct-cc-delay">Delay: ${esc(String(msg.message_delay))} days</div>` : ''}
            </div>
          `).join('');

  return `
    <div class="ct-cc-overlay" id="ct-cc-overlay">
      <div class="ct-cc-modal">
        <div class="ct-cc-header">
          <h3>Content for ${esc(p.title)}</h3>
          <button class="ct-cc-close" id="ct-cc-close" title="Close">×</button>
        </div>
        <div class="ct-cc-body">${body}</div>
      </div>
    </div>
  `;
}

function showNotesPopup(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const name = [task.first_name, task.last_name].filter(Boolean).join(' ');
  state.notesPopup = {
    title: `Chatter Note History - ${name}`,
    notes: task.chatter_notes || [],
  };
  render();
}

function buildNotesPopup() {
  const p = state.notesPopup;
  if (!p) return '';
  const body = p.notes.length === 0
    ? `<p class="muted" style="text-align:center">No notes found.</p>`
    : p.notes.map(n => `
        <div class="ct-note">
          <div class="ct-note-meta">
            <span class="ct-note-creator">${esc(n.creator || 'Unknown')}</span>
            <span class="ct-note-date">${n.date ? esc(new Date(n.date).toLocaleString()) : ''}</span>
          </div>
          <div class="ct-note-content">${esc(n.content || '')}</div>
        </div>
      `).join('');
  return `
    <div class="ct-cc-overlay" id="ct-notes-overlay">
      <div class="ct-cc-modal">
        <div class="ct-cc-header">
          <h3>${esc(p.title)}</h3>
          <button class="ct-cc-close" id="ct-notes-close" title="Close">×</button>
        </div>
        <div class="ct-cc-body">${body}</div>
      </div>
    </div>
  `;
}

async function showChatPopup(tid) {
  const task = getChatterTask(tid);
  if (!task) return;
  const name = [task.first_name, task.last_name].filter(Boolean).join(' ');
  state.chatPopup = {
    title: `Chat with ${name}`,
    messages: [],
    prospectId: task.prospect_id,
    loading: true,
    error: null,
  };
  render();

  try {
    const data = await apiGet(
      `/api/linked-in-chats?filters[customer_id][$eq]=${encodeURIComponent(task.profile_id)}&filters[profile_id][$eq]=${encodeURIComponent(task.prospect_id)}&populate=messages`
    );
    const raw = data?.data?.[0]?.messages || [];
    const messages = raw
      .map(m => ({ content: m.content, messageDate: m.message_date, senderId: m.sender_id }))
      .sort((a, b) => new Date(a.messageDate).getTime() - new Date(b.messageDate).getTime());
    state.chatPopup = { ...state.chatPopup, messages, loading: false };
  } catch (err) {
    state.chatPopup = { ...state.chatPopup, loading: false, error: err.message };
  }
  render();
}

function buildChatPopup() {
  const p = state.chatPopup;
  if (!p) return '';
  const body = p.loading
    ? `<div class="loading"><div class="spinner"></div><span>Loading chat…</span></div>`
    : p.error
      ? `<div class="error-msg">${esc(p.error)}</div>`
      : p.messages.length === 0
        ? `<p class="muted" style="text-align:center">No chat messages found.</p>`
        : p.messages.map(m => {
            const isProspect = String(m.senderId) === String(p.prospectId);
            const dateStr = m.messageDate ? new Date(m.messageDate).toLocaleString() : '';
            return `
              <div class="ct-chat-row ${isProspect ? 'left' : 'right'}">
                <div class="ct-chat-bubble ${isProspect ? 'prospect' : 'me'}">
                  <div class="ct-cc-text">${esc(m.content || '')}</div>
                  ${dateStr ? `<div class="ct-chat-date">${esc(dateStr)}</div>` : ''}
                </div>
              </div>
            `;
          }).join('');
  return `
    <div class="ct-cc-overlay" id="ct-chat-overlay">
      <div class="ct-cc-modal">
        <div class="ct-cc-header">
          <h3>${esc(p.title)}</h3>
          <button class="ct-cc-close" id="ct-chat-close" title="Close">×</button>
        </div>
        <div class="ct-cc-body">${body}</div>
      </div>
    </div>
  `;
}

// --- Chat Scraper ---

function buildChatScraperArea() {
  const cs = state.chatScraper;
  const isOnThread = /linkedin\.com\/messaging\/(thread|conversations)\//i.test(state.currentTabUrl);

  const scrapeDisabled = cs.status === 'scraping' || cs.status === 'sending';

  const hasValidIds    = !!(cs.profile_id && cs.customer_id);
  const unknownSenderCount = cs.messages.filter(
    m => m.sender_id === null && !cs.manualSenderOverrides?.[m.message_id]
  ).length;
  const MESSAGE_ID_RE  = /^[A-Za-z0-9+/]+=*$/;
  const hasValidMsgs   = cs.messages.length > 0 &&
                         cs.messages.every(m => m.message_id && MESSAGE_ID_RE.test(m.message_id) && m.message_date) &&
                         unknownSenderCount === 0;
  const sendDisabled   = cs.status !== 'ready' || !hasValidIds || !hasValidMsgs;

  const toolbar = `
    <div class="cs-toolbar">
      <select id="sel-scraper-days" class="cs-days-select" ${scrapeDisabled ? 'disabled' : ''}>
        <option value="7"  ${cs.scraperDays === 7  ? 'selected' : ''}>7 Days</option>
        <option value="31" ${cs.scraperDays === 31 ? 'selected' : ''}>31 Days</option>
        <option value="0"  ${cs.scraperDays === 0  ? 'selected' : ''}>All Time</option>
      </select>
      <button id="btn-scrape-chat" class="btn btn-secondary" ${scrapeDisabled ? 'disabled' : ''}>
        ${cs.status === 'scraping' ? '⟳ Scraping…' : '🔍 Scrape Chat'}
      </button>
      <button id="btn-send-chat" class="btn btn-primary" ${sendDisabled ? 'disabled' : ''}>
        ${cs.status === 'sending' ? '⟳ Sending…' : 'Send to Backend'}
      </button>
    </div>
  `;

  if (!isOnThread && cs.status === 'idle') {
    return `
      <div class="empty-state" style="margin-bottom:12px">
        Navigate to a LinkedIn messaging thread, then click <strong>Scrape Chat</strong>.
      </div>
      ${toolbar}
    `;
  }

  if (cs.error) {
    return toolbar + `<div class="error-msg" style="margin-top:8px">${esc(cs.error)}<br />Please retry the current chat before switching away.</div>`;
  }

  if (cs.status === 'idle') {
    return toolbar;
  }

  if (cs.status === 'scraping') {
    return toolbar + `<div class="loading" style="margin-top:16px"><div class="spinner"></div><span>Scraping messages…</span></div>`;
  }

  // ready or sending — show message list
  const sentBanner = cs.sentCount !== null
    ? `<div class="cs-sent-banner">${cs.sentCount === 0 ? '✓ Already up to date — no new messages.' : `✓ ${cs.sentCount} new message${cs.sentCount !== 1 ? 's' : ''} sent to backend.`}</div>`
    : '';

  const threadLabel = (() => {
    if (!cs.profile_id && !cs.contact_name) return '';
    const name = cs.contact_name || cs.profile_id;
    const url = cs.thread_url || `https://www.linkedin.com/in/${cs.profile_id}/`;
    return `<span class="cs-id" title="LinkedIn: ${esc(url)}">Chat with: <strong>${esc(name)}</strong></span>`;
  })();

  const infoBar = `
    <div class="cs-info-bar">
      <span><strong>${cs.messages.length}</strong> message${cs.messages.length !== 1 ? 's' : ''}</span>
      ${threadLabel}
      <span class="cs-id" title="Your LinkedIn ID: ${esc(cs.customer_id)}">Profile: <code>${esc(cs.customer_id.slice(0, 6))}…</code></span>
      <span class="cs-id" title="Contact LinkedIn ID: ${esc(cs.profile_id)}">Prospect: <code>${esc(cs.profile_id.slice(0, 6))}…</code></span>
    </div>
  `;

  const unknownSenderBanner = unknownSenderCount > 0
    ? `<div class="warn-msg" style="margin-bottom:8px">⚠ ${unknownSenderCount} message${unknownSenderCount !== 1 ? 's' : ''} could not determine sender direction. Choose <strong>Sent by me</strong> or <strong>Received</strong> for each highlighted message below before sending.</div>`
    : '';

  // When the contact's LinkedIn ID could not be scraped, all messages will have
  // unknown sender direction and send is blocked. Show a targeted explanation.
  const missingContactBanner = (cs.status === 'ready' && !cs.profile_id)
    ? `<div class="error-msg" style="margin-bottom:8px">⚠ Could not find the contact’s LinkedIn ID in this thread. Sender direction cannot be determined and sending is blocked.${esc(DEV_MSG)}</div>`
    : '';

  const msgList = cs.messages.map(m => {
    const override = cs.manualSenderOverrides?.[m.message_id];
    const isUnknown = m.sender_id === null && !override;
    const isSent = (m.sender_id !== null && m.sender_id === cs.customer_id) || override === 'sent';
    const rowClass = isUnknown ? 'center' : (isSent ? 'right' : 'left');
    const bubbleClass = isUnknown ? 'unknown' : (isSent ? 'me' : 'prospect');
    const undoBtn = override
      ? `<button class="cs-undo-btn" data-cs-override data-msg-id="${esc(m.message_id)}" data-direction="">↩ Undo</button>`
      : '';
    const unknownControls = isUnknown
      ? `<div class="ct-chat-unknown-label">⚠ Unknown sender — choose:</div>
         <div class="cs-sender-btns">
           <button class="cs-sender-btn" data-cs-override data-msg-id="${esc(m.message_id)}" data-direction="sent">Sent by me</button>
           <button class="cs-sender-btn" data-cs-override data-msg-id="${esc(m.message_id)}" data-direction="received">Received</button>
         </div>`
      : '';
    return `
      <div class="ct-chat-row ${rowClass}">
        <div class="ct-chat-bubble ${bubbleClass}">
          ${unknownControls}
          <div class="ct-cc-text">${esc(m.content || '(no content)')}</div>
          ${m.message_date ? `<div class="ct-chat-date">${esc(m.message_date)}</div>` : ''}
          ${undoBtn}
        </div>
      </div>
    `;
  }).join('');

  return `
    ${toolbar}
    <div class="cs-scroll-note">ℹ Only messages currently loaded in the LinkedIn chat window are scraped. Scroll up in LinkedIn to load older messages before scraping.</div>
    ${sentBanner}
    ${unknownSenderBanner}
    ${missingContactBanner}
    ${infoBar}
    <div class="cs-msg-list">${msgList}</div>
    ${cs.status === 'sending' ? `<div class="loading" style="margin-top:8px"><div class="spinner"></div><span>Deduplicating &amp; sending…</span></div>` : ''}
  `;
}

// --- Revoke list (compact line-by-line) ---

function buildRevokeList() {
  const rows = state.tasks.map(task => {
    const isActioned = !!state.actionedTasks[task.id];
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
    const campaignHtml = buildCampaignPill(task);
    if (isActioned) {
      return `
        <div class="revoke-row revoke-row-actioned">
          <div class="revoke-line1">
            ${task.profile_url ? `<a href="${esc(task.profile_url)}" class="revoke-url" target="_blank">${esc(task.profile_url)}</a>` : ''}
            ${dueHtml}
          </div>
          <div class="revoke-line2">
            ${campaignHtml}
            <span class="actioned-inline">${esc(state.actionedTasks[task.id])}</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="revoke-row">
        <div class="revoke-line1">
          ${task.profile_url ? `<a href="${esc(task.profile_url)}" class="revoke-url" target="_blank">${esc(task.profile_url)}</a>` : ''}
          ${dueHtml}
        </div>
        <div class="revoke-line2">
          ${campaignHtml}
          <span class="revoke-actions">
            <button class="btn btn-revoke btn-xs" data-action="revoke" data-tid="${task.id}">Revoke</button>
            ${buildDisconnectBtn(task.id, 'btn-xs')}
          </span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="revoke-summary">
      ${state.tasks.length} task${state.tasks.length !== 1 ? 's' : ''} due — go to <a href="https://www.linkedin.com/mynetwork/invitation-manager/sent/" target="_blank" class="hint-link">https://www.linkedin.com/mynetwork/invitation-manager/sent/</a>
    </div>
    <div class="revoke-help">
      <details class="revoke-instructions">
        <summary>Is the prospect connected?</summary>
        <ol>
          <li>Open the <a href="https://www.linkedin.com/mynetwork/invite-connect/connections/" target="_blank">LinkedIn Connections page</a>.</li>
          <li>Search the name shown in this revoke task.</li>
          <li>Switch to Step 1 (Connection Acceptance) and connect the person there.</li>
        </ol>
      </details>
    </div>
    <div class="revoke-list">${rows}</div>
  `;
}

// --- Queue mode ---

function buildQueueMode() {
  const task = state.tasks[state.currentIndex];
  if (!task) return `<div class="empty-state">No more tasks.</div>`;

  return `
    ${buildQueueCard(task)}
    <div class="queue-nav">
      <button class="btn-nav" id="btn-prev" ${state.currentIndex <= 0 ? 'disabled' : ''}>← Prev</button>
      <span class="queue-pos">${state.currentIndex + 1} / ${state.tasks.length}</span>
      <button class="btn-nav" id="btn-next" ${state.currentIndex >= state.tasks.length - 1 ? 'disabled' : ''}>Next →</button>
    </div>
  `;
}

function buildQueueCard(task) {
  const isActioned = !!state.actionedTasks[task.id];
  const contact = state.contactDetails[task.id] || { email: '', phone: '', birthday: '', date_connected: '' };
  const isRevoke = task.data_type === 'Revoke connection request';
  const badgeClass = isRevoke ? 'badge-revoke' : 'badge-accept';
  const badgeLabel = isRevoke ? 'Revoke' : 'Accept';
  const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
  const campaignHtml = buildCampaignPill(task);
  const matches = urlMatches(task.profile_url, state.currentTabUrl);

  if (isActioned) {
    const actionLabel = state.actionedTasks[task.id];
    return `
      <div class="task-card task-card-actioned">
        <div class="task-meta">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${campaignHtml}
          ${dueHtml}
        </div>
        ${task.profile_url ? `<div class="task-url"><a href="${esc(task.profile_url)}" class="profile-url" target="_blank">${esc(task.profile_url)}</a></div>` : ''}
        <div class="actioned-label">${esc(actionLabel.charAt(0).toUpperCase() + actionLabel.slice(1))}</div>
      </div>
    `;
  }

  return `
    <div class="task-card">
      ${task.profile_url ? `
        <div class="task-url">
          <a href="${esc(task.profile_url)}" class="profile-url" target="_blank">${esc(task.profile_url)}</a>
          <button class="btn btn-secondary btn-xs" id="btn-open-li" data-url="${esc(task.profile_url)}">Open ↗</button>
        </div>
        <div class="url-status ${matches ? 'url-match' : ''}">
          ${matches ? '✓ Currently on this profile' : 'Not yet on this profile — click Open ↗ above'}
        </div>
      ` : '<div class="no-url">No LinkedIn URL</div>'}

      <div class="task-meta">
        <span class="badge ${badgeClass}">${badgeLabel}</span>
        ${campaignHtml}
        ${dueHtml}
      </div>

      ${!isRevoke ? `
      <div class="task-section">
        <div class="contact-grid">
          <div class="contact-field">
            <label>Email <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
            <input type="email" class="ci" data-tid="${task.id}" data-field="email" value="${esc(contact.email)}" placeholder="email@example.com" />
          </div>
          <div class="contact-field">
            <label>Phone <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
            <input type="tel" class="ci" data-tid="${task.id}" data-field="phone" value="${esc(contact.phone)}" placeholder="+31 6 ..." />
          </div>
          <div class="contact-field">
            <label>Birthday <span class="info-icon" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
            <input type="text" class="ci" data-tid="${task.id}" data-field="birthday" value="${esc(contact.birthday)}" placeholder="DD-MM-YYYY" />
          </div>
          <div class="contact-field">
            <label>Date Connected <span class="info-icon info-icon-left" data-tooltip="Open 'Contact info' on the LinkedIn profile to auto-fill">i</span></label>
            <input type="date" class="ci" data-tid="${task.id}" data-field="date_connected" value="${esc(contact.date_connected)}" />
          </div>
        </div>
      </div>
      ` : ''}

      <div class="task-actions">
        ${isRevoke ? '' : `<button class="btn btn-primary btn-sm" data-action="connect" data-tid="${task.id}">Connect</button>`}
        ${isRevoke ? `<button class="btn btn-revoke btn-sm" data-action="revoke" data-tid="${task.id}">Revoke</button>` : ''}
        ${buildDisconnectBtn(task.id, 'btn-sm')}
        <button class="btn btn-ghost btn-sm" data-action="skip" data-tid="${task.id}">Skip →</button>
      </div>
    </div>
  `;
}

// --- List mode ---

function buildListMode() {
  return `
    <div class="task-list">
      ${state.tasks.map(task => buildListCard(task)).join('')}
    </div>
  `;
}

function buildListCard(task) {
  const isActioned = !!state.actionedTasks[task.id];
  const contact = state.contactDetails[task.id] || { email: '', phone: '', birthday: '', date_connected: '' };
  const isRevoke = task.data_type === 'Revoke connection request';
  const badgeClass = isRevoke ? 'badge-revoke' : 'badge-accept';
  const badgeLabel = isRevoke ? 'Revoke' : 'Accept';
  const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';
  const campaignHtml = buildCampaignPill(task);

  return `
    <div class="list-card ${isActioned ? 'list-card-actioned' : ''}">
      <div class="list-top">
        <div class="list-meta">
          <span class="badge ${badgeClass}">${badgeLabel}</span>
          ${campaignHtml}
          ${dueHtml}
          <span class="flex-1"></span>
          ${isActioned
            ? `<span class="actioned-inline">${esc(state.actionedTasks[task.id])}</span>`
            : buildDisconnectBtn(task.id, 'btn-xs')
          }
        </div>
        ${task.profile_url ? `<a href="${esc(task.profile_url)}" class="list-url" target="_blank">${esc(task.profile_url)}</a>` : ''}
      </div>
      ${!isActioned ? `
        <div class="list-bottom">
          ${!isRevoke ? `
          <div class="list-contact-grid">
            <input type="email" class="ci contact-input-sm" data-tid="${task.id}" data-field="email" value="${esc(contact.email)}" placeholder="Email" />
            <input type="tel" class="ci contact-input-sm" data-tid="${task.id}" data-field="phone" value="${esc(contact.phone)}" placeholder="Phone" />
          </div>
          <div class="list-contact-grid">
            <input type="text" class="ci contact-input-sm" data-tid="${task.id}" data-field="birthday" value="${esc(contact.birthday)}" placeholder="Birthday DD-MM-YYYY" />
            <input type="date" class="ci contact-input-sm" data-tid="${task.id}" data-field="date_connected" value="${esc(contact.date_connected)}" />
          </div>
          ` : ''}
          <div class="list-btn-row">
            ${isRevoke ? '' : `<button class="btn btn-primary btn-xs" data-action="connect" data-tid="${task.id}">Connect</button>`}
            ${isRevoke ? `<button class="btn btn-revoke btn-xs" data-action="revoke" data-tid="${task.id}">Revoke</button>` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// --- Badge helpers ---

function buildDueBadge(dueDateStr) {
  const due = new Date(dueDateStr);
  const now = new Date();
  const diffMs = now.getTime() - due.getTime();
  const cls = diffMs > 24 * 60 * 60 * 1000 ? 'due-overdue' : diffMs >= 0 ? 'due-today' : 'due-future';
  const day = String(due.getDate()).padStart(2, '0');
  const month = String(due.getMonth() + 1).padStart(2, '0');
  const year = due.getFullYear();
  return `<span class="due-badge ${cls}">${day}-${month}-${year}</span>`;
}

function buildCampaignPill(task) {
  const name = task.campaign_prospect?.campaign?.campaign_name;
  if (!name) return '';
  const live = task.campaign_prospect.campaign.live;
  return `<span class="campaign-pill ${live ? 'campaign-live' : ''}" title="${esc(name)}">${esc(name)}</span>`;
}

// =============================================================================
// EVENT LISTENERS
// =============================================================================

// Global delegation — set up once in init(), never removed
function setupGlobalDelegation() {
  // Click delegation
  document.addEventListener('click', e => {
    // Step navigation
    const stepBtn = e.target.closest('.step[data-step]');
    if (stepBtn && !stepBtn.disabled) {
      state.currentStep = parseInt(stepBtn.dataset.step, 10);
      const newStep = STEPS[state.currentStep];
      // Auto-load tasks for the new step using the already-applied filters,
      // so the user doesn't have to press Apply again after switching steps.
      // Entering Follow-Up while already on a messaging thread: re-extract the
      // thread's prospect id in case the earlier extraction ran too early.
      if (newStep.key === 'follow_up') refreshCurrentThreadProspectId().catch(() => {});
      if (newStep.key !== 'connection_acceptance' && newStep.key !== 'chat_scraper' && newStep.enabled && state.appliedProfileId) {
        loadAllTasks().then(() => {
          if (STEPS[state.currentStep]?.key === 'follow_up') autoCheckActiveFollowUpTask().catch(() => {});
        });
      } else {
        render();
        if (newStep.key === 'follow_up') autoCheckActiveFollowUpTask().catch(() => {});
      }
      return;
    }

    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
      const selectedView = viewBtn.dataset.view;
      if (selectedView === 'queue' || selectedView === 'list') {
        state.viewMode = selectedView;
        render();
      }
      return;
    }

    // Navigate active tab to CR profile URL (same tab, no new tab)
    const navLink = e.target.closest('[data-cr-nav]');
    if (navLink) {
      e.preventDefault();
      const url = navLink.dataset.crNav;
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (tabs[0]) chrome.tabs.update(tabs[0].id, { url });
      });
      return;
    }

    // Copy connection request content or name chip
    const copyBtn = e.target.closest('.cr-copy-btn, .fu-name-chip');
    if (copyBtn) {
      const text = copyBtn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.classList.add('copied');
        const original = copyBtn.innerHTML;
        copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Copied!`;
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = original;
        }, 2000);
      });
      return;
    }

    // Task action buttons
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const tid = actionBtn.dataset.tid;
      switch (actionBtn.dataset.action) {
        case 'connect':              handleConnect(tid); break;
        case 'revoke':               handleRevoke(tid); break;
        case 'disconnect':
          if (window.confirm('Are you sure you want to disconnect this prospect?')) {
            handleDisconnect(tid);
          }
          break;
        case 'connection_request':   handleConnectionRequest(tid); break;
        case 'follow_up':             handleFollowUp(tid); break;
        case 'force_cr':              handleConnectionRequest(tid); break;
        case 'force_fu':              handleFollowUp(tid); break;
        case 'skip':
          state.currentIndex = Math.min(state.currentIndex + 1, state.tasks.length - 1);
          render();
          break;
      }
    }

    // Manual sender override (Sent by me / Received / Undo) for unknown-sender chat messages
    const overrideBtn = e.target.closest('[data-cs-override]');
    if (overrideBtn) {
      const msgId = overrideBtn.dataset.msgId;
      const dir   = overrideBtn.dataset.direction;
      if (!state.chatScraper.manualSenderOverrides) state.chatScraper.manualSenderOverrides = {};
      if (dir) {
        state.chatScraper.manualSenderOverrides[msgId] = dir;
      } else {
        delete state.chatScraper.manualSenderOverrides[msgId];
      }
      const _list = document.querySelector('.cs-msg-list');
      const _savedScroll = _list ? _list.scrollTop : 0;
      render();
      requestAnimationFrame(() => {
        const _newList = document.querySelector('.cs-msg-list');
        if (_newList) _newList.scrollTop = _savedScroll;
      });
      return;
    }

    // Chatter task action buttons
    const ctBtn = e.target.closest('[data-ct-action]');
    if (ctBtn) {
      const tid = ctBtn.dataset.ctTid;
      switch (ctBtn.dataset.ctAction) {
        case 'send_message':   handleChatterSendMessage(tid); break;
        case 'forward_client': handleChatterForwardClient(tid); break;
        case 'back_campaign':  handleChatterBackCampaign(tid); break;
        case 'disconnect':     handleChatterDisconnect(tid); break;
        case 'generate_ai_suggestion': handleChatterAiSuggestion(tid); break;
        case 'other_dmu':      handleChatterOtherDmu(tid); break;
        case 'dmu_toggle':     ctDmuToggle(tid, ctBtn.dataset.ctVal); break;
        case 'edit_prospect_name': handleChatterEditProspectName(tid); break;
      }
      return;
    }

    // View campaign content button
    const viewCampaignBtn = e.target.closest('[data-ct-view-campaign]');
    if (viewCampaignBtn) {
      showCampaignContentPopup(viewCampaignBtn.dataset.ctViewCampaign);
      return;
    }

    // Open the inline prospect-name editor
    const nameEditBtn = e.target.closest('[data-ct-name-edit]');
    if (nameEditBtn) {
      const tid = nameEditBtn.dataset.ctNameEdit;
      state.chatterNameEditOpen[tid] = !state.chatterNameEditOpen[tid];
      render();
      return;
    }

    // Cancel the inline prospect-name editor
    const nameEditCancelBtn = e.target.closest('[data-ct-name-edit-cancel]');
    if (nameEditCancelBtn) {
      const tid = nameEditCancelBtn.dataset.ctNameEditCancel;
      state.chatterNameEditOpen[tid] = false;
      render();
      return;
    }

    // Toggle tag selector
    const tagToggleBtn = e.target.closest('[data-ct-tag-toggle]');
    if (tagToggleBtn) {
      const tid = tagToggleBtn.dataset.ctTagToggle;
      state.chatterTagSelectorOpen[tid] = !state.chatterTagSelectorOpen[tid];
      render();
      return;
    }

    // Set chatter action (Send / Forward / Back / Disconnect)
    const actionTab = e.target.closest('[data-ct-set-action]');
    if (actionTab) {
      const tid = actionTab.dataset.ctTid;
      const newAction = actionTab.dataset.ctSetAction;
      // Toggle off if user clicks the already-selected action
      state.chatterAction[tid] = state.chatterAction[tid] === newAction ? '' : newAction;
      render();
      return;
    }

    // Add tag to task
    const addTagBtn = e.target.closest('[data-ct-add-tag]');
    if (addTagBtn) {
      const tid = addTagBtn.dataset.ctAddTag;
      const tagId = addTagBtn.dataset.tagId;
      const task = getChatterTask(tid);
      const profileNumericId = task?.campaign_prospect?.campaign?.profile?.id;
      const pool = profileNumericId
        ? (state.availableTagsByProfile[String(profileNumericId)] || [])
        : [];
      const tag = pool.find(t => String(t.id) === String(tagId));
      if (tag) {
        const current = state.chatterTaskTags[tid] || [];
        if (!current.some(c => String(c.id) === String(tag.id))) {
          state.chatterTaskTags[tid] = [...current, tag];
        }
        state.chatterTagSelectorOpen[tid] = false;
        render();
      }
      return;
    }

    // Remove tag from task
    const removeTagBtn = e.target.closest('[data-ct-remove-tag]');
    if (removeTagBtn) {
      const tid = removeTagBtn.dataset.ctRemoveTag;
      const tagId = removeTagBtn.dataset.tagId;
      state.chatterTaskTags[tid] = (state.chatterTaskTags[tid] || []).filter(
        t => String(t.id) !== String(tagId)
      );
      render();
      return;
    }

    // View notes button
    const viewNotesBtn = e.target.closest('[data-ct-view-notes]');
    if (viewNotesBtn) {
      showNotesPopup(viewNotesBtn.dataset.ctViewNotes);
      return;
    }

    // View chat button
    const viewReplyTemplatesBtn = e.target.closest('[data-ct-view-reply-templates]');
    if (viewReplyTemplatesBtn) {
      showReplyTemplatesPopup(viewReplyTemplatesBtn.dataset.ctViewReplyTemplates);
      return;
    }

    const viewChatBtn = e.target.closest('[data-ct-view-chat]');
    if (viewChatBtn) {
      showChatPopup(viewChatBtn.dataset.ctViewChat);
      return;
    }

    // Close campaign content popup
    if (e.target.id === 'ct-cc-close' || e.target.id === 'ct-cc-overlay') {
      state.campaignContentPopup = null;
      render();
      return;
    }

    // Close notes popup
    if (e.target.id === 'ct-notes-close' || e.target.id === 'ct-notes-overlay') {
      state.notesPopup = null;
      render();
      return;
    }

    // Close reply templates popup
    if (e.target.id === 'ct-reply-close' || e.target.id === 'ct-reply-overlay') {
      state.replyTemplatesPopup = null;
      render();
      return;
    }

    // Close chat popup
    if (e.target.id === 'ct-chat-close' || e.target.id === 'ct-chat-overlay') {
      state.chatPopup = null;
      render();
      return;
    }
  });

  // Chatter task follow-up checkbox toggle
  document.addEventListener('change', e => {
    const replySelect = e.target.id === 'ct-reply-template-select';
    if (replySelect && state.replyTemplatesPopup) {
      const popup = state.replyTemplatesPopup;
      const selectedIndex = Number(e.target.value);
      const option = popup.options[selectedIndex];
      const message = option ? replaceTemplatePlaceholders(option[1] || '', popup.placeholders || {}) : '';
      state.replyTemplatesPopup = { ...popup, selectedIndex, message };
      render();
      return;
    }

    const fu = e.target.closest('.ct-followup-toggle');
    if (fu) {
      const tid = fu.dataset.ctTid;
      state.chatterFollowUp[tid] = fu.checked;
      render();
      return;
    }
    // Live-update environment hint on login screen
    if (e.target.id === 'chk-production') {
      const hint = document.querySelector('.env-hint');
      if (hint) hint.textContent = e.target.checked ? 'backend.leadblocks.nl' : 'localhost:1337';
      return;
    }
  });

  // Input delegation — contact fields (class="ci")
  document.addEventListener('input', e => {
    const aiNoteInput = e.target.closest('.ct-ai-note');
    if (aiNoteInput && aiNoteInput.dataset.tid) {
      state.chatterAiNote[aiNoteInput.dataset.tid] = aiNoteInput.value;
      // No re-render needed — value is stored in state
      return;
    }
    const input = e.target.closest('.ci');
    if (!input) return;
    const tid = input.dataset.tid;
    const field = input.dataset.field;
    if (!tid || !field) return;
    if (!state.contactDetails[tid]) {
      state.contactDetails[tid] = { email: '', phone: '', birthday: '', date_connected: '' };
    }
    state.contactDetails[tid][field] = input.value;
    // No re-render needed — value is stored in state
  });
}

// Per-element listeners — safe to re-attach after each render (elements are new)
function attachListeners() {
  el('btn-login') ?.addEventListener('click', doLogin);
  el('inp-password') ?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  el('btn-logout') ?.addEventListener('click', doLogout);
  el('btn-refresh-customers')?.addEventListener('click', loadCustomers);

  el('sel-customer')?.addEventListener('change', e => {
    state.pendingCustomerId = e.target.value;
    const customer = state.customers.find(c => String(c.id) === state.pendingCustomerId);
    const profiles = customer?.profiles || [];
    state.pendingProfileId = profiles.length > 0 ? String(profiles[0].id) : '';
    state.campaigns = [];
    state.pendingCampaignId = '';
    if (state.pendingProfileId) loadCampaigns(state.pendingProfileId);
    else render();
  });

  el('sel-profile')?.addEventListener('change', e => {
    state.pendingProfileId = e.target.value;
    state.campaigns = [];
    state.pendingCampaignId = '';
    if (state.pendingProfileId) loadCampaigns(state.pendingProfileId);
    else render();
  });

  el('sel-campaign')?.addEventListener('change', e => {
    state.pendingCampaignId = e.target.value;
    render(); // re-render to update Apply button enabled state
  });

  el('inp-prospect-id')?.addEventListener('input', e => {
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const wasFocused = document.activeElement === input;
    const raw = input.value.trim();

    // Try to parse as a LinkedIn profile URL
    const liMatch = raw.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (liMatch) {
      state.pendingProspectUrl = `https://www.linkedin.com/in/${liMatch[1].toLowerCase()}/`;
      state.pendingProspectId  = '';
      state.pendingProspectName = '';
    } else if (raw === '') {
      state.pendingProspectUrl  = '';
      state.pendingProspectId   = '';
      state.pendingProspectName = '';
    }
    // Non-URL free text: keep whatever the user typed but don't override hover state

    render();
    if (wasFocused) {
      const newInput = document.getElementById('inp-prospect-id');
      if (newInput) {
        newInput.focus();
        // Restore cursor only when we didn't transform the value
        if (!liMatch) newInput.setSelectionRange(start, end);
      }
    }
  });

  el('inp-linkedin')?.addEventListener('input', e => {
    const input = e.target;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const wasFocused = document.activeElement === input;
    state.pendingLinkedInSearch = e.target.value;
    render();
    if (wasFocused) {
      const newInput = document.getElementById('inp-linkedin');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(start, end);
      }
    }
  });

  el('btn-clear-prospect')?.addEventListener('click', () => {
    state.pendingProspectId = '';
    state.pendingProspectName = '';
    state.pendingProspectUrl = '';
    state.acceptanceResult = null;
    state.tasks = [];
    state.totalTasks = 0;
    state.actionedTasks = {};
    state.contactDetails = {};
    // Reset content script dedup state so the same person can be re-detected
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'RESET_HOVER_STATE' }).catch(() => {});
      }
    });
    render();
  });

  el('btn-apply')?.addEventListener('click', () => {
    state.appliedProfileId = state.pendingProfileId;
    state.appliedCampaignId = state.pendingCampaignId;
    state.appliedProspectId = state.pendingProspectId;
    state.appliedProspectUrl = state.pendingProspectUrl;
    state.appliedLinkedInSearch = state.pendingLinkedInSearch;

    const step = STEPS[state.currentStep];
    if (step.key === 'connection_acceptance') {
      lookupConnection();
    } else {
      loadAllTasks();
    }
  });

  el('btn-reset')?.addEventListener('click', () => {
    if (state.customers.length > 0) {
      state.pendingCustomerId = String(state.customers[0].id);
      const profiles = state.customers[0].profiles || [];
      state.pendingProfileId = profiles.length > 0 ? String(profiles[0].id) : '';
      if (state.pendingProfileId) loadCampaigns(state.pendingProfileId);
    }
    state.pendingCampaignId = '';
    state.pendingProspectId = '';
    state.pendingProspectName = '';
    state.pendingProspectUrl = '';
    state.appliedProspectUrl = '';
    state.pendingLinkedInSearch = '';
    state.acceptanceResult = null;
    render();
  });

  el('btn-prev')?.addEventListener('click', () => {
    if (state.currentIndex > 0) { state.currentIndex--; render(); }
  });

  el('btn-next')?.addEventListener('click', () => {
    if (state.currentIndex < state.tasks.length - 1) { state.currentIndex++; render(); }
  });

  el('btn-open-li')?.addEventListener('click', e => {
    const url = e.currentTarget.dataset.url;
    if (url) chrome.tabs.create({ url });
  });

  // First-connection connect button (step 1)
  el('btn-fc-connect')?.addEventListener('click', () => {
    handleFirstConnectionConnect();
  });

  // Chat Scraper — period dropdown
  el('sel-scraper-days')?.addEventListener('change', e => {
    state.chatScraper.scraperDays = Number(e.target.value);
  });

  // Chat Scraper — Scrape Chat button
  el('btn-scrape-chat')?.addEventListener('click', () => {
    state.chatScraper.status = 'scraping';
    state.chatScraper.error = null;
    state.chatScraper.sentCount = null;
    render();
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tabId = tabs[0]?.id;
      const tabUrl = tabs[0]?.url || '';
      if (!tabId) {
        state.chatScraper.status = 'idle';
        state.chatScraper.error = 'No active tab found.';
        render();
        return;
      }
      const days = state.chatScraper.scraperDays;
      const cutoffMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
      chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CHAT', cutoffMs }, response => {
        if (chrome.runtime.lastError || !response) {
          state.chatScraper.status = 'idle';
          state.chatScraper.error = 'Could not reach the LinkedIn page. Reload the page and try again. If the problem persists, check your connection or contact support.';
          render();
          return;
        }
        if (response.error) {
          state.chatScraper.status = 'idle';
          state.chatScraper.error = `${response.error} Please fix the issue and retry scraping.`;
          render();
          return;
        }
        const { messages, profile_id, contact_name } = response.data;
        // Use the selected profile's LinkedIn ID as customer_id
        const customer = state.customers.find(c => String(c.id) === state.pendingCustomerId);
        const profile = (customer?.profiles || []).find(p => String(p.id) === state.pendingProfileId);
        const customer_id = profile?.profile_id || '';
        state.chatScraper.status = 'ready';
        state.chatScraper.messages = messages;
        state.chatScraper.profile_id = profile_id;
        state.chatScraper.customer_id = customer_id;
        state.chatScraper.contact_name = contact_name || '';
        state.chatScraper.thread_url = tabUrl;
        state.chatScraper.sentCount = null;
        state.chatScraper.manualSenderOverrides = {};
        render();
        requestAnimationFrame(() => {
          const list = document.querySelector('.cs-msg-list');
          if (list) list.scrollTop = list.scrollHeight;
        });
      });
    });
  });

  // Chat Scraper — Send to Backend button
  el('btn-send-chat')?.addEventListener('click', async () => {
    if (state.chatScraper.status !== 'ready') return;
    state.chatScraper.status = 'sending';
    state.chatScraper.sentCount = null;
    render();
    try {
      const cs = state.chatScraper;
      const allIds = cs.messages.map(m => m.message_id).filter(Boolean);
      const checkRes = await apiPost('/api/messages/check-existing', { message_ids: allIds });
      const existingSet = new Set(checkRes.existing || []);
      const newMessages = cs.messages.filter(m => !existingSet.has(m.message_id));

      if (newMessages.length === 0) {
        state.chatScraper.status = 'ready';
        state.chatScraper.sentCount = 0;
        render();
        return;
      }

      // Apply manual sender overrides (for messages where sender could not be auto-detected)
      const resolvedMessages = newMessages.map(m => {
        if (m.sender_id !== null) return m;
        const override = cs.manualSenderOverrides?.[m.message_id];
        if (override === 'sent')     return { ...m, sender_id: cs.customer_id };
        if (override === 'received') return { ...m, sender_id: cs.profile_id };
        return m;
      });

      await apiPost('/api/extension/robot-linkedin-chat', {
        messages: resolvedMessages,
        profile_id: cs.profile_id,
        customer_id: cs.customer_id,
      });

      state.chatScraper.status = 'ready';
      state.chatScraper.sentCount = newMessages.length;
      render();
    } catch (err) {
      state.chatScraper.status = 'ready';
      const message = err?.message || String(err);
      const networkError = /network|fetch|failed to fetch|timeout/i.test(message);
      state.chatScraper.error = networkError
        ? 'Sending to backend failed due to a network or connection issue. Please try again before leaving this chat.'
        : `Sending to backend failed: ${message}. Please retry before leaving this chat.`;
      render();
    }
  });
}

function el(id) { return document.getElementById(id); }

// =============================================================================
// AUTH HANDLERS
// =============================================================================

async function doLogin() {
  const isProduction = el('chk-production')?.checked;
  const backendUrl = isProduction ? 'https://backend.leadblocks.nl' : 'http://localhost:1337';
  const email = el('inp-email')?.value?.trim();
  const password = el('inp-password')?.value;
  const errEl = el('login-error');

  if (!email || !password) {
    if (errEl) { errEl.textContent = 'Please fill in all fields.'; errEl.style.display = 'block'; }
    return;
  }

  const btnLogin = el('btn-login');
  if (btnLogin) { btnLogin.disabled = true; btnLogin.textContent = 'Signing in…'; }

  try {
    const data = await loginRequest(backendUrl, email, password);
    const userType = data.user?.type || '';
    if (!ALLOWED_USER_TYPES.includes(userType)) {
      if (errEl) {
        errEl.textContent = 'Your account type is not allowed to use this extension.';
        errEl.style.display = 'block';
      }
      if (btnLogin) { btnLogin.disabled = false; btnLogin.textContent = 'Sign in'; }
      return;
    }
    state.token = data.jwt;
    state.backendUrl = backendUrl;
    state.userName = data.user?.username || data.user?.email || '';
    state.userType = userType;
    state.currentStep = firstVisibleStepIndex();
    await saveAuth(data.jwt, backendUrl, state.userName, state.userType);
    await bootMainView();
  } catch (err) {
    if (errEl) { errEl.textContent = err.message; errEl.style.display = 'block'; }
    if (btnLogin) { btnLogin.disabled = false; btnLogin.textContent = 'Sign in'; }
  }
}

async function doLogout() {
  await clearAuth();
  Object.assign(state, {
    token: null,
    backendUrl: 'http://localhost:1337', // Reset to default
    userName: '',
    userType: '',
    view: 'login',
    customers: [],
    campaigns: [],
    tasks: [],
    pendingCustomerId: '',
    pendingProfileId: '',
    pendingCampaignId: '',
    pendingLinkedInSearch: '',
    pendingProspectId: '',
    pendingProspectName: '',
    pendingProspectUrl: '',
    appliedProfileId: '',
    appliedCampaignId: '',
    appliedProspectId: '',
    appliedProspectUrl: '',
    appliedLinkedInSearch: '',
    actionedTasks: {},
    contactDetails: {},
    acceptanceResult: null,
    currentIndex: 0,
  });
  render();
}

// =============================================================================
// BOOT
// =============================================================================

async function loadCustomers() {
  state.loadingCustomers = true;
  render();
  try {
    const customers = await fetchCustomers();
    state.customers = customers;

    if (customers.length > 0) {
      state.pendingCustomerId = String(customers[0].id);
      const profiles = customers[0].profiles || [];
      if (profiles.length > 0) {
        state.pendingProfileId = String(profiles[0].id);
        await loadCampaigns(state.pendingProfileId);
        state.appliedProfileId = state.pendingProfileId;
        const step = STEPS[state.currentStep];
        if (step.key !== 'connection_acceptance') {
          loadAllTasks(); // don't await — renders when done
          return;
        }
      }
    }
  } catch (err) {
    console.error('loadCustomers failed:', err);
    showToast('Failed to load customers: ' + err.message, 'error');
    if (err.message?.includes('Failed to fetch')) {
      state.error = 'Could not reach the backend. Check your network or backend URL.';
    }
    // If auth error, redirect to login; otherwise stay and let user retry
    if (err.message?.includes('401') || err.message?.includes('403')) {
      await clearAuth();
      state.token = null;
      state.view = 'login';
    }
  } finally {
    state.loadingCustomers = false;
    render();
  }
}

async function bootMainView() {
  state.view = 'main';
  // Refresh user type from backend (handles older sessions without stored userType)
  try {
    const me = await apiGet('/api/users/me');
    if (me?.type) {
      state.userType = me.type;
      chrome.storage.local.set({ userType: me.type });
    }
  } catch (e) {
    console.warn('[Auth] Failed to refresh user type:', e?.message);
  }
  // Enforce user-type whitelist for already-stored sessions
  if (!ALLOWED_USER_TYPES.includes(state.userType)) {
    await clearAuth();
    Object.assign(state, {
      token: null,
      userName: '',
      userType: '',
      view: 'login',
      customers: [],
      campaigns: [],
      tasks: [],
    });
    render();
    return;
  }
  // Make sure we land on a step the user is allowed to see
  if (!isStepVisible(STEPS[state.currentStep])) {
    state.currentStep = firstVisibleStepIndex();
  }
  await loadCustomers();
}

// =============================================================================
// RUNTIME MESSAGES (from content script / background)
// =============================================================================

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'PAGE_URL' || message.type === 'TAB_URL_CHANGED') {
    const newUrl = message.url || '';
    if (newUrl === state.currentTabUrl) return;
    state.currentTabUrl = newUrl;

    if (!newUrl.includes('/overlay/contact-info')) {
      state.currentOverlayProspectId = '';
      state.currentOverlayProfileUrl = '';
      state.lastOverlayWarningUrl = '';
    }

    const step = STEPS[state.currentStep];
    if (isMessagingThreadUrl(newUrl)) {
      // Renders and runs the follow-up auto-check itself whenever the
      // extracted prospect id changes during its poll window.
      refreshCurrentThreadProspectId().catch(() => {});
    } else {
      state.currentThreadProspectId = '';
    }

    // Connection Request / Follow-Up step: full re-render to highlight the matching row
    if (state.view === 'main' && (step.key === 'connection_request' || step.key === 'follow_up') && !state.loading && state.tasks.length > 0) {
      render();
      return;
    }

    // Lightweight update: only refresh the url-status element in queue mode
    if (state.view === 'main' && state.viewMode === 'queue' && !state.loading && state.tasks.length > 0) {
      const task = state.tasks[state.currentIndex];
      const statusEl = document.querySelector('.url-status');
      if (statusEl && task) {
        const matches = urlMatches(task.profile_url, state.currentTabUrl);
        statusEl.className = `url-status ${matches ? 'url-match' : ''}`;
        statusEl.innerHTML = matches
          ? '✓ Currently on this profile'
          : '<span class="url-mismatch">Not yet on this profile</span>';
      }
    }
  }

  // Hover detection — primary: auto-fill prospect ID from Message button
  if (message.type === 'HOVERED_PROSPECT_ID') {
    const step = STEPS[state.currentStep];
    if (state.view !== 'main' || step.key !== 'connection_acceptance') return;

    // Pin the current prospect selection until the user clears it.
    if (state.pendingProspectId || state.pendingProspectUrl) return;

    const id = message.prospectId || '';
    if (id === state.pendingProspectId) return;
    state.pendingProspectId = id;
    state.pendingProspectName = message.prospectName || '';
    // Primary signal wins — clear any pending URL backup
    state.pendingProspectUrl = '';
    render();
  }

  // Hover detection — backup: auto-fill prospect URL from hovering the person's name
  if (message.type === 'HOVERED_PROSPECT_URL') {
    const step = STEPS[state.currentStep];
    if (state.view !== 'main' || step.key !== 'connection_acceptance') return;

    const url = message.profileUrl || '';
    if (!url) return;

    const alreadyPinned = state.pendingProspectId || state.pendingProspectUrl;
    const onContactOverlay = state.currentTabUrl.includes('/overlay/contact-info');

    // On the contact-info overlay, allow a URL hover to set or override the pending URL
    // when no prospect ID is pinned and the current selection doesn't match the overlay.
    // This is the fallback for when prospect_id extraction fails.
    const overlayFallback = onContactOverlay && !state.pendingProspectId && !isConnectionAcceptanceOverlayMatch();

    if (alreadyPinned && !overlayFallback) return;
    if (url === state.pendingProspectUrl) return;

    state.pendingProspectUrl = url;
    state.pendingProspectName = '';
    render();
  }

  // Contact info scraper — auto-fill email, phone, birthday, date_connected
  if (message.type === 'CONTACT_INFO' && message.data) {
    if (state.view !== 'main') return;

    if (message.data.prospect_id) {
      state.currentOverlayProspectId = message.data.prospect_id;
    } else {
      state.currentOverlayProspectId = '';
    }
    if (message.data.profile_url) {
      state.currentOverlayProfileUrl = message.data.profile_url;
    }

    const selectedId = getSelectedConnectionProspectIdRaw();
    const selectedUrl = getSelectedConnectionProfileUrl();
    const profileName = getAppliedProfileName();
    const overlayMatch = isConnectionAcceptanceOverlayMatch();

    // If we are on step 1, only populate contact fields when the overlay matches the selected prospect.
    const step = STEPS[state.currentStep];
    if (step.key === 'connection_acceptance' && !overlayMatch) {
      if (!message.data.prospect_id && state.currentTabUrl.includes('/overlay/contact-info')) {
        if (state.lastOverlayWarningUrl !== state.currentTabUrl) {
          showToast('Could not extract Prospect ID. Hover the LinkedIn URL shown in the contact details to confirm the match.', 'error');
          state.lastOverlayWarningUrl = state.currentTabUrl;
        }
        return;
      }

      if (state.currentOverlayProspectId) {
        reportBlockedUserMistake({
          action: 'connection_acceptance',
          reason: 'overlay_mismatch',
          note: 'System blocked contact-info autofill and Connect because the current overlay does not match the selected prospect. If you are on the correct profile, refresh the page and try again.',
          profileId: state.appliedProfileId || null,
          profileName: profileName || null,
          selectedProspectId: selectedId || null,
          selectedProspectUrl: selectedUrl || null,
          overlayProspectId: state.currentOverlayProspectId || null,
          overlayProfileUrl: state.currentOverlayProfileUrl || null,
          currentTabUrl: state.currentTabUrl || null,
          acceptanceStatus: state.acceptanceResult?.status || null,
        });
      }
      return;
    }

    // Find the task ID for the currently visible card
    let tid = null;
    if (step.key === 'connection_acceptance') {
      // First-connection or open_task
      if (state.acceptanceResult?.status === 'first_connection') {
        tid = 'fc';
      } else if (state.acceptanceResult?.task) {
        tid = state.acceptanceResult.task.id;
      }
    } else if (state.tasks.length > 0) {
      tid = state.tasks[state.currentIndex]?.id;
    }
    if (tid == null) return;

    if (!state.contactDetails[tid]) state.contactDetails[tid] = {};
    const contact = state.contactDetails[tid];

    // Only accept the first value per field — don't overwrite when visiting another profile
    for (const field of ['email', 'phone', 'birthday', 'date_connected']) {
      if (message.data[field] && !contact[field]) {
        contact[field] = message.data[field];
        const input = document.querySelector(`.ci[data-tid="${tid}"][data-field="${field}"]`);
        if (input) input.value = message.data[field];
      }
    }

    render();
  }
});

// =============================================================================
// INIT
// =============================================================================

// The PAGE_URL/TAB_URL_CHANGED messages only arrive on navigation, so when the
// side panel opens while the user is already on a page, ask Chrome directly.
function seedCurrentTabUrl() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const url = tabs?.[0]?.url || '';
        if (url && !state.currentTabUrl) {
          state.currentTabUrl = url;
          if (isMessagingThreadUrl(url)) refreshCurrentThreadProspectId().catch(() => {});
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

async function init() {
  setupGlobalDelegation();
  await loadStoredAuth();
  await seedCurrentTabUrl();

  if (state.token) {
    await bootMainView();
  } else {
    state.view = 'login';
    render();
  }
}

init();
