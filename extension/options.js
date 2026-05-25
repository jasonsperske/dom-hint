const list = document.getElementById("domain-list");
const emptyMsg = document.getElementById("empty-msg");
const table = document.getElementById("domain-table");

async function load() {
  const { autoInjectDomains = [] } = await chrome.storage.sync.get("autoInjectDomains");
  const now = Date.now();

  const valid = autoInjectDomains.filter((r) => r.type === "always" || r.expires > now);
  if (valid.length !== autoInjectDomains.length) {
    await chrome.storage.sync.set({ autoInjectDomains: valid });
  }

  list.innerHTML = "";

  if (valid.length === 0) {
    table.classList.add("hidden");
    emptyMsg.style.display = "";
    return;
  }

  table.classList.remove("hidden");
  emptyMsg.style.display = "none";

  valid.forEach((rule, i) => {
    const tr = document.createElement("tr");

    const tdDomain = document.createElement("td");
    tdDomain.textContent = rule.domain;

    const tdMode = document.createElement("td");
    tdMode.textContent = rule.type === "always" ? "Always" : "1 hour";

    const tdExpires = document.createElement("td");
    if (rule.type === "always") {
      tdExpires.textContent = "Never";
    } else {
      const remaining = Math.max(0, Math.round((rule.expires - now) / 60000));
      tdExpires.textContent = remaining > 0 ? `${remaining} min left` : "Expired";
    }

    const tdAction = document.createElement("td");
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeDomain(i));
    tdAction.appendChild(removeBtn);

    tr.append(tdDomain, tdMode, tdExpires, tdAction);
    list.appendChild(tr);
  });
}

async function removeDomain(index) {
  const { autoInjectDomains = [] } = await chrome.storage.sync.get("autoInjectDomains");
  autoInjectDomains.splice(index, 1);
  await chrome.storage.sync.set({ autoInjectDomains });
  load();
}

document.getElementById("add-btn").addEventListener("click", async () => {
  const domainInput = document.getElementById("new-domain");
  const modeSelect = document.getElementById("new-mode");
  const domain = domainInput.value.trim().toLowerCase();
  if (!domain) return;

  const type = modeSelect.value;
  const { autoInjectDomains = [] } = await chrome.storage.sync.get("autoInjectDomains");
  const existing = autoInjectDomains.findIndex((r) => r.domain === domain);

  const rule = {
    domain,
    type,
    expires: type === "1hour" ? Date.now() + 3600000 : null,
  };

  if (existing >= 0) autoInjectDomains[existing] = rule;
  else autoInjectDomains.push(rule);

  await chrome.storage.sync.set({ autoInjectDomains });
  domainInput.value = "";
  load();
});

load();
