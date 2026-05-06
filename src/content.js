// Send the current page URL to the extension side panel.
// Only window.location.href is read — no DOM scraping.

function sendUrl() {
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ type: 'PAGE_URL', url: window.location.href }).catch(() => {});
  } catch (_) {}
}

// Send on initial load
sendUrl();

// LinkedIn is a SPA — intercept pushState to catch client-side navigation
const originalPushState = history.pushState.bind(history);
history.pushState = function (...args) {
  originalPushState(...args);
  sendUrl();
};

window.addEventListener('popstate', sendUrl);

// =============================================================================
// CONTEXT INVALIDATION DETECTION
// When Chrome updates/reloads the extension while a tab is already open,
// chrome.runtime.id becomes undefined. Detect this and prompt the user to reload.
// =============================================================================

(function watchContextInvalidation() {
  let shown = false;
  const check = setInterval(() => {
    if (!chrome.runtime?.id && !shown) {
      shown = true;
      clearInterval(check);
      // Only inject if body is available
      const target = document.body || document.documentElement;
      if (!target) return;
      const banner = document.createElement('div');
      banner.style.cssText = [
        'position:fixed', 'top:0', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:#db2f43', 'color:white',
        'padding:9px 20px', 'border-radius:0 0 8px 8px',
        'font:600 13px/1 -apple-system,sans-serif',
        'box-shadow:0 2px 10px rgba(0,0,0,0.35)', 'cursor:pointer',
        'white-space:nowrap',
      ].join(';');
      banner.textContent = '⚠ Leadblocks extension was updated — click here to reconnect';
      banner.addEventListener('click', () => location.reload());
      target.appendChild(banner);
    }
  }, 2000);
})();

// =============================================================================
// HOVER DETECTION — extract prospect ID / URL from LinkedIn profile interactions
//
// Three layers, in priority order:
//   1. Messaging link (compose/thread URL) — contains fsd_profile URN directly
//   2. MutationObserver on hover cards — LinkedIn inserts a card with a Message
//      button whenever the user hovers a name; we scan that card immediately
//   3. Any /in/ profile anchor hovered directly (name link, profile card link, …)
//
// All layers feed into one shared extraction function so priority is enforced
// and there is a single debounce timer.
//
// Both pointer listeners use capture:true so they fire before any LinkedIn
// handler that might call stopPropagation().
// =============================================================================

console.log('[Content] Content script loaded on:', window.location.href);

