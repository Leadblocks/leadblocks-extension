// Open side panel when the action button is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// Forward the active tab URL to the side panel when the user switches tabs
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url) {
      chrome.runtime.sendMessage({ type: 'TAB_URL_CHANGED', url: tab.url }).catch(() => {});
    }
  } catch (_) {}
});

// Forward URL changes within a tab (navigation, SPA route changes reported by content script)
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url) {
    chrome.runtime.sendMessage({ type: 'TAB_URL_CHANGED', url: changeInfo.url }).catch(() => {});
  }
});
