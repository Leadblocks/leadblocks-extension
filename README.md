# Leadblocks Automation — Chrome Extension

A Chrome side panel extension that mirrors the Automation page from the Leadblocks customer portal. It lets users work through a queue of Connection Acceptance & Revoke tasks directly alongside LinkedIn — without any scraping.

## How it works

- All task data comes from **your own Leadblocks API** (no LinkedIn data is read).
- The extension opens the LinkedIn profile URL in a new tab (like clicking a bookmark).
- The content script reads only `window.location.href` to confirm you're on the right profile.
- You fill in contact details, then click Connect / Revoke / Disconnect to POST to the backend.

## Loading the extension (Chrome)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select this directory (`leadblocks-extension/`)

The extension icon will appear in your toolbar. Click it to open the side panel.

## Usage

1. Click the extension icon — the side panel opens.
2. Enter your **Backend URL** (e.g. `http://localhost:1337` or your production URL), email and password.
3. The extension logs in and loads your customers, profiles and tasks automatically.
4. Use **Queue mode** (default) to work through one task at a time:
   - Click **Open ↗** to open the LinkedIn profile in a new tab.
   - The side panel stays open alongside LinkedIn.
   - When you navigate to the correct profile, the status turns green: *Currently on this profile*.
   - Fill in contact details and click **Connect**, **Revoke**, or **Disconnect**.
   - The extension auto-advances to the next task after each action.
5. Use **List mode** to see all tasks at once (same as the dashboard page).

## File structure

```
leadblocks-extension/
├── manifest.json       Chrome extension manifest (MV3)
├── background.js       Service worker — opens side panel, forwards tab URL changes
├── content.js          Injected into linkedin.com — sends current URL to extension
├── sidepanel.html      Side panel HTML skeleton
├── sidepanel.css       Styles
├── sidepanel.js        All application logic
└── README.md
```

## Security notes

- The JWT token is stored in `chrome.storage.local` (not accessible by web pages).
- No LinkedIn DOM is read or scraped — only `window.location.href`.
- The `<all_urls>` host permission is needed so the extension can call your backend regardless of its URL.
