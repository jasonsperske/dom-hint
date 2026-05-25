(async function () {
  if (document.documentElement.dataset.domHintInjected) return;
  document.documentElement.dataset.domHintInjected = "true";

  const defaults = {
    prefix: "dom-hint:",
    hotkeys: { ctrl: true, alt: true, shift: false, meta: false },
    mutationTypes: { childList: true, attributes: false, characterData: false },
  };
  let { prefix, hotkeys, mutationTypes } = await chrome.storage.sync.get(defaults);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.prefix) prefix = changes.prefix.newValue;
    if (changes.hotkeys) hotkeys = changes.hotkeys.newValue;
    if (changes.mutationTypes) mutationTypes = changes.mutationTypes.newValue;
  });

  const SYNC_THRESHOLD_MS = 80;
  let watching = false;
  let startTime = null;
  let observer = null;
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

  function startObserver() {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const trigger = inferTrigger(mutation.target);
            console.log(`${prefix} [+${elapsed()}s] [added] [${formatTrigger(trigger)}] ${node.outerHTML}`);
          }
          for (const node of mutation.removedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            const trigger = inferTrigger(mutation.target);
            console.log(`${prefix} [+${elapsed()}s] [removed] [${formatTrigger(trigger)}] ${node.outerHTML}`);
          }
        } else if (mutation.type === "attributes") {
          const trigger = inferTrigger(mutation.target);
          const el = mutation.target;
          const attr = mutation.attributeName;
          const oldVal = mutation.oldValue;
          const newVal = el.getAttribute(attr);
          console.log(`${prefix} [+${elapsed()}s] [attr] [${formatTrigger(trigger)}] ${describeTarget(el)} ${attr}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
        } else if (mutation.type === "characterData") {
          const trigger = inferTrigger(mutation.target.parentElement || mutation.target);
          const oldVal = mutation.oldValue;
          const newVal = mutation.target.textContent;
          const parent = describeTarget(mutation.target.parentElement);
          console.log(`${prefix} [+${elapsed()}s] [text] [${formatTrigger(trigger)}] ${parent}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
        }
      }
    });
    const observerOptions = { subtree: true };
    if (mutationTypes.childList) observerOptions.childList = true;
    if (mutationTypes.attributes) {
      observerOptions.attributes = true;
      observerOptions.attributeOldValue = true;
    }
    if (mutationTypes.characterData) {
      observerOptions.characterData = true;
      observerOptions.characterDataOldValue = true;
    }
    if (!observerOptions.childList && !observerOptions.attributes && !observerOptions.characterData) {
      observerOptions.childList = true;
    }
    observer.observe(document.body, observerOptions);
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
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
    if (checkModifiers(e) && !watching) {
      watching = true;
      startTime = Date.now();
      recentEvents = [];
      startListeners();
      startObserver();
      console.log(`${prefix} started watching for Document mutations`);
    }
  });

  document.addEventListener("keyup", (e) => {
    if (watching && modifiersReleased(e)) {
      stopObserver();
      stopListeners();
      watching = false;
      const seconds = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`${prefix} stopped listening (watched for ${seconds}s)`);
      startTime = null;
    }
  });
})();