(function initHoverDetection() {
  console.log('[Content] Initializing hover detection');

  const MSG_URN_RE  = /[?&]profileUrn=urn(?:%3A|:)li(?:%3A|:)fsd_profile(?:%3A|:)([A-Za-z0-9_-]+)/i;
  const LI_PROFILE_RE = /linkedin\.com\/in\/([^/?#\s]+)/i;

  let lastSentId  = '';
  let lastSentUrl = '';
  let debounceTimer = null;

  // ---------------------------------------------------------------------------
  // Shared extraction — called by every layer below.
  // Primary signal (profileUrn from message link) always wins over URL signal.
  // ---------------------------------------------------------------------------
  function tryExtractFromAnchor(anchor) {
    if (!anchor) return;
    const href = anchor.href || '';
    if (!href) return;

    // --- Primary: messaging link carries the fsd_profile URN ---
    if (href.includes('messaging/compose') || href.includes('messaging/thread')) {
      const match = href.match(MSG_URN_RE);
      if (!match) return;

      const prospectId = decodeURIComponent(match[1]);
      if (prospectId === lastSentId) return;

      const ariaLabel = anchor.getAttribute('aria-label') || '';
      const nameMatch = ariaLabel.match(/(?:(?:send\s+a\s+message|message)\s+to|naar)\s+(.+?)(?:\s*,.*)?$/i);
      const prospectName = nameMatch ? nameMatch[1].trim() : '';

      console.log('[Hover] Prospect ID extracted:', prospectId, '| Name:', prospectName);
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!chrome.runtime?.id) return;
        try {
          lastSentId  = prospectId;
          lastSentUrl = ''; // primary wins — discard any pending URL signal
          chrome.runtime.sendMessage({ type: 'HOVERED_PROSPECT_ID', prospectId, prospectName }).catch(() => {});
          console.log('[Hover] Sent HOVERED_PROSPECT_ID:', prospectId, '| Name:', prospectName);
        } catch (_) {}
      }, 150);
      return;
    }

    // --- Backup: any LinkedIn /in/ profile link ---
    const match = href.match(LI_PROFILE_RE);
    if (!match) return;

    const profileUrl = `https://www.linkedin.com/in/${match[1].toLowerCase()}/`;
    if (profileUrl === lastSentUrl) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!chrome.runtime?.id) return;
      try {
        lastSentUrl = profileUrl;
        chrome.runtime.sendMessage({ type: 'HOVERED_PROSPECT_URL', profileUrl }).catch(() => {});
        console.log('[Hover] Sent HOVERED_PROSPECT_URL:', profileUrl);
      } catch (_) {}
    }, 150);
  }

  // ---------------------------------------------------------------------------
  // Layer 1 & 3 — capture-phase pointer events
  // capture:true means we run BEFORE any LinkedIn stopPropagation() call.
  // Both mouseover and pointerover are registered for broadest coverage.
  // ---------------------------------------------------------------------------
  function onPointerOver(e) {
    tryExtractFromAnchor(e.target.closest('a[href]'));
  }

  document.addEventListener('mouseover',   onPointerOver, { capture: true });
  document.addEventListener('pointerover', onPointerOver, { capture: true });

  // ---------------------------------------------------------------------------
  // Layer 2 — MutationObserver on hover cards
  // When the user hovers a name, LinkedIn dynamically inserts a profile hover
  // card containing a Message button. Scanning it on insertion gives us the
  // profileUrn without depending on the card's internal DOM structure.
  // ---------------------------------------------------------------------------
  const cardObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue; // elements only

        // Collect all anchors inside the inserted node (and the node itself)
        const anchors = node.querySelectorAll('a[href]');
        for (const anchor of anchors) {
          tryExtractFromAnchor(anchor);
        }
      }
    }
  });

  const startCardObserver = () => {
    const target = document.body || document.documentElement;
    if (!target) return;
    cardObserver.observe(target, { childList: true, subtree: true });
    console.log('[Hover] Hover-card observer started');
  };

  // Reset lastSentId on navigation so a new prospect can be detected fresh
  const resetOnNav = () => { lastSentId = ''; lastSentUrl = ''; };
  window.addEventListener('popstate', resetOnNav);
  const _origPush = history.pushState.bind(history);
  history.pushState = function (...args) { _origPush(...args); resetOnNav(); };

  if (document.body) startCardObserver();
  else document.addEventListener('DOMContentLoaded', startCardObserver);

  // Allow the sidepanel to reset dedup state when the user clears the prospect
  // field — so the same person can be re-detected without a page navigation.
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'RESET_HOVER_STATE') {
      lastSentId  = '';
      lastSentUrl = '';
      clearTimeout(debounceTimer);
      console.log('[Hover] State reset by sidepanel');
    }
  });
})();

// =============================================================================
// CONTACT INFO SCRAPER — extract email, phone, birthday, date_connected
// from the LinkedIn "Contact info" overlay ({profile}/overlay/contact-info/).
// Uses MutationObserver to detect when LinkedIn renders the overlay content.
// Reads textContent and href attributes only; no DOM mutation, no clicks.
// =============================================================================

