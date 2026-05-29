(async function () {
  if (document.documentElement.dataset.domHintInjected) return;
  document.documentElement.dataset.domHintInjected = "true";

  const defaults = {
    prefix: "dom-hint:",
    hotkeys: { ctrl: true, alt: true, shift: false, meta: false },
    activation: { toggleMode: false, showIndicator: true, autoStart: false },
    mutationTypes: { childList: true, attributes: false, characterData: false },
    triggers: { network: true, timers: false },
    output: { grouped: true, maxHtmlLength: 200, selectorFilter: "", recordLog: false,
              ignoreList: "", debounceMs: 0 },
    scope: { head: false, shadowRoots: false, iframes: false },
  };
  let { prefix, hotkeys, activation, mutationTypes, triggers, output, scope } = await chrome.storage.sync.get(defaults);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.prefix) prefix = changes.prefix.newValue;
    if (changes.hotkeys) hotkeys = changes.hotkeys.newValue;
    if (changes.activation) activation = changes.activation.newValue;
    if (changes.mutationTypes) mutationTypes = changes.mutationTypes.newValue;
    if (changes.triggers) triggers = changes.triggers.newValue;
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
  const NETWORK_THRESHOLD_MS = 500;
  const TIMER_THRESHOLD_MS = 200;
  let watching = false;
  let startTime = null;
  let observer = null;
  let shadowObservers = [];
  let recentEvents = [];
  let recentNetworkEvents = [];
  let recentTimerFires = [];

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

  // --- Network interception ---
  const originalFetch = typeof window.fetch === "function" ? window.fetch : null;
  const originalXhrOpen = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.open : null;
  const originalXhrSend = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.send : null;
  let networkPatched = false;

  function patchNetwork() {
    if (networkPatched) return;
    networkPatched = true;

    if (!originalFetch) return;

    window.fetch = function (input, init) {
      const method = (init && init.method) || "GET";
      const url = typeof input === "string" ? input : (input.url || String(input));
      const parentTrigger = getLastUserEvent();
      return originalFetch.apply(this, arguments).then((response) => {
        if (watching) {
          recentNetworkEvents.push({
            type: "fetch", method: method.toUpperCase(), url: shortenUrl(url),
            status: response.status, time: performance.now(), parentTrigger,
          });
          if (recentNetworkEvents.length > 30) recentNetworkEvents = recentNetworkEvents.slice(-20);
        }
        return response;
      });
    };

    if (!originalXhrOpen || !originalXhrSend) return;

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__domHintMethod = method.toUpperCase();
      this.__domHintUrl = shortenUrl(String(url));
      this.__domHintParent = getLastUserEvent();
      return originalXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      this.addEventListener("load", () => {
        if (watching) {
          recentNetworkEvents.push({
            type: "xhr", method: this.__domHintMethod, url: this.__domHintUrl,
            status: this.status, time: performance.now(),
            parentTrigger: this.__domHintParent,
          });
          if (recentNetworkEvents.length > 30) recentNetworkEvents = recentNetworkEvents.slice(-20);
        }
      });
      return originalXhrSend.apply(this, arguments);
    };
  }

  function unpatchNetwork() {
    if (!networkPatched) return;
    networkPatched = false;
    if (originalFetch) window.fetch = originalFetch;
    if (originalXhrOpen) XMLHttpRequest.prototype.open = originalXhrOpen;
    if (originalXhrSend) XMLHttpRequest.prototype.send = originalXhrSend;
  }

  // --- Timer interception ---
  const originalSetTimeout = window.setTimeout;
  const originalSetInterval = window.setInterval;
  const originalClearTimeout = window.clearTimeout;
  const originalClearInterval = window.clearInterval;
  let timersPatched = false;
  const timerRegistry = new Map();

  function patchTimers() {
    if (timersPatched) return;
    timersPatched = true;

    window.setTimeout = function (fn, delay, ...args) {
      const parentTrigger = getLastUserEvent();
      const scheduledAt = performance.now();
      const id = originalSetTimeout.call(window, function () {
        timerRegistry.delete(id);
        if (watching) {
          recentTimerFires.push({
            type: "timeout", delay: delay || 0, scheduledAt, time: performance.now(),
            parentTrigger,
          });
          if (recentTimerFires.length > 30) recentTimerFires = recentTimerFires.slice(-20);
        }
        if (typeof fn === "function") fn.apply(this, args);
        else eval(fn);
      }, delay, ...args);
      timerRegistry.set(id, { type: "timeout", delay, parentTrigger, scheduledAt });
      return id;
    };

    window.setInterval = function (fn, delay, ...args) {
      const parentTrigger = getLastUserEvent();
      const scheduledAt = performance.now();
      const id = originalSetInterval.call(window, function () {
        if (watching) {
          recentTimerFires.push({
            type: "interval", delay: delay || 0, scheduledAt, time: performance.now(),
            parentTrigger,
          });
          if (recentTimerFires.length > 30) recentTimerFires = recentTimerFires.slice(-20);
        }
        if (typeof fn === "function") fn.apply(this, args);
        else eval(fn);
      }, delay, ...args);
      timerRegistry.set(id, { type: "interval", delay, parentTrigger, scheduledAt });
      return id;
    };

    window.clearTimeout = function (id) {
      timerRegistry.delete(id);
      return originalClearTimeout.call(window, id);
    };

    window.clearInterval = function (id) {
      timerRegistry.delete(id);
      return originalClearInterval.call(window, id);
    };
  }

  function unpatchTimers() {
    if (!timersPatched) return;
    timersPatched = false;
    window.setTimeout = originalSetTimeout;
    window.setInterval = originalSetInterval;
    window.clearTimeout = originalClearTimeout;
    window.clearInterval = originalClearInterval;
    timerRegistry.clear();
  }

  // --- Causal chain helpers ---
  function shortenUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname + (u.search ? u.search.slice(0, 30) : "");
    } catch {
      return url.slice(0, 60);
    }
  }

  function getLastUserEvent() {
    if (recentEvents.length === 0) return null;
    const last = recentEvents[recentEvents.length - 1];
    return { type: last.type, target: describeTarget(last.target), time: last.time };
  }

  function inferTrigger(mutationTarget) {
    const now = performance.now();

    // 1. Check synchronous user events
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

    // 2. Check recent timer fires
    for (let i = recentTimerFires.length - 1; i >= 0; i--) {
      const timer = recentTimerFires[i];
      const age = now - timer.time;
      if (age > TIMER_THRESHOLD_MS) break;
      return buildChain({
        type: timer.type, age: Math.round(age),
        delay: timer.delay, parentTrigger: timer.parentTrigger,
      });
    }

    // 3. Check recent network completions
    for (let i = recentNetworkEvents.length - 1; i >= 0; i--) {
      const net = recentNetworkEvents[i];
      const age = now - net.time;
      if (age > NETWORK_THRESHOLD_MS) break;
      return buildChain({
        type: net.type, method: net.method, url: net.url,
        status: net.status, age: Math.round(age),
        parentTrigger: net.parentTrigger,
      });
    }

    // 4. Fallback to async/unknown
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

  function buildChain(trigger) {
    if (trigger.parentTrigger) {
      trigger.chain = [trigger.parentTrigger];
    }
    return trigger;
  }

  function formatTrigger(trigger) {
    if (trigger.type === "unknown") return "unknown";
    if (trigger.type === "async")
      return `async ~${trigger.age}ms after ${trigger.lastEvent} on ${trigger.target}`;

    let desc;
    if (trigger.type === "fetch" || trigger.type === "xhr") {
      desc = `${trigger.type} ${trigger.method} ${trigger.url} (${trigger.status}) ~${trigger.age}ms ago`;
    } else if (trigger.type === "timeout" || trigger.type === "interval") {
      desc = `${trigger.type} (${trigger.delay}ms) ~${trigger.age}ms ago`;
    } else {
      desc = `${trigger.type} on ${trigger.target} ~${trigger.age}ms ago`;
    }

    if (trigger.chain && trigger.chain.length > 0) {
      const origin = trigger.chain[0];
      desc = `${origin.type} on ${origin.target} → ${desc}`;
    }

    return desc;
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

  function isInHead(node) {
    const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    return !!(el && document.head && document.head.contains(el));
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      if (!scope.head && isInHead(mutation.target)) continue;
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE && mutationTypes.characterData) {
            if (!matchesFilter(mutation.target)) continue;
            const trigger = inferTrigger(mutation.target);
            const target = describeTarget(mutation.target);
            const summary = `${prefix} [+${elapsed()}s] [text+] [${formatTrigger(trigger)}] ${target}: ${JSON.stringify(node.textContent)}`;
            logEntry(summary, null, {
              timestamp: Date.now(), elapsed: elapsed(), type: "text+",
              trigger, target, newValue: node.textContent,
            });
            continue;
          }
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
          if (node.nodeType === Node.TEXT_NODE && mutationTypes.characterData) {
            if (!matchesFilter(mutation.target)) continue;
            const trigger = inferTrigger(mutation.target);
            const target = describeTarget(mutation.target);
            const summary = `${prefix} [+${elapsed()}s] [text-] [${formatTrigger(trigger)}] ${target}: ${JSON.stringify(node.textContent)}`;
            logEntry(summary, null, {
              timestamp: Date.now(), elapsed: elapsed(), type: "text-",
              trigger, target, oldValue: node.textContent,
            });
            continue;
          }
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

  function observeShadowRoot(root) {
    if (!root || root.__domHintObserved) return;
    root.__domHintObserved = true;
    const shadowObs = new MutationObserver(handleMutations);
    shadowObs.observe(root, getObserverOptions());
    shadowObservers.push(shadowObs);
    observeShadowRoots(root);
  }

  function observeShadowRoots(root) {
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll("*")] : [root];
    for (const el of elements) {
      if (el.shadowRoot) observeShadowRoot(el.shadowRoot);
    }
  }

  // --- Shadow DOM patching ---
  // Captures shadow roots that other extensions (or page scripts) attach to
  // already-present elements after we start watching. attachShadow's return
  // value is the actual root even for { mode: "closed" } — patching here is
  // the only reliable way to observe closed shadow roots.
  const originalAttachShadow =
    typeof Element !== "undefined" ? Element.prototype.attachShadow : null;
  let shadowPatched = false;

  function patchAttachShadow() {
    if (shadowPatched || !originalAttachShadow) return;
    shadowPatched = true;
    Element.prototype.attachShadow = function (init) {
      const root = originalAttachShadow.call(this, init);
      if (watching && scope.shadowRoots) observeShadowRoot(root);
      return root;
    };
  }

  function unpatchAttachShadow() {
    if (!shadowPatched || !originalAttachShadow) return;
    shadowPatched = false;
    Element.prototype.attachShadow = originalAttachShadow;
  }

  function startObserver() {
    observer = new MutationObserver(handleMutations);
    const opts = getObserverOptions();
    // Root at documentElement so we see siblings of <body> (overlays/banners
    // that other extensions inject directly under <html>) and <head>
    // mutations. The handler filters head mutations when scope.head is off.
    observer.observe(document.documentElement, opts);

    if (scope.shadowRoots) {
      observeShadowRoots(document.documentElement);
      patchAttachShadow();
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
    unpatchAttachShadow();
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
    recentNetworkEvents = [];
    recentTimerFires = [];
    startListeners();
    if (triggers.network) patchNetwork();
    if (triggers.timers) patchTimers();
    // Show the indicator before starting the observer so its own insertion
    // isn't reported as a mutation (it lives under <html>, which is now
    // inside the observer's root).
    showIndicator();
    startObserver();
    console.log(`${prefix} started watching for Document mutations`);
  }

  function stopWatching() {
    if (!watching) return;
    if (debounceTimer) { clearTimeout(debounceTimer); flushDebounce(); }
    stopObserver();
    stopListeners();
    unpatchNetwork();
    unpatchTimers();
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
