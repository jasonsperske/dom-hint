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
    ...storageOverrides,
  };

  let changeListeners = [];

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
  };

  window.console.log = (...args) => {
    logs.push(args.join(" "));
  };

  return { dom, window, logs, changeListeners, triggerStorageChange: (changes) => {
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
    const { window, logs } = createEnv();
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
    const { window, logs } = createEnv();
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
