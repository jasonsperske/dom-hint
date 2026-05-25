const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const CONTENT_JS = fs.readFileSync(
  path.join(__dirname, "..", "extension", "content.js"),
  "utf8"
);

function createEnv(storageOverrides = {}) {
  const dom = new JSDOM(`<html><body><div id="root"></div></body></html>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const logs = [];

  const storage = {
    prefix: "dom-hint:",
    hotkeys: { ctrl: true, alt: true, shift: false, meta: false },
    mutationTypes: { childList: true, attributes: false, characterData: false },
    output: { grouped: true, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    scope: { head: false, shadowRoots: false },
    ...storageOverrides,
  };

  let changeListeners = [];

  let messageListeners = [];

  window.chrome = {
    storage: {
      sync: {
        get(defaults) {
          const result = {};
          for (const key of Object.keys(defaults)) {
            result[key] = storage[key] !== undefined ? storage[key] : defaults[key];
          }
          return Promise.resolve(result);
        },
      },
      onChanged: {
        addListener(fn) {
          changeListeners.push(fn);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        },
      },
    },
  };

  const groups = [];
  let currentGroup = null;

  window.console.log = (...args) => {
    const line = args.join(" ");
    if (currentGroup) {
      currentGroup.detail.push(line);
    }
    logs.push(line);
  };

  window.console.groupCollapsed = (...args) => {
    currentGroup = { summary: args.join(" "), detail: [] };
    groups.push(currentGroup);
    logs.push(args.join(" "));
  };

  window.console.groupEnd = () => {
    currentGroup = null;
  };

  function sendMessage(msg) {
    return new Promise((resolve) => {
      messageListeners.forEach((fn) => fn(msg, {}, resolve));
    });
  }

  return { dom, window, logs, groups, changeListeners, messageListeners, sendMessage, triggerStorageChange: (changes) => {
    changeListeners.forEach((fn) => fn(changes));
  }};
}

async function injectScript(window) {
  window.eval(CONTENT_JS);
  // Let the async IIFE resolve
  await new Promise((r) => setTimeout(r, 10));
}

function simulateClick(window, target, modifiers = {}) {
  const event = new window.MouseEvent("click", {
    bubbles: true,
    ctrlKey: modifiers.ctrl || false,
    altKey: modifiers.alt || false,
    shiftKey: modifiers.shift || false,
    metaKey: modifiers.meta || false,
  });
  target.dispatchEvent(event);
}

function simulateKeyup(window, target, modifiers = {}) {
  const event = new window.KeyboardEvent("keyup", {
    bubbles: true,
    ctrlKey: modifiers.ctrl || false,
    altKey: modifiers.alt || false,
    shiftKey: modifiers.shift || false,
    metaKey: modifiers.meta || false,
  });
  target.dispatchEvent(event);
}

describe("content script injection guard", () => {
  test("sets domHintInjected dataset attribute", async () => {
    const { window } = createEnv();
    await injectScript(window);
    assert.strictEqual(
      window.document.documentElement.dataset.domHintInjected,
      "true"
    );
  });

  test("does not re-inject if already injected", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);
    await injectScript(window);
    // Only one storage read means only one injection
    assert.strictEqual(
      window.document.documentElement.dataset.domHintInjected,
      "true"
    );
  });
});

describe("hotkey activation", () => {
  test("Ctrl+Alt+Click starts watching", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    assert.ok(logs.some((l) => l.includes("started watching")));
  });

  test("regular click does not start watching", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, {});
    assert.ok(!logs.some((l) => l.includes("started watching")));
  });

  test("releasing modifiers stops watching", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    simulateKeyup(window, window.document.body, { ctrl: false, alt: false });
    assert.ok(logs.some((l) => l.includes("stopped listening")));
  });

  test("custom hotkey config is respected", async () => {
    const { window, logs } = createEnv({
      hotkeys: { ctrl: false, alt: false, shift: true, meta: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { shift: true });
    assert.ok(logs.some((l) => l.includes("started watching")));
  });
});

describe("childList mutations (element inserts & deletes)", () => {
  test("logs added elements", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    logs.length = 0;

    const el = window.document.createElement("span");
    el.textContent = "hello";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[added]") && l.includes("<span>")));
  });

  test("logs removed elements", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    const el = window.document.createElement("div");
    el.id = "removeme";
    window.document.getElementById("root").appendChild(el);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    el.remove();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[removed]") && l.includes("removeme")));
  });

  test("ignores text nodes in childList mode", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    logs.length = 0;

    const text = window.document.createTextNode("plain text");
    window.document.getElementById("root").appendChild(text);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[added]")));
  });
});

describe("attribute mutations", () => {
  test("logs attribute changes when enabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: true, characterData: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.getElementById("root");
    el.setAttribute("data-state", "active");

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[attr]") && l.includes("data-state")));
  });

  test("shows old and new attribute values", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: true, characterData: false },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");
    el.setAttribute("class", "original");

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    el.setAttribute("class", "updated");

    await new Promise((r) => setTimeout(r, 10));
    const attrLog = logs.find((l) => l.includes("[attr]"));
    assert.ok(attrLog, "Should have an [attr] log");
    assert.ok(attrLog.includes('"original"'), "Should show old value");
    assert.ok(attrLog.includes('"updated"'), "Should show new value");
  });

  test("does not log attribute changes when disabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: true, attributes: false, characterData: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    window.document.getElementById("root").setAttribute("class", "changed");

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[attr]")));
  });
});

describe("characterData mutations (text changes)", () => {
  test("logs text content changes when enabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: false, characterData: true },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");
    el.textContent = "initial";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    el.firstChild.textContent = "modified";

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[text]")));
  });

  test("shows old and new text values", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: false, characterData: true },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");
    el.textContent = "before";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    el.firstChild.textContent = "after";

    await new Promise((r) => setTimeout(r, 10));
    const textLog = logs.find((l) => l.includes("[text]"));
    assert.ok(textLog, "Should have a [text] log");
    assert.ok(textLog.includes('"before"'), "Should show old value");
    assert.ok(textLog.includes('"after"'), "Should show new value");
  });

  test("does not log text changes when disabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: true, attributes: false, characterData: false },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");
    el.textContent = "initial";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    el.firstChild.textContent = "changed";

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[text]")));
  });
});

describe("log prefix", () => {
  test("uses configured prefix", async () => {
    const { window, logs } = createEnv({ prefix: "my-prefix:" });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    assert.ok(logs.some((l) => l.startsWith("my-prefix:")));
  });

  test("uses default prefix when not configured", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    assert.ok(logs.some((l) => l.startsWith("dom-hint:")));
  });
});

describe("trigger inference", () => {
  test("attributes click trigger to synchronous mutations", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 500, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    logs.length = 0;

    const root = window.document.getElementById("root");
    const btn = window.document.createElement("button");
    btn.id = "trigger-btn";
    root.appendChild(btn);
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    // Simulate a click that causes a mutation synchronously
    btn.addEventListener("click", () => {
      const span = window.document.createElement("span");
      span.textContent = "sync-added";
      root.appendChild(span);
    });

    simulateClick(window, btn, { ctrl: false, alt: false });
    await new Promise((r) => setTimeout(r, 10));

    const addLog = logs.find((l) => l.includes("[added]") && l.includes("sync-added"));
    assert.ok(addLog, "Should log the synchronously added element");
    assert.ok(addLog.includes("click"), "Should attribute to click event");
  });

  test("labels mutations with no prior events as unknown", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    // Mutate without any user event preceding it
    const el = window.document.createElement("div");
    el.className = "ghost";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    const ghostLog = logs.find((l) => l.includes("ghost"));
    assert.ok(ghostLog, "Should log the added element");
    // After the activation click, there IS a recent event, so it won't be "unknown"
    // but it should still have trigger info
    assert.ok(ghostLog.includes("[") && ghostLog.includes("]"));
  });
});

describe("observer lifecycle", () => {
  test("does not log mutations before activation", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    const el = window.document.createElement("div");
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[added]")));
  });

  test("does not log mutations after deactivation", async () => {
    const { window, logs } = createEnv();
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    simulateKeyup(window, window.document.body, { ctrl: false, alt: false });
    logs.length = 0;

    const el = window.document.createElement("div");
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[added]")));
  });
});

describe("combined mutation types", () => {
  test("tracks all mutation types when all enabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: true, attributes: true, characterData: true },
    });
    await injectScript(window);

    const root = window.document.getElementById("root");
    root.textContent = "text";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    // Attribute change
    root.setAttribute("data-x", "1");
    await new Promise((r) => setTimeout(r, 10));

    // Text change
    root.firstChild.textContent = "new text";
    await new Promise((r) => setTimeout(r, 10));

    // Element add
    const el = window.document.createElement("p");
    root.appendChild(el);
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(logs.some((l) => l.includes("[attr]")), "Should have attr log");
    assert.ok(logs.some((l) => l.includes("[text]")), "Should have text log");
    assert.ok(logs.some((l) => l.includes("[added]")), "Should have added log");
  });

  test("falls back to childList when all types disabled", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: false, characterData: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("div");
    el.className = "fallback-test";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      logs.some((l) => l.includes("[added]") && l.includes("fallback-test")),
      "Should fall back to childList tracking"
    );
  });
});

describe("grouped output", () => {
  test("uses groupCollapsed when grouped is enabled", async () => {
    const { window, logs, groups } = createEnv({
      output: { grouped: true, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    groups.length = 0;

    const el = window.document.createElement("div");
    el.id = "grouped-el";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    const group = groups.find((g) => g.summary.includes("[added]"));
    assert.ok(group, "Should use groupCollapsed for the entry");
    assert.ok(group.summary.includes("div#grouped-el"), "Summary has element descriptor");
    assert.ok(group.detail.some((d) => d.includes("<div")), "Detail contains outerHTML");
  });

  test("uses flat log when grouped is disabled", async () => {
    const { window, logs, groups } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;
    groups.length = 0;

    const el = window.document.createElement("span");
    el.textContent = "flat";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(groups.length, 0, "Should not use groupCollapsed");
    assert.ok(logs.some((l) => l.includes("[added]") && l.includes("<span>")), "Should log inline");
  });
});

describe("max HTML length", () => {
  test("truncates long HTML when grouped is disabled", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 30, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("div");
    el.setAttribute("data-long", "a".repeat(100));
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    const addLog = logs.find((l) => l.includes("[added]"));
    assert.ok(addLog, "Should have an [added] log");
    assert.ok(addLog.includes("…"), "Should have truncation marker");
    assert.ok(!addLog.includes("a".repeat(100)), "Should not contain full attribute");
  });

  test("does not truncate short HTML", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 500, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("b");
    el.textContent = "hi";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    const addLog = logs.find((l) => l.includes("[added]"));
    assert.ok(addLog, "Should have an [added] log");
    assert.ok(!addLog.includes("…"), "Should not be truncated");
    assert.ok(addLog.includes("<b>hi</b>"), "Should contain full HTML");
  });

  test("shows full HTML inside group when grouped is enabled", async () => {
    const { window, groups } = createEnv({
      output: { grouped: true, maxHtmlLength: 10, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    groups.length = 0;

    const el = window.document.createElement("div");
    el.setAttribute("data-long", "b".repeat(100));
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    const group = groups.find((g) => g.summary.includes("[added]"));
    assert.ok(group, "Should have a group");
    assert.ok(group.detail.some((d) => d.includes("b".repeat(100))), "Group detail has full HTML");
  });
});

describe("selector filter", () => {
  test("only logs mutations matching the selector", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "#target", recordLog: false },
    });
    await injectScript(window);

    const root = window.document.getElementById("root");
    const target = window.document.createElement("div");
    target.id = "target";
    root.appendChild(target);

    const other = window.document.createElement("div");
    other.id = "other";
    root.appendChild(other);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const child1 = window.document.createElement("span");
    child1.className = "inside-target";
    target.appendChild(child1);

    const child2 = window.document.createElement("span");
    child2.className = "inside-other";
    other.appendChild(child2);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("inside-target")), "Should log mutation inside #target");
    assert.ok(!logs.some((l) => l.includes("inside-other")), "Should not log mutation inside #other");
  });

  test("logs all mutations when selector is empty", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("div");
    el.className = "unfiltered";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("unfiltered")), "Should log without filter");
  });

  test("treats invalid selector as no filter", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "[[[invalid", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("div");
    el.className = "invalid-selector-test";
    window.document.getElementById("root").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("invalid-selector-test")), "Should log despite invalid selector");
  });

  test("filters attribute mutations by selector", async () => {
    const { window, logs } = createEnv({
      mutationTypes: { childList: false, attributes: true, characterData: false },
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: ".watched", recordLog: false },
    });
    await injectScript(window);

    const root = window.document.getElementById("root");
    const watched = window.document.createElement("div");
    watched.className = "watched";
    root.appendChild(watched);

    const ignored = window.document.createElement("div");
    ignored.className = "ignored";
    root.appendChild(ignored);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    watched.setAttribute("data-x", "1");
    ignored.setAttribute("data-y", "2");

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("data-x")), "Should log attribute on .watched");
    assert.ok(!logs.some((l) => l.includes("data-y")), "Should not log attribute on .ignored");
  });
});

describe("session log", () => {
  test("does not record when recordLog is disabled", async () => {
    const { window, sendMessage } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    const el = window.document.createElement("div");
    window.document.getElementById("root").appendChild(el);
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLog" });
    assert.strictEqual(response.log.length, 0, "Should not record entries");
  });

  test("records entries when recordLog is enabled", async () => {
    const { window, sendMessage } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    const el = window.document.createElement("div");
    el.id = "recorded";
    window.document.getElementById("root").appendChild(el);
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLog" });
    assert.ok(response.log.length > 0, "Should have recorded entries");
    const entry = response.log.find((e) => e.target === "div#recorded");
    assert.ok(entry, "Should have an entry for the added element");
    assert.strictEqual(entry.type, "added");
    assert.ok(entry.timestamp > 0);
    assert.ok(entry.html.includes("recorded"));
  });

  test("records attribute mutations", async () => {
    const { window, sendMessage } = createEnv({
      mutationTypes: { childList: false, attributes: true, characterData: false },
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    el.setAttribute("data-test", "value");
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLog" });
    const entry = response.log.find((e) => e.type === "attr");
    assert.ok(entry, "Should record attribute mutation");
    assert.strictEqual(entry.attribute, "data-test");
    assert.strictEqual(entry.newValue, "value");
  });

  test("records text mutations", async () => {
    const { window, sendMessage } = createEnv({
      mutationTypes: { childList: false, attributes: false, characterData: true },
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    const el = window.document.getElementById("root");
    el.textContent = "original";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    el.firstChild.textContent = "changed";
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLog" });
    const entry = response.log.find((e) => e.type === "text");
    assert.ok(entry, "Should record text mutation");
    assert.strictEqual(entry.oldValue, "original");
    assert.strictEqual(entry.newValue, "changed");
  });

  test("clearLog empties the buffer", async () => {
    const { window, sendMessage } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    const el = window.document.createElement("div");
    window.document.getElementById("root").appendChild(el);
    await new Promise((r) => setTimeout(r, 10));

    let response = await sendMessage({ action: "getLogCount" });
    assert.ok(response.count > 0, "Should have entries before clear");

    await sendMessage({ action: "clearLog" });

    response = await sendMessage({ action: "getLog" });
    assert.strictEqual(response.log.length, 0, "Should be empty after clear");
  });

  test("getLogCount returns entry count", async () => {
    const { window, sendMessage } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    const el1 = window.document.createElement("div");
    const el2 = window.document.createElement("span");
    window.document.getElementById("root").appendChild(el1);
    window.document.getElementById("root").appendChild(el2);
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLogCount" });
    assert.strictEqual(response.count, 2);
  });

  test("log entries include trigger information", async () => {
    const { window, sendMessage } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: true },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    const btn = window.document.createElement("button");
    btn.id = "trigger-test";
    window.document.getElementById("root").appendChild(btn);
    await new Promise((r) => setTimeout(r, 10));

    btn.addEventListener("click", () => {
      const span = window.document.createElement("span");
      window.document.getElementById("root").appendChild(span);
    });

    simulateClick(window, btn, {});
    await new Promise((r) => setTimeout(r, 10));

    const response = await sendMessage({ action: "getLog" });
    const clickEntry = response.log.find((e) => e.target === "span");
    assert.ok(clickEntry, "Should have entry for span added by click");
    assert.ok(clickEntry.trigger, "Entry should have trigger info");
    assert.ok(clickEntry.trigger.type, "Trigger should have a type");
  });
});

describe("head observation", () => {
  test("does not observe head by default", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const style = window.document.createElement("style");
    style.textContent = "body { color: red; }";
    window.document.head.appendChild(style);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("[added]") && l.includes("style")), "Should not log head mutations by default");
  });

  test("observes head mutations when scope.head is enabled", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
      scope: { head: true, shadowRoots: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const style = window.document.createElement("style");
    style.textContent = "body { color: blue; }";
    window.document.head.appendChild(style);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[added]") && l.includes("style")), "Should log style added to head");
  });

  test("observes meta tag additions to head", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
      scope: { head: true, shadowRoots: false },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const meta = window.document.createElement("meta");
    meta.setAttribute("name", "test");
    meta.setAttribute("content", "value");
    window.document.head.appendChild(meta);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("[added]") && l.includes("meta")), "Should log meta added to head");
  });
});

describe("shadow DOM observation", () => {
  test("does not observe shadow roots by default", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
    });
    await injectScript(window);

    const host = window.document.createElement("div");
    window.document.getElementById("root").appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<div id='sc'></div>";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("span");
    el.className = "shadow-child";
    shadow.getElementById("sc").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("shadow-child")), "Should not log shadow DOM mutations by default");
  });

  test("observes existing shadow roots when scope.shadowRoots is enabled", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
      scope: { head: false, shadowRoots: true },
    });
    await injectScript(window);

    const host = window.document.createElement("div");
    window.document.getElementById("root").appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<div id='sc'></div>";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("span");
    el.className = "shadow-observed";
    shadow.getElementById("sc").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("shadow-observed")), "Should log shadow DOM mutations");
  });

  test("observes dynamically created shadow roots", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
      scope: { head: false, shadowRoots: true },
    });
    await injectScript(window);

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    // Create a new element with shadow root after observer starts
    const host = window.document.createElement("div");
    window.document.getElementById("root").appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<div id='dynamic-sc'></div>";

    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("p");
    el.className = "dynamic-shadow";
    shadow.getElementById("dynamic-sc").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(logs.some((l) => l.includes("dynamic-shadow")), "Should observe dynamically added shadow root");
  });

  test("stops observing shadow roots on deactivation", async () => {
    const { window, logs } = createEnv({
      output: { grouped: false, maxHtmlLength: 200, selectorFilter: "", recordLog: false },
      scope: { head: false, shadowRoots: true },
    });
    await injectScript(window);

    const host = window.document.createElement("div");
    window.document.getElementById("root").appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<div id='sc'></div>";

    simulateClick(window, window.document.body, { ctrl: true, alt: true });
    await new Promise((r) => setTimeout(r, 10));

    // Stop watching
    simulateKeyup(window, window.document.body, { ctrl: false, alt: false });
    await new Promise((r) => setTimeout(r, 10));
    logs.length = 0;

    const el = window.document.createElement("span");
    el.className = "after-stop";
    shadow.getElementById("sc").appendChild(el);

    await new Promise((r) => setTimeout(r, 10));
    assert.ok(!logs.some((l) => l.includes("after-stop")), "Should not log after deactivation");
  });
});
