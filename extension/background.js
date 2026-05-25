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

async function inject(tabId, includeFrames = false) {
  if (await isInjected(tabId)) return false;
  const target = { tabId };
  if (includeFrames) target.allFrames = true;
  await chrome.scripting.executeScript({ target, files: ["content.js"] });
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
      const { scope = {} } = await chrome.storage.sync.get("scope");
      await inject(tabId, scope.iframes || false);
    } catch {
      // can't inject (chrome:// pages, etc.)
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "inject") {
    const includeFrames = msg.includeFrames || false;
    inject(msg.tabId, includeFrames).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.action === "checkInjected") {
    isInjected(msg.tabId).then((injected) => sendResponse({ injected }));
    return true;
  }
  if (msg.action === "updateBadge") {
    const tabId = sender.tab?.id;
    if (tabId) {
      if (msg.count > 0) {
        const text = msg.count > 999 ? "999+" : String(msg.count);
        chrome.action.setBadgeText({ text, tabId });
        chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId });
      } else if (msg.count === 0) {
        chrome.action.setBadgeText({ text: "", tabId });
      }
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "clearBadge") {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.action.setBadgeText({ text: "", tabId });
    }
    sendResponse({ ok: true });
    return false;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-observer") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    try {
      const injected = await isInjected(tab.id);
      if (!injected) {
        const { scope = {} } = await chrome.storage.sync.get("scope");
        await inject(tab.id, scope.iframes || false);
      }
      await chrome.tabs.sendMessage(tab.id, { action: "toggleObserver" });
    } catch {
      // tab not injectable
    }
  }
});
