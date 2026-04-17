// =============================================================================
// STATE
// =============================================================================

const STEPS = [
  { key: 'connection_acceptance', label: 'Connection Acceptance', enabled: true },
  { key: 'messaging', label: 'Messaging', enabled: false },
  { key: 'connection_request', label: 'Connection Request', enabled: false },
  { key: 'follow_up', label: 'Follow-Up', enabled: false },
  { key: 'revoke_connection_request', label: 'Revoke Connection Request', enabled: true },
];

const state = {
  // Auth
  token: null,
  backendUrl: 'https://backend.leadblocks.nl',

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
  pendingLinkedInSearch: '',

  // Applied (active) filters
  appliedProfileId: '',
  appliedCampaignId: '',
  appliedProspectId: '',
  appliedLinkedInSearch: '',

  // Queue
  currentIndex: 0,
  totalTasks: 0,

  // Per-task state
  actionedTasks: {},      // taskId -> 'connected' | 'revoked' | 'disconnected'
  contactDetails: {},     // taskId -> {email, phone, birthday, date_connected}

  // Connection acceptance (step 1) state
  acceptanceResult: null,  // null | { status, task?, message? }

  // UI
  view: 'login',          // 'login' | 'main'
  viewMode: 'queue',      // 'queue' | 'list'
  loading: false,
  loadingCampaigns: false,
  loadingCustomers: false,
  error: null,
  currentTabUrl: '',
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

function getAvailableProfiles() {
  const customer = state.customers.find(c => String(c.id) === state.pendingCustomerId);
  return customer ? (customer.profiles || []) : [];
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

// =============================================================================
// API
// =============================================================================

async function apiGet(path) {
  if (!state.backendUrl || !state.backendUrl.startsWith('http')) {
    throw new Error(`Invalid backend URL: ${state.backendUrl}. Please log in again.`);
  }
  const fullUrl = `${state.backendUrl}${path}`;
  console.log('[API] GET request to:', fullUrl);
  const res = await fetch(fullUrl, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function apiPost(path, body) {
  if (!state.backendUrl || !state.backendUrl.startsWith('http')) {
    throw new Error(`Invalid backend URL: ${state.backendUrl}. Please log in again.`);
  }
  const fullUrl = `${state.backendUrl}${path}`;
  console.log('[API] POST request to:', fullUrl, 'with body:', body);
  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

// =============================================================================
// CHROME STORAGE
// =============================================================================

function loadStoredAuth() {
  return new Promise(resolve => {
    chrome.storage.local.get(['token', 'backendUrl'], data => {
      console.log('[Auth] Loaded from storage:', { token: !!data.token, backendUrl: data.backendUrl });
      if (data.token) state.token = data.token;
      // Only update backendUrl if we have a stored value, otherwise keep default
      if (data.backendUrl && typeof data.backendUrl === 'string' && data.backendUrl.trim()) {
        state.backendUrl = data.backendUrl.trim().replace(/\/+$/, '');
      }
      console.log('[Auth] State after loading:', { backendUrl: state.backendUrl, token: !!state.token });
      resolve();
    });
  });
}

function saveAuth(token, backendUrl) {
  return new Promise(resolve => chrome.storage.local.set({ token, backendUrl }, resolve));
}

function clearAuth() {
  return new Promise(resolve => chrome.storage.local.remove(['token', 'backendUrl'], resolve));
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
      profiles: (c.profiles || []).map(p => ({ id: p.id, profile_name: p.profile_name })),
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
      all = result.data || [];
    }

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
    params.append('prospectId', state.appliedProspectId);

    const result = await apiGet(`/api/extension/connection-acceptance?${params.toString()}`);
    state.acceptanceResult = result;

    // If a task is returned, put it in the tasks array so the card UI can render it
    if (result.task) {
      state.tasks = [result.task];
      state.totalTasks = 1;
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
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  const contact = state.contactDetails[taskId] || {};

  // Check if Date Connected is filled
  if (!contact.date_connected || contact.date_connected.trim() === '') {
    showToast('Please fill in the Date Connected field before connecting.', 'error');
    return;
  }

  try {
    await apiPost('/api/data-senders/connect', {
      ...task,
      revoke_task_id: task.id,
      email: contact.email || '',
      phone: contact.phone || '',
      birthday: contact.birthday || '',
      date_connected: contact.date_connected || '',
    });
    state.actionedTasks[taskId] = 'connected';
    showToast('Connection confirmation sent!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function handleRevoke(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  try {
    await apiPost('/api/data-senders/revoke', task);
    state.actionedTasks[taskId] = 'revoked';
    showToast('Revoke confirmation sent!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}

async function handleDisconnect(taskId) {
  const task = state.tasks.find(t => String(t.id) === String(taskId));
  if (!task) return;
  try {
    await apiPost('/api/data-senders/disconnect', task);
    state.actionedTasks[taskId] = 'disconnected';
    showToast('Prospect disconnected!', 'success');
    if (state.viewMode === 'queue') {
      setTimeout(advanceQueue, 600);
    } else {
      render();
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
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
  const contact = state.contactDetails['fc'] || {};

  if (!contact.date_connected || contact.date_connected.trim() === '') {
    showToast('Please fill in the Date Connected field before connecting.', 'error');
    return;
  }

  try {
    const prospectId = state.appliedProspectId;
    console.log('[FirstConnection] Connecting with prospectId:', prospectId);

    await apiPost('/api/extension/connection-acceptance/first-connection', {
      profileId: state.appliedProfileId,
      prospectId,
      prospect_name: state.pendingProspectName || '',
      email: contact.email || '',
      phone: contact.phone || '',
      birthday: contact.birthday || '',
      date_connected: contact.date_connected || '',
    });
    state.actionedTasks['fc'] = 'connected';
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
  app.innerHTML = state.view === 'login' ? buildLogin() : buildMain();
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
        </div>
      </div>
      <div class="field">
        <label>Username</label>
        <input type="text" id="inp-email" placeholder="username" autocomplete="username" />
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
  return `
    <div class="header">
      <img src="../assets/logo.png" alt="Leadblocks" class="logo" />
      <button id="btn-logout" class="btn-link">Logout</button>
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
    const isActive = i === state.currentStep;
    const isDone = i < state.currentStep;
    const cls = isActive ? 'step active' : isDone ? 'step done' : 'step';
    const num = i + 1;
    return `
      <button class="${cls}" data-step="${i}" ${!step.enabled ? 'disabled' : ''} title="${esc(step.label)}">
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

  const filtersChanged =
    state.pendingProfileId !== state.appliedProfileId ||
    state.pendingCampaignId !== state.appliedCampaignId ||
    state.pendingProspectId !== state.appliedProspectId ||
    state.pendingLinkedInSearch !== state.appliedLinkedInSearch;

  // For connection acceptance, require a prospect ID; for other steps, require a profile
  const canApply = isAcceptance
    ? state.pendingProfileId && state.pendingProspectId.trim() !== ''
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
          <label>Prospect <span class="info-icon" data-tooltip="Hover the Bericht button on a LinkedIn profile to auto-fill">i</span></label>
          <div class="prospect-input-row">
            <input type="text" id="inp-prospect-id" value="${esc(state.pendingProspectName || state.pendingProspectId)}" placeholder="Hover the Bericht button to auto-fill..." readonly />
            ${state.pendingProspectId ? `<button id="btn-clear-prospect" class="btn-clear" title="Clear">&times;</button>` : ''}
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

function buildTaskArea() {
  const step = STEPS[state.currentStep];

  // Steps 2-5 are not yet implemented
  if (!step.enabled) {
    return `<div class="empty-state" style="padding:32px 0"><strong>${esc(step.label)}</strong><br><br>This step is not yet available.<br>It will be added in a future update.</div>`;
  }

  if (state.loading) {
    return `<div class="loading"><div class="spinner"></div><span>Loading tasks…</span></div>`;
  }
  if (state.error) {
    return `<div class="error-msg">Failed to load tasks: ${esc(state.error)}</div>`;
  }
  if (!state.appliedProfileId) {
    return `<div class="empty-state">Select a customer and profile, then click Apply.</div>`;
  }

  // Step 1: Connection acceptance — single-lookup flow
  if (step.key === 'connection_acceptance') {
    return buildConnectionAcceptanceArea();
  }

  if (state.tasks.length === 0) {
    return `<div class="empty-state">No tasks found.</div>`;
  }

  // Revoke step: always show compact list for fast bulk revoking
  if (step.key === 'revoke_connection_request') {
    return buildRevokeList();
  }

  return `${buildQueueMode()}`;
}

// --- Connection acceptance (step 1) ---

function buildConnectionAcceptanceArea() {
  const r = state.acceptanceResult;

  // No lookup performed yet
  if (!r) {
    return `<div class="empty-state">Go to <a href="https://www.linkedin.com/mynetwork/invite-connect/connections/" target="_blank" class="hint-link">https://www.linkedin.com/mynetwork/invite-connect/connections/</a> and hover over the <strong>Bericht</strong> button for the prospect that connected. The prospect filter will be filled, then press Filter.</div>`;
  }

  // Already actioned in this session
  if (r.task && state.actionedTasks[r.task.id]) {
    const label = state.actionedTasks[r.task.id];
    return `
      <div class="success-card">
        <div class="success-icon">✓</div>
        <div class="success-title">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</div>
        <div class="success-hint">Hover over the next Bericht button and press Filter again.</div>
      </div>
    `;
  }

  // status: 'open_task' — revoke task found, show card so user can handle it
  if (r.status === 'open_task' && r.task) {
    const task = r.task;
    const contact = state.contactDetails[task.id] || { email: '', phone: '', birthday: '', date_connected: '' };
    const campaignHtml = buildCampaignPill(task);
    const dueHtml = task.due_date ? buildDueBadge(task.due_date) : '';

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
          <button class="btn btn-primary btn-sm" data-action="connect" data-tid="${task.id}">Connect</button>
          <button class="btn btn-danger btn-sm" data-action="disconnect" data-tid="${task.id}">Disconnect</button>
        </div>
      </div>
    `;
  }

  // status: 'already_connected' — task was closed, no action needed
  if (r.status === 'already_connected') {
    return `
      <div class="empty-state" style="padding:24px 0">
        <strong>Already connected</strong><br><br>
        This prospect was already processed. No action needed.<br>
        Hover over the next Bericht button and press Filter.
      </div>
    `;
  }

  // status: 'already_first_connected' — first connection already processed
  if (r.status === 'already_first_connected') {
    return `
      <div class="empty-state" style="padding:24px 0">
        <strong>Already first connected</strong><br><br>
        This prospect was already processed as a first connection. No action needed.<br>
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
          <button class="btn btn-primary btn-sm" id="btn-fc-connect">Connect</button>
        </div>
      </div>
    `;
  }

  // Fallback
  return `<div class="empty-state">No result. Hover over the Bericht button and press Filter.</div>`;
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
          </span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="revoke-summary">${state.tasks.length} task${state.tasks.length !== 1 ? 's' : ''} due — go to <a href="https://www.linkedin.com/mynetwork/invitation-manager/sent/" target="_blank" class="hint-link">https://www.linkedin.com/mynetwork/invitation-manager/sent/</a></div>
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
        <button class="btn btn-danger btn-sm" data-action="disconnect" data-tid="${task.id}">Disconnect</button>
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
            : `<button class="btn btn-danger btn-xs" data-action="disconnect" data-tid="${task.id}">Disconnect</button>`
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
      render();
      return;
    }

    // View toggle
    const viewBtn = e.target.closest('.btn-toggle[data-view]');
    if (viewBtn) {
      state.viewMode = viewBtn.dataset.view;
      render();
      return;
    }

    // Task action buttons
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const tid = actionBtn.dataset.tid;
      switch (actionBtn.dataset.action) {
        case 'connect':    handleConnect(tid); break;
        case 'revoke':     handleRevoke(tid); break;
        case 'disconnect': handleDisconnect(tid); break;
        case 'skip':
          state.currentIndex = Math.min(state.currentIndex + 1, state.tasks.length - 1);
          render();
          break;
      }
    }
  });

  // Input delegation — contact fields (class="ci")
  document.addEventListener('input', e => {
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
    render();
  });

  el('btn-apply')?.addEventListener('click', () => {
    state.appliedProfileId = state.pendingProfileId;
    state.appliedCampaignId = state.pendingCampaignId;
    state.appliedProspectId = state.pendingProspectId;
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
    state.token = data.jwt;
    state.backendUrl = backendUrl;
    console.log('[Auth] Set backendUrl to:', state.backendUrl);
    await saveAuth(data.jwt, backendUrl);
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
    view: 'login',
    customers: [],
    campaigns: [],
    tasks: [],
    pendingCustomerId: '',
    pendingProfileId: '',
    pendingCampaignId: '',
    pendingLinkedInSearch: '',
    appliedProfileId: '',
    appliedCampaignId: '',
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
  await loadCustomers();
}

// =============================================================================
// RUNTIME MESSAGES (from content script / background)
// =============================================================================

chrome.runtime.onMessage.addListener(message => {
  console.log('[Sidepanel] Received runtime message:', message.type, message);
  if (message.type === 'PAGE_URL' || message.type === 'TAB_URL_CHANGED') {
    const newUrl = message.url || '';
    if (newUrl === state.currentTabUrl) return;
    state.currentTabUrl = newUrl;

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

  // Hover detection — auto-fill prospect ID filter on step 1
  if (message.type === 'HOVERED_PROSPECT_ID') {
    console.log('[Sidepanel] Received HOVERED_PROSPECT_ID:', message.prospectId);
    const step = STEPS[state.currentStep];
    if (state.view !== 'main' || step.key !== 'connection_acceptance') return;

    const id = message.prospectId || '';
    if (id === state.pendingProspectId) return;
    state.pendingProspectId = id;
    state.pendingProspectName = message.prospectName || '';
    render();
  }

  // Contact info scraper — auto-fill email, phone, birthday, date_connected
  if (message.type === 'CONTACT_INFO' && message.data) {
    console.log('[Sidepanel] Received CONTACT_INFO:', message.data);
    if (state.view !== 'main') return;

    // Find the task ID for the currently visible card
    const step = STEPS[state.currentStep];
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
  }
});

// =============================================================================
// INIT
// =============================================================================

async function init() {
  console.log('[Init] Starting extension initialization');
  setupGlobalDelegation();
  await loadStoredAuth();
  console.log('[Init] After loading auth, token present:', !!state.token, 'backendUrl:', state.backendUrl);

  if (state.token) {
    console.log('[Init] Token found, booting main view');
    await bootMainView();
  } else {
    console.log('[Init] No token, showing login view');
    state.view = 'login';
    render();
  }
}

init();
