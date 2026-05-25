async function isInjected(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.dataset.domHintInjected === "true",
    });
    return result.result;
  } catch {
    return false;
  }
}

async function inject(tabId) {
  if (await isInjected(tabId)) return false;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return true;
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  let domain;
  try {
    domain = new URL(tab.url).hostname;
  } catch {
    return;
  }

  const { autoInjectDomains = [] } = await chrome.storage.sync.get("autoInjectDomains");
  const now = Date.now();
  const valid = autoInjectDomains.filter((r) => r.type === "always" || r.expires > now);

  if (valid.length !== autoInjectDomains.length) {
    await chrome.storage.sync.set({ autoInjectDomains: valid });
  }

  if (valid.some((r) => r.domain === domain)) {
    try {
      await inject(tabId);
    } catch {
      // can't inject (chrome:// pages, etc.)
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "inject") {
    inject(msg.tabId).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.action === "checkInjected") {
    isInjected(msg.tabId).then((injected) => sendResponse({ injected }));
    return true;
  }
});
