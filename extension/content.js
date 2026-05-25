(async function () {
  if (document.documentElement.dataset.domHintInjected) return;
  document.documentElement.dataset.domHintInjected = "true";

  const defaults = {
    prefix: "dom-hint:",
    hotkeys: { ctrl: true, alt: true, shift: false, meta: false },
    activation: { toggleMode: false, showIndicator: true, autoStart: false },
    mutationTypes: { childList: true, attributes: false, characterData: false },
    output: { grouped: true, maxHtmlLength: 200, selectorFilter: "", recordLog: false,
              ignoreList: "", debounceMs: 0 },
    scope: { head: false, shadowRoots: false, iframes: false },
  };
  let { prefix, hotkeys, activation, mutationTypes, output, scope } = await chrome.storage.sync.get(defaults);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.prefix) prefix = changes.prefix.newValue;
    if (changes.hotkeys) hotkeys = changes.hotkeys.newValue;
    if (changes.activation) activation = changes.activation.newValue;
    if (changes.mutationTypes) mutationTypes = changes.mutationTypes.newValue;
    if (changes.output) output = changes.output.newValue;
    if (changes.scope) scope = changes.scope.newValue;
  });

  let sessionLog = [];

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "getLog") {
      sendResponse({ log: sessionLog });
    } else if (msg.action === "clearLog") {
      sessionLog = [];
      sendResponse({ ok: true });
    } else if (msg.action === "getLogCount") {
      sendResponse({ count: sessionLog.length });
    } else if (msg.action === "toggleObserver") {
      if (watching) { stopWatching(); } else { startWatching(); }
      sendResponse({ watching });
    }
  });

  const SYNC_THRESHOLD_MS = 80;
  let watching = false;
  let startTime = null;
  let observer = null;
  let shadowObservers = [];
  let recentEvents = [];

  function elapsed() {
    return ((Date.now() - startTime) / 1000).toFixed(1);
  }

  function describeTarget(el) {
    if (!el || !el.tagName) return "";
    let desc = el.tagName.toLowerCase();
    if (el.id) desc += `#${el.id}`;
    if (el.className && typeof el.className === "string")
      desc += `.${el.className.trim().split(/\s+/).join(".")}`;
    return desc;
  }

  function inferTrigger(mutationTarget) {
    const now = performance.now();

    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const evt = recentEvents[i];
      const age = now - evt.time;
      if (age > SYNC_THRESHOLD_MS) break;
      const related =
        evt.target === mutationTarget ||
        evt.target.contains(mutationTarget) ||
        mutationTarget.contains(evt.target);
      if (related)
        return { type: evt.type, target: describeTarget(evt.target), age: Math.round(age) };
    }

    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const evt = recentEvents[i];
      const age = now - evt.time;
      if (age > SYNC_THRESHOLD_MS) break;
      return { type: evt.type, target: describeTarget(evt.target), age: Math.round(age) };
    }

    if (recentEvents.length > 0) {
      const last = recentEvents[recentEvents.length - 1];
      const age = now - last.time;
      return {
        type: "async",
        target: describeTarget(last.target),
        age: Math.round(age),
        lastEvent: last.type,
      };
    }

    return { type: "unknown", target: "", age: -1 };
  }

  function formatTrigger(trigger) {
    if (trigger.type === "unknown") return "unknown";
    if (trigger.type === "async")
      return `async ~${trigger.age}ms after ${trigger.lastEvent} on ${trigger.target}`;
    return `${trigger.type} on ${trigger.target} ~${trigger.age}ms ago`;
  }

  function truncateHtml(html) {
    const max = output.maxHtmlLength;
    if (max <= 0 || html.length <= max) return html;
    return html.slice(0, max) + "…";
  }

  function matchesFilter(el) {
    if (!output.selectorFilter) return true;
    try {
      return el.matches(output.selectorFilter) || el.closest(output.selectorFilter);
    } catch {
      return true;
    }
  }

  function isIgnored(el) {
    if (!output.ignoreList) return false;
    try {
      return el.matches(output.ignoreList);
    } catch {
      return false;
    }
  }

  let mutationCount = 0;
  let debounceBuffer = [];
  let debounceTimer = null;

  function flushDebounce() {
    if (debounceBuffer.length === 0) return;
    if (debounceBuffer.length === 1) {
      emitEntry(debounceBuffer[0]);
    } else {
      const summary = `${prefix} [+${elapsed()}s] [batch] ${debounceBuffer.length} mutations`;
      if (output.grouped) {
        console.groupCollapsed(summary);
        for (const item of debounceBuffer) {
          console.log(item.summary);
        }
        console.groupEnd();
      } else {
        console.log(summary);
      }
      if (output.recordLog) {
        for (const item of debounceBuffer) {
          if (item.entry) sessionLog.push(item.entry);
        }
      }
    }
    debounceBuffer = [];
    debounceTimer = null;
  }

  function emitEntry({ summary, detail, entry }) {
    if (output.grouped && detail) {
      console.groupCollapsed(summary);
      console.log(detail);
      console.groupEnd();
    } else {
      console.log(detail ? `${summary} ${truncateHtml(detail)}` : summary);
    }
    if (output.recordLog && entry) {
      sessionLog.push(entry);
    }
  }

  function logEntry(summary, detail, entry) {
    mutationCount++;
    try {
      chrome.runtime.sendMessage({ action: "updateBadge", count: mutationCount });
    } catch {}
    if (output.debounceMs > 0) {
      debounceBuffer.push({ summary, detail, entry });
      if (!debounceTimer) {
        debounceTimer = setTimeout(flushDebounce, output.debounceMs);
      }
    } else {
      emitEntry({ summary, detail, entry });
    }
  }

  const TRACKED_EVENTS = [
    "click", "mousedown", "mouseup",
    "mouseenter", "mouseleave", "mouseover", "mouseout",
    "keydown", "keyup",
    "focus", "blur",
    "input", "change",
    "touchstart", "touchend",
  ];

  function recordEvent(e) {
    recentEvents.push({ type: e.type, target: e.target, time: performance.now() });
    if (recentEvents.length > 50) recentEvents = recentEvents.slice(-30);
  }

  function startListeners() {
    TRACKED_EVENTS.forEach((evt) => document.addEventListener(evt, recordEvent, true));
  }

  function stopListeners() {
    TRACKED_EVENTS.forEach((evt) => document.removeEventListener(evt, recordEvent, true));
    recentEvents = [];
  }

  function getObserverOptions() {
    const opts = { subtree: true };
    if (mutationTypes.childList) opts.childList = true;
    if (mutationTypes.attributes) {
      opts.attributes = true;
      opts.attributeOldValue = true;
    }
    if (mutationTypes.characterData) {
      opts.characterData = true;
      opts.characterDataOldValue = true;
    }
    if (!opts.childList && !opts.attributes && !opts.characterData) {
      opts.childList = true;
    }
    return opts;
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (isIgnored(node)) continue;
          if (!matchesFilter(node) && !matchesFilter(mutation.target)) continue;
          const trigger = inferTrigger(mutation.target);
          const target = describeTarget(node);
          const summary = `${prefix} [+${elapsed()}s] [added] [${formatTrigger(trigger)}] ${target}`;
          logEntry(summary, node.outerHTML, {
            timestamp: Date.now(), elapsed: elapsed(), type: "added",
            trigger, target, html: node.outerHTML,
          });
          if (scope.shadowRoots) observeShadowRoots(node);
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (isIgnored(node)) continue;
          if (!matchesFilter(node) && !matchesFilter(mutation.target)) continue;
          const trigger = inferTrigger(mutation.target);
          const target = describeTarget(node);
          const summary = `${prefix} [+${elapsed()}s] [removed] [${formatTrigger(trigger)}] ${target}`;
          logEntry(summary, node.outerHTML, {
            timestamp: Date.now(), elapsed: elapsed(), type: "removed",
            trigger, target, html: node.outerHTML,
          });
        }
      } else if (mutation.type === "attributes") {
        const el = mutation.target;
        if (isIgnored(el)) continue;
        if (!matchesFilter(el)) continue;
        const trigger = inferTrigger(el);
        const attr = mutation.attributeName;
        const oldVal = mutation.oldValue;
        const newVal = el.getAttribute(attr);
        const target = describeTarget(el);
        const summary = `${prefix} [+${elapsed()}s] [attr] [${formatTrigger(trigger)}] ${target} ${attr}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`;
        logEntry(summary, null, {
          timestamp: Date.now(), elapsed: elapsed(), type: "attr",
          trigger, target, attribute: attr, oldValue: oldVal, newValue: newVal,
        });
      } else if (mutation.type === "characterData") {
        const parentEl = mutation.target.parentElement || mutation.target;
        if (isIgnored(parentEl)) continue;
        if (!matchesFilter(parentEl)) continue;
        const trigger = inferTrigger(parentEl);
        const oldVal = mutation.oldValue;
        const newVal = mutation.target.textContent;
        const target = describeTarget(mutation.target.parentElement);
        const summary = `${prefix} [+${elapsed()}s] [text] [${formatTrigger(trigger)}] ${target}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`;
        logEntry(summary, null, {
          timestamp: Date.now(), elapsed: elapsed(), type: "text",
          trigger, target, oldValue: oldVal, newValue: newVal,
        });
      }
    }
  }

  function observeShadowRoots(root) {
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll("*")] : [root];
    for (const el of elements) {
      if (el.shadowRoot && !el.shadowRoot.__domHintObserved) {
        el.shadowRoot.__domHintObserved = true;
        const shadowObs = new MutationObserver(handleMutations);
        shadowObs.observe(el.shadowRoot, getObserverOptions());
        shadowObservers.push(shadowObs);
        observeShadowRoots(el.shadowRoot);
      }
    }
  }

  function startObserver() {
    observer = new MutationObserver(handleMutations);
    const opts = getObserverOptions();
    observer.observe(document.body, opts);

    if (scope.head) {
      observer.observe(document.head, opts);
    }

    if (scope.shadowRoots) {
      observeShadowRoots(document.body);
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const obs of shadowObservers) {
      obs.disconnect();
    }
    shadowObservers = [];
  }

  let indicator = null;

  function showIndicator() {
    if (!activation.showIndicator) return;
    if (indicator) return;
    indicator = document.createElement("div");
    indicator.setAttribute("style",
      "position:fixed;top:6px;right:6px;z-index:2147483647;padding:4px 8px;" +
      "background:rgba(220,38,38,0.9);color:#fff;font:11px/1 system-ui,sans-serif;" +
      "border-radius:3px;pointer-events:none;user-select:none;"
    );
    indicator.textContent = "DOM Hints: recording";
    document.documentElement.appendChild(indicator);
  }

  function hideIndicator() {
    if (indicator) {
      indicator.remove();
      indicator = null;
    }
  }

  function startWatching() {
    if (watching) return;
    watching = true;
    startTime = Date.now();
    mutationCount = 0;
    recentEvents = [];
    startListeners();
    startObserver();
    showIndicator();
    console.log(`${prefix} started watching for Document mutations`);
  }

  function stopWatching() {
    if (!watching) return;
    if (debounceTimer) { clearTimeout(debounceTimer); flushDebounce(); }
    stopObserver();
    stopListeners();
    hideIndicator();
    watching = false;
    const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`${prefix} stopped listening (watched for ${seconds}s, ${mutationCount} mutations)`);
    startTime = null;
    try { chrome.runtime.sendMessage({ action: "clearBadge" }); } catch {}
  }

  function checkModifiers(e) {
    const anyRequired = hotkeys.ctrl || hotkeys.alt || hotkeys.shift || hotkeys.meta;
    if (!anyRequired) return false;
    if (hotkeys.ctrl && !e.ctrlKey) return false;
    if (hotkeys.alt && !e.altKey) return false;
    if (hotkeys.shift && !e.shiftKey) return false;
    if (hotkeys.meta && !e.metaKey) return false;
    return true;
  }

  function modifiersReleased(e) {
    if (hotkeys.ctrl && e.ctrlKey) return false;
    if (hotkeys.alt && e.altKey) return false;
    if (hotkeys.shift && e.shiftKey) return false;
    if (hotkeys.meta && e.metaKey) return false;
    return true;
  }

  document.addEventListener("click", (e) => {
    if (!checkModifiers(e)) return;
    if (activation.toggleMode) {
      if (watching) {
        stopWatching();
      } else {
        startWatching();
      }
    } else if (!watching) {
      startWatching();
    }
  });

  document.addEventListener("keyup", (e) => {
    if (!activation.toggleMode && watching && modifiersReleased(e)) {
      stopWatching();
    }
  });

  if (activation.autoStart) {
    startWatching();
  }
})();
