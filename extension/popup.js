const $ = (s) => document.querySelector(s);
const injectBtn = $("#inject-btn");
const toggleBtn = $("#dropdown-toggle");
const menu = $("#dropdown-menu");
const statusEl = $("#status");
const prefixInput = $("#prefix");

let currentTab = null;
let currentDomain = "";

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  try {
    currentDomain = new URL(tab.url).hostname;
  } catch {
    currentDomain = "";
  }

  document.querySelectorAll(".domain-label").forEach((el) => {
    el.textContent = currentDomain || "this domain";
  });

  const { injected } = await chrome.runtime.sendMessage({
    action: "checkInjected",
    tabId: tab.id,
  });
  updateStatus(injected);

  const settings = await chrome.storage.sync.get({
    prefix: "dom-hint:",
    hotkeys: { ctrl: true, alt: true, shift: false, meta: false },
    mutationTypes: { childList: true, attributes: false, characterData: false },
    output: { grouped: true, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    scope: { head: false, shadowRoots: false },
  });
  prefixInput.value = settings.prefix;
  $("#mod-ctrl").checked = settings.hotkeys.ctrl;
  $("#mod-alt").checked = settings.hotkeys.alt;
  $("#mod-shift").checked = settings.hotkeys.shift;
  $("#mod-meta").checked = settings.hotkeys.meta;
  $("#mut-childlist").checked = settings.mutationTypes.childList;
  $("#mut-attributes").checked = settings.mutationTypes.attributes;
  $("#mut-characterdata").checked = settings.mutationTypes.characterData;
  $("#opt-grouped").checked = settings.output.grouped;
  $("#opt-maxhtml").value = settings.output.maxHtmlLength;
  $("#opt-selector").value = settings.output.selectorFilter;
  $("#opt-record").checked = settings.output.recordLog;
  $("#scope-head").checked = settings.scope.head;
  $("#scope-shadow").checked = settings.scope.shadowRoots;
  updateLogSection(settings.output.recordLog, injected);
}

function updateStatus(injected) {
  if (injected) {
    injectBtn.disabled = true;
    toggleBtn.disabled = true;
    statusEl.textContent = "Injected on this page";
    statusEl.className = "status injected";
  } else {
    injectBtn.disabled = false;
    toggleBtn.disabled = false;
    statusEl.textContent = "";
    statusEl.className = "status";
  }
}

injectBtn.addEventListener("click", async () => {
  if (!currentTab) return;
  await chrome.runtime.sendMessage({ action: "inject", tabId: currentTab.id });
  updateStatus(true);
});

toggleBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  menu.classList.toggle("hidden");
});

document.addEventListener("click", () => menu.classList.add("hidden"));

$("#auto-hour").addEventListener("click", async () => {
  await addAutoInject("1hour");
  menu.classList.add("hidden");
});

$("#auto-always").addEventListener("click", async () => {
  await addAutoInject("always");
  menu.classList.add("hidden");
});

async function addAutoInject(type) {
  if (!currentDomain) return;
  const { autoInjectDomains = [] } = await chrome.storage.sync.get("autoInjectDomains");

  const existing = autoInjectDomains.findIndex((r) => r.domain === currentDomain);
  const rule = {
    domain: currentDomain,
    type,
    expires: type === "1hour" ? Date.now() + 3600000 : null,
  };

  if (existing >= 0) autoInjectDomains[existing] = rule;
  else autoInjectDomains.push(rule);

  await chrome.storage.sync.set({ autoInjectDomains });

  if (currentTab) {
    await chrome.runtime.sendMessage({ action: "inject", tabId: currentTab.id });
    updateStatus(true);
  }
}

function saveSettings() {
  const recordLog = $("#opt-record").checked;
  chrome.storage.sync.set({
    prefix: prefixInput.value || "dom-hint:",
    hotkeys: {
      ctrl: $("#mod-ctrl").checked,
      alt: $("#mod-alt").checked,
      shift: $("#mod-shift").checked,
      meta: $("#mod-meta").checked,
    },
    mutationTypes: {
      childList: $("#mut-childlist").checked,
      attributes: $("#mut-attributes").checked,
      characterData: $("#mut-characterdata").checked,
    },
    output: {
      grouped: $("#opt-grouped").checked,
      maxHtmlLength: parseInt($("#opt-maxhtml").value, 10) || 200,
      selectorFilter: $("#opt-selector").value.trim(),
      recordLog,
    },
    scope: {
      head: $("#scope-head").checked,
      shadowRoots: $("#scope-shadow").checked,
    },
  });
  updateLogSection(recordLog, statusEl.classList.contains("injected"));
}

function updateLogSection(recording, injected) {
  const section = $("#log-section");
  if (recording && injected) {
    section.classList.remove("hidden");
    refreshLogCount();
  } else {
    section.classList.add("hidden");
  }
}

async function refreshLogCount() {
  if (!currentTab) return;
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: "getLogCount" });
    $("#log-count").textContent = `${response.count} ${response.count === 1 ? "entry" : "entries"}`;
  } catch {
    $("#log-count").textContent = "0 entries";
  }
}

$("#log-export").addEventListener("click", async () => {
  if (!currentTab) return;
  try {
    const response = await chrome.tabs.sendMessage(currentTab.id, { action: "getLog" });
    const blob = new Blob([JSON.stringify(response.log, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dom-hints-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // content script not available
  }
});

$("#log-clear").addEventListener("click", async () => {
  if (!currentTab) return;
  try {
    await chrome.tabs.sendMessage(currentTab.id, { action: "clearLog" });
    refreshLogCount();
  } catch {
    // content script not available
  }
});

prefixInput.addEventListener("input", saveSettings);
$("#opt-selector").addEventListener("input", saveSettings);
$("#opt-maxhtml").addEventListener("change", saveSettings);
document.querySelectorAll("fieldset input[type='checkbox']").forEach((cb) => {
  cb.addEventListener("change", saveSettings);
});

$("#options-link").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
