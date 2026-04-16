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
// HOVER DETECTION — extract prospect ID from LinkedIn "Message" button on hover
// Reads <a> href attributes only; no DOM mutation, no clicks, no scrolling.
// =============================================================================

console.log('[Content] Content script loaded on:', window.location.href);

(function initHoverDetection() {
  console.log('[Content] Initializing hover detection');

  // Match the LinkedIn messaging compose link that contains a profileUrn with fsd_profile
  const MSG_URN_RE = /[?&]profileUrn=urn(?:%3A|:)li(?:%3A|:)fsd_profile(?:%3A|:)([A-Za-z0-9_-]+)/i;
  let lastSentId = '';
  let debounceTimer = null;

  document.addEventListener('mouseover', (e) => {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;

    const href = anchor.href;
    if (!href.includes('messaging/compose') && !href.includes('messaging/thread')) return;

    const match = href.match(MSG_URN_RE);
    if (!match) return;

    const prospectId = decodeURIComponent(match[1]);

    // Extract name from aria-label, e.g. "Een bericht verzenden naar Marco de Nooijer, MBA"
    const ariaLabel = anchor.getAttribute('aria-label') || '';
    const nameMatch = ariaLabel.match(/(?:(?:send\s+a\s+message|message)\s+to|naar)\s+(.+?)(?:\s*,.*)?$/i);
    const prospectName = nameMatch ? nameMatch[1].trim() : '';

    console.log('[Hover] Prospect ID extracted:', prospectId, '| Name:', prospectName);

    if (prospectId === lastSentId) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!chrome.runtime?.id) return;
      try {
        lastSentId = prospectId;
        chrome.runtime.sendMessage({ type: 'HOVERED_PROSPECT_ID', prospectId, prospectName }).catch(() => {});
        console.log('[Hover] Sent HOVERED_PROSPECT_ID:', prospectId, '| Name:', prospectName);
      } catch (_) {
        // Context invalidated — silently ignore
      }
    }, 150);
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

  /** Scrape all contact info sections from the current page */
  function scrapeContactInfo() {
    const result = {};
    const allPs = document.querySelectorAll('p');

    for (const p of allPs) {
      const label = p.textContent.trim().toLowerCase();
      const field = LABEL_MAP[label];
      if (!field) continue;

      const valueP = p.nextElementSibling;
      if (!valueP || valueP.tagName !== 'P') continue;

      let value = '';
      if (field === 'email') {
        const mailto = valueP.querySelector('a[href^="mailto:"]');
        value = mailto ? mailto.textContent.trim() : valueP.textContent.trim();
      } else if (field === 'date_connected') {
        value = parseDateYMD(valueP.textContent.trim());
      } else if (field === 'birthday') {
        value = parseDateDMY(valueP.textContent.trim());
      } else {
        value = valueP.textContent.trim();
      }

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