(function initContactInfoScraper() {
  // Month names + abbreviations → 0-based index (EN + NL only)
  const MONTHS = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    januari: 0, februari: 1, maart: 2, mei: 4, juni: 5, juli: 6,
    augustus: 7, oktober: 9,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6,
    aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    mrt: 2, okt: 9,
    // German
    januar: 0, februar: 1, märz: 2, mai: 4, dezember: 11, mär: 2, dez: 11,
    // French
    janvier: 0, février: 1, mars: 2, avril: 3, juin: 5, juillet: 6,
    août: 7, octobre: 9, décembre: 11,
    fév: 1, avr: 3, juil: 6, aoû: 7, déc: 11,
  };

  // Label text (lowercased) → field name
  const LABEL_MAP = {
    'e-mail': 'email', 'email': 'email',
    'telefoon': 'phone', 'phone': 'phone',
    'verjaardag': 'birthday', 'birthday': 'birthday',
    'connectie sinds': 'date_connected', 'connected since': 'date_connected',
  };

  /** Parse "day month year" or "month day year" → YYYY-MM-DD */
  function parseDateYMD(raw) {
    const c = raw.replace(/\./g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    let m = c.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
    if (m) { const mo = MONTHS[m[2].toLowerCase()]; if (mo !== undefined) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    m = c.match(/^(\w+)\s+(\d{1,2})\s+(\d{4})$/);
    if (m) { const mo = MONTHS[m[1].toLowerCase()]; if (mo !== undefined) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`; }
    return null;
  }

  /** Parse date → DD-MM-YYYY or DD-MM if no year (for birthday) */
  function parseDateDMY(raw) {
    const c = raw.replace(/\./g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    let m = c.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})$/);
    if (m) { const mo = MONTHS[m[2].toLowerCase()]; if (mo !== undefined) return `${m[1].padStart(2, '0')}-${String(mo + 1).padStart(2, '0')}-${m[3]}`; }
    m = c.match(/^(\w+)\s+(\d{1,2})\s+(\d{4})$/);
    if (m) { const mo = MONTHS[m[1].toLowerCase()]; if (mo !== undefined) return `${m[2].padStart(2, '0')}-${String(mo + 1).padStart(2, '0')}-${m[3]}`; }
    m = c.match(/^(\d{1,2})\s+(\w+)$/);
    if (m) { const mo = MONTHS[m[2].toLowerCase()]; if (mo !== undefined) return `${m[1].padStart(2, '0')}-${String(mo + 1).padStart(2, '0')}`; }
    m = c.match(/^(\w+)\s+(\d{1,2})$/);
    if (m) { const mo = MONTHS[m[1].toLowerCase()]; if (mo !== undefined) return `${m[2].padStart(2, '0')}-${String(mo + 1).padStart(2, '0')}`; }
    return null;
  }

  /** Extract a contact field value from a label/value element pair */
  function extractFieldValue(field, valueEl) {
    if (!valueEl) return '';
    if (field === 'email') {
      const mailto = valueEl.querySelector('a[href^="mailto:"]');
      return mailto ? mailto.textContent.trim() : valueEl.textContent.trim();
    }
    if (field === 'date_connected') return parseDateYMD(valueEl.textContent.trim()) || '';
    if (field === 'birthday')      return parseDateDMY(valueEl.textContent.trim()) || '';
    return valueEl.textContent.trim();
  }

  /** Scrape all contact info sections from the current page */
  function scrapeContactInfo() {
    const result = {};

    // Pattern 1: <p> label + <p> value (primary — used by most LinkedIn locales)
    for (const p of document.querySelectorAll('p')) {
      const field = LABEL_MAP[p.textContent.trim().toLowerCase()];
      if (!field || result[field]) continue;
      const next = p.nextElementSibling;
      if (!next || next.tagName !== 'P') continue;
      const value = extractFieldValue(field, next);
      if (value) result[field] = value;
    }

    // Pattern 2: <dt> label + <dd> value (fallback — used by some LinkedIn locale variants)
    for (const dt of document.querySelectorAll('dt')) {
      const field = LABEL_MAP[dt.textContent.trim().toLowerCase()];
      if (!field || result[field]) continue; // don't overwrite pattern-1 results
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      const value = extractFieldValue(field, dd);
      if (value) result[field] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
  }

  let lastScrapedUrl = '';
  let scrapeTimer = null;

  const observer = new MutationObserver(() => {
    const url = window.location.href;
    if (!url.includes('/overlay/contact-info')) {
      lastScrapedUrl = '';
      return;
    }
    if (url === lastScrapedUrl) return;

    // Debounce to let all sections render before scraping
    clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(() => {
      const info = scrapeContactInfo();
      if (!info) return;

      lastScrapedUrl = url;
      if (!chrome.runtime?.id) return;
      try {
        chrome.runtime.sendMessage({ type: 'CONTACT_INFO', data: info }).catch(() => {});
        console.log('[Content] Sent CONTACT_INFO:', info);
      } catch (_) {}
    }, 300);
  });

  const startObserver = () => {
    const target = document.body || document.documentElement;
    if (!target) return;
    observer.observe(target, { childList: true, subtree: true });
    console.log('[Content] Contact info observer started');
  };

  if (document.body) startObserver();
  else document.addEventListener('DOMContentLoaded', startObserver);
})();

// =============================================================================
// CHAT SCRAPER — extract messages from a LinkedIn messaging thread on demand.
// Responds to { type: 'SCRAPE_CHAT' } from the sidepanel via chrome.tabs.sendMessage.
// Returns { data: { messages, profile_id, customer_id } } or { error: '...' }.
// =============================================================================

(function initChatScraper() {
  const THREAD_RE = /linkedin\.com\/messaging\/(thread|conversations)\//i;
  // URN format: urn:li:msg_message:(urn:li:fsd_profile:PROFILE_ID,MESSAGE_ID)
  // Also matches older member: and fs_profile: URN variants used by LinkedIn.
  const URN_RE = /urn:li:(?:msg_message|msg_event):\(urn:li:(?:fsd_profile|member|fs_profile):([A-Za-z0-9_-]+),([^)]+)\)/;
  const LI_ID_RE = /linkedin\.com\/in\/([A-Za-z0-9_-]+)/i;

  const MONTH_MAP = {};  // kept for potential future use

  // Decode the Unix timestamp (ms) from the base64 message ID embedded in the URN.
  // URN format: urn:li:msg_message:(urn:li:fsd_profile:PROFILE_ID,2-BASE64==)
  // Decoded base64 starts with the millisecond timestamp, e.g. "1776083208354b30051-..."
  function timestampFromUrn(urn) {
    const b64Match = urn.match(/,2-([A-Za-z0-9+/]+=*)\)/);
    if (!b64Match) return '';
    try {
      const decoded = atob(b64Match[1]);
      const digits = decoded.match(/^(\d+)/);
      if (!digits) return '';
      const date = new Date(parseInt(digits[1], 10));
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const dd = String(date.getDate()).padStart(2, '0');
      const hh = String(date.getHours()).padStart(2, '0');
      const mi = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      return `${mm}/${dd}/${date.getFullYear()} ${hh}:${mi}:${ss}`;
    } catch (e) {
      return '';
    }
  }

  function scrapeChat(cutoffMs = 0) {
    // Contact LinkedIn ID — from thread header profile link
    let contactId = null;
    const profileLinks = document.querySelectorAll(
      '.msg-thread__top-bar a[href*="/in/"], .msg-entity-lockup a[href*="/in/"], .msg-thread__link-to-profile'
    );
    for (const link of profileLinks) {
      const m = (link.href || '').match(LI_ID_RE);
      if (m) { contactId = m[1]; break; }
    }

    // Contact display name — from thread header title element
    let contactName = '';
    const nameEl = document.querySelector(
      '.msg-entity-lockup__entity-title, .msg-thread__headline, h2.msg-conversation-card__participant-names'
    );
    if (nameEl) {
      contactName = nameEl.textContent.trim();
    } else {
      // Fallback: parse page title e.g. "Messaging | John Doe | LinkedIn"
      const titleMatch = document.title.match(/^Messaging\s*[|–-]\s*(.+?)\s*[|–-]/);
      if (titleMatch) contactName = titleMatch[1].trim();
    }

    // Primary selectors; fallbacks added for resilience against LinkedIn class renames.
    const container = document.querySelector(
      '.msg-s-message-list__container, .msg-s-message-list,' +
      '.msg-s-message-list__scrollable, [data-view-name="message-list-content"]'
    );
    if (!container) return null;

    // Primary: LinkedIn BEM class for message list events.
    // Fallback: any element with data-event-urn inside a <li>.
    let messageItems = Array.from(
      container.querySelectorAll('li.msg-s-message-list__event')
    );
    if (messageItems.length === 0) {
      const urnEls = Array.from(container.querySelectorAll('[data-event-urn]'));
      const seen = new Set();
      messageItems = [];
      for (const urnEl of urnEls) {
        const li = urnEl.closest('li') || urnEl;
        if (!seen.has(li)) { seen.add(li); messageItems.push(li); }
      }
    }
    if (messageItems.length === 0) return null;

    const messages = [];

    for (const item of messageItems) {
      const eventItem = item.querySelector('[data-event-urn]');
      if (!eventItem) continue;

      const urn = eventItem.getAttribute('data-event-urn') || '';
      const urnMatch = urn.match(URN_RE);
      if (!urnMatch) continue;

      const urnProfileId = urnMatch[1];
      const messageId = urnMatch[2].replace(/^\d+-/, '');

      // Primary: BEM modifier class set by LinkedIn
      const hasBemClass = eventItem.classList.contains('msg-s-event-listitem--other');
      // Fallback: find a profile link inside the event item and compare its slug to contactId.
      // LinkedIn always renders a sender avatar/name as an anchor with href="/in/<slug>".
      // If the slug matches contactId the message is incoming; if it differs it is outgoing.
      let isFromOtherFallback = null;
      if (contactId) {
        const senderLink = eventItem.querySelector('a[href*="/in/"]');
        if (senderLink) {
          const slugMatch = (senderLink.href || '').match(LI_ID_RE);
          if (slugMatch) {
            isFromOtherFallback = slugMatch[1].toLowerCase() === contactId.toLowerCase();
          }
        }
      }
      // Prefer BEM class; use link-based fallback if class is absent.
      // If both signals are absent, direction is unknown — sender_id will be null
      // and the sidepanel will block sending until the issue is resolved.
      const directionKnown = hasBemClass || (isFromOtherFallback !== null);
      const isFromOther = hasBemClass || (isFromOtherFallback === true);
      const sender_id = directionKnown
        ? (isFromOther ? (contactId || '') : (urnProfileId || ''))
        : null; // null = direction could not be determined

      // Try multiple selector variants in case LinkedIn renames the class.
      const bodyEl = eventItem.querySelector(
        '.msg-s-event-listitem__body, .msg-s-event__body, .msg-s-event-listitem__message-text'
      );
      const content = bodyEl ? bodyEl.innerText.trim() : '';

      const message_date = timestampFromUrn(urn);

      // Apply cutoff filter — skip messages older than the requested period.
      // timestampFromUrn returns '' if the URN can't be decoded; those always pass through.
      if (cutoffMs > 0 && message_date) {
        const [datePart, timePart] = message_date.split(' ');
        const [mm, dd, yyyy] = datePart.split('/');
        const msgTs = new Date(`${yyyy}-${mm}-${dd}T${timePart}`).getTime();
        if (!isNaN(msgTs) && msgTs < cutoffMs) continue;
      }

      messages.push({
        message_id: messageId,
        content,
        sender_id,
        message_date,
      });
    }

    if (messages.length === 0 && messageItems.length > 0) {
      // Items were in the DOM but all filtered out by the cutoff date
      return { messages: [], filtered_empty: true, profile_id: contactId || '', contact_name: contactName };
    }

    if (messages.length === 0) return null;

    return { messages, profile_id: contactId || '', contact_name: contactName };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'SCRAPE_CHAT') return;

    if (!THREAD_RE.test(window.location.href)) {
      sendResponse({ error: 'Not on a LinkedIn messaging thread. Navigate to a chat first.' });
      return true;
    }

    const cutoffMs = message.cutoffMs || 0;
    const data = scrapeChat(cutoffMs);
    if (!data) {
      sendResponse({ error: 'Could not find messages on this page. Scroll down to load them and try again. If messages are visible but this error persists, please contact the developer.' });
      return true;
    }
    if (data.filtered_empty) {
      sendResponse({ error: `No messages found within the selected period. Try a wider date range or scroll up to load older messages.` });
      return true;
    }

    console.log('[Content] SCRAPE_CHAT: found', data.messages.length, 'messages');
    sendResponse({ data });
    return true;
  });
})();
