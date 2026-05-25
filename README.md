# DOM Hints

A Chrome extension that observes DOM mutations on any web page and logs them to the console with trigger attribution — without modifying or interfering with the page's own code.

## How it works

The extension injects a content script that uses a `MutationObserver` to watch for element insertions and deletions. To infer what caused each mutation, it listens to user interaction events (click, hover, keydown, etc.) via capture-phase listeners on `document` and correlates their timing and targets with observed mutations.

- **Synchronous mutations** (within 80ms of a user event) are attributed to that event (e.g., `click on button#add-btn`)
- **Async mutations** (e.g., from `setTimeout`) are labeled `async` with the time elapsed since the last user interaction
- **Unknown mutations** with no prior interaction context are labeled `unknown`

```mermaid
flowchart TB
    subgraph Extension["Chrome Extension"]
        Popup["Popup UI\n(settings, inject button)"]
        BG["Background Service Worker"]
        Storage["chrome.storage.sync\n(prefix, hotkeys, auto-inject domains)"]
    end

    subgraph Page["Web Page"]
        PageJS["Page's own JS\n(event handlers, DOM manipulation)"]
        PageObs["Page's own MutationObserver\n(if any — unaffected)"]
        DOM["DOM"]
    end

    subgraph ContentScript["Injected Content Script"]
        EventTracker["Event Tracker\n(capture-phase listeners)\nclick, hover, keydown, focus, ..."]
        MO["MutationObserver\n(childList + subtree)"]
        Inference["Trigger Inference\n(&lt;80ms = sync, &gt;80ms = async)"]
        Logger["Console Logger\nprefix [+Xs] [added/removed] [trigger] html"]
    end

    Popup -- "inject / check status" --> BG
    Popup -- "save settings" --> Storage
    BG -- "chrome.scripting.executeScript" --> ContentScript
    BG -- "auto-inject on tab load" --> ContentScript
    Storage -- "read config" --> ContentScript

    DOM -- "user events bubble up" --> EventTracker
    EventTracker -- "recent event buffer" --> Inference
    PageJS -- "mutates" --> DOM
    DOM -- "mutations" --> MO
    DOM -- "mutations" --> PageObs
    MO -- "mutation records" --> Inference
    Inference -- "attributed log entry" --> Logger
```

### Activation flow

```mermaid
sequenceDiagram
    participant U as User
    participant P as Popup
    participant B as Background SW
    participant C as Content Script
    participant D as DOM

    U->>P: Click "Inject Code"
    P->>B: message: inject
    B->>C: chrome.scripting.executeScript
    C->>C: Read settings from storage
    C->>D: Attach capture-phase event listeners (dormant)
    Note over C: Waiting for hotkey activation

    U->>D: Ctrl+Alt+Click
    C->>C: Start MutationObserver + event tracker
    Note over C: Watching...

    D->>C: MutationObserver callback (element added)
    C->>C: Correlate with recent events (inferTrigger)
    C->>C: console.log with prefix, elapsed time, trigger, outerHTML

    U->>D: Release Ctrl+Alt
    C->>C: Stop observer, log duration
```

## Installation

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `extension/` folder

## Usage

- Click the extension icon to open the popup
- Click **Inject Code** to inject the observer into the current tab
- Use the dropdown (▾) to auto-inject on the current domain for 1 hour or always
- **Ctrl+Alt+Click** on the page to start watching mutations
- Release **Ctrl** and **Alt** to stop — the console logs the session duration

### Settings

| Setting | Default | Description |
|---|---|---|
| Log prefix | `dom-hint:` | Label prepended to every console log entry |
| Activation modifiers | Ctrl + Alt | Modifier keys required (+ click) to toggle the observer |
| Auto-inject domains | *(none)* | Managed from the popup dropdown or the options page |

## Test page

Open `index.html` to test with a page that has its own `page-observer:` MutationObserver, tooltips, list manipulation buttons, and a delayed mutation timer. Both observers log independently to the console.

## Project structure

```
extension/
├── manifest.json     # Manifest V3
├── background.js     # Service worker: auto-inject, message handling
├── content.js        # Injected observer with trigger inference
├── popup.html/js/css # Extension popup
└── options.html/js/css # Auto-inject domain management
index.html            # Test page with competing observer
```
