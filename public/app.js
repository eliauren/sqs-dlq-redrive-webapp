async function fetchJson(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json();
}

const envSelect = document.getElementById("envSelect");
const regionSelect = document.getElementById("regionSelect");
const dlqSelect = document.getElementById("dlqSelect");
const targetSelect = document.getElementById("targetSelect");
const loadQueuesBtn = document.getElementById("loadQueuesBtn");
const queuesStatus = document.getElementById("queuesStatus");
const attrPathInput = document.getElementById("attrPathInput");
const attrValueInput = document.getElementById("attrValueInput");
const maxMessagesInput = document.getElementById("maxMessagesInput");
const previewBtn = document.getElementById("previewBtn");
const previewStatus = document.getElementById("previewStatus");
const messagesTableBody = document.querySelector("#messagesTable tbody");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const deleteAfterSendCheckbox = document.getElementById(
  "deleteAfterSendCheckbox"
);
const excludeMatchingCheckbox = document.getElementById(
  "excludeMatchingCheckbox"
);
const redriveBtn = document.getElementById("redriveBtn");
const redriveStatus = document.getElementById("redriveStatus");

// SSO-related elements
const ssoProfileSelect = document.getElementById("ssoProfileSelect");
const ssoConnectBtn = document.getElementById("ssoConnectBtn");
const ssoStatus = document.getElementById("ssoStatus");

let currentMessages = [];
let currentSessionId = null;

// ── Session Persistence ────────────────────────────────────────────────
const SESSION_KEY = "sqs-redrive-session";
const IDB_NAME = "sqs-redrive";
const IDB_STORE = "keys";
const IDB_KEY_ID = "session-encryption-key";

// In-memory cache of the encryption key
let encryptionKey = null;

function openKeyStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;

  // Try to load existing key from IndexedDB
  try {
    const db = await openKeyStore();
    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (existing) {
      encryptionKey = existing;
      return encryptionKey;
    }
  } catch {
    // IndexedDB unavailable — fall through to generate new key
  }

  // Generate a new key
  encryptionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // not extractable
    ["encrypt", "decrypt"]
  );

  // Persist to IndexedDB (survives refresh, cleared on tab close via clearSession)
  try {
    const db = await openKeyStore();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const req = tx.objectStore(IDB_STORE).put(encryptionKey, IDB_KEY_ID);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Non-critical — key still works in memory for this page lifetime
  }

  return encryptionKey;
}

async function encryptData(plaintext) {
  const key = await getEncryptionKey();
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext)
  );
  // Store IV + ciphertext as base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptData(encoded) {
  const key = await getEncryptionKey();
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

async function saveSession() {
  try {
    const state = {
      currentSessionId,
      ssoProfile: ssoProfileSelect?.value || null,
      envId: envSelect.value || null,
      region: regionSelect.value || null,
      dlqUrl: dlqSelect.value || null,
      targetUrl: targetSelect.value || null,
      envOptions: Array.from(envSelect.options).map((o) => ({
        value: o.value,
        text: o.textContent,
        regions: o.dataset.regions || "[]",
      })),
      regionOptions: Array.from(regionSelect.options).map((o) => ({
        value: o.value,
        text: o.textContent,
      })),
      queueOptions: Array.from(dlqSelect.options).map((o) => ({
        value: o.value,
        text: o.textContent,
      })),
      currentMessages,
      timestamp: Date.now(),
    };
    const encrypted = await encryptData(JSON.stringify(state));
    sessionStorage.setItem(SESSION_KEY, encrypted);
  } catch {
    // Ignore serialization/encryption errors
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  encryptionKey = null;
  // Clean up IndexedDB key
  openKeyStore()
    .then((db) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(IDB_KEY_ID);
    })
    .catch(() => {});
}

async function getSavedSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const decrypted = await decryptData(raw);
    return JSON.parse(decrypted);
  } catch {
    // Decryption fails if key changed (new tab) — expected behavior
    clearSession();
    return null;
  }
}

async function restoreSession() {
  const saved = await getSavedSession();
  if (!saved || !saved.currentSessionId) return false;

  // Validate the backend session is still alive
  try {
    await fetchJson(
      `/api/sso/environments?sessionId=${encodeURIComponent(saved.currentSessionId)}`
    );
  } catch {
    clearSession();
    return false;
  }

  // Restore state
  currentSessionId = saved.currentSessionId;

  // Restore SSO profile selection
  if (saved.ssoProfile && ssoProfileSelect) {
    ssoProfileSelect.value = saved.ssoProfile;
  }

  // Restore environment options and selection
  if (saved.envOptions && saved.envOptions.length > 0) {
    envSelect.innerHTML = "";
    envSelect.disabled = false;
    for (const o of saved.envOptions) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.text;
      opt.dataset.regions = o.regions;
      envSelect.appendChild(opt);
    }
    if (saved.envId) envSelect.value = saved.envId;
  }

  // Restore region options and selection
  if (saved.regionOptions && saved.regionOptions.length > 0) {
    regionSelect.innerHTML = "";
    for (const o of saved.regionOptions) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.text;
      regionSelect.appendChild(opt);
    }
    if (saved.region) regionSelect.value = saved.region;
  }

  // Restore queue options and selection
  if (saved.queueOptions && saved.queueOptions.length > 0) {
    dlqSelect.innerHTML = "";
    dlqSelect.disabled = false;
    targetSelect.innerHTML = "";
    targetSelect.disabled = false;
    for (const o of saved.queueOptions) {
      const opt1 = document.createElement("option");
      opt1.value = o.value;
      opt1.textContent = o.text;
      dlqSelect.appendChild(opt1);

      const opt2 = document.createElement("option");
      opt2.value = o.value;
      opt2.textContent = o.text;
      targetSelect.appendChild(opt2);
    }
    if (saved.dlqUrl) dlqSelect.value = saved.dlqUrl;
    if (saved.targetUrl) targetSelect.value = saved.targetUrl;
  }

  // Restore messages
  if (saved.currentMessages && saved.currentMessages.length > 0) {
    currentMessages = saved.currentMessages;
    renderMessagesTable();
    previewStatus.textContent = `Restored ${currentMessages.length} messages from previous session.`;
    previewStatus.className = "status success";
  }

  // Re-enable buttons
  loadQueuesBtn.disabled = false;
  previewBtn.disabled = false;
  if (saved.queueOptions && saved.queueOptions.length > 0) {
    redriveBtn.disabled = false;
  }

  ssoStatus.textContent = "Session restored from previous connection.";
  ssoStatus.className = "status success";
  return true;
}

function generateSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return "sess-" + hex;
}

async function loadSsoProfiles() {
  if (!ssoProfileSelect) return;
  try {
    const profiles = await fetchJson("/api/sso-profiles");
    ssoProfileSelect.innerHTML = "";

    // Group profiles by ssoSession so we only show one entry
    // per SSO session, as defined
    // in ~/.aws/config.
    const bySession = new Map();
    for (const p of profiles) {
      const sessionName = p.ssoSession || p.name;
      if (!bySession.has(sessionName)) {
        bySession.set(sessionName, p);
      }
    }

    for (const [sessionName, p] of bySession.entries()) {
      const opt = document.createElement("option");
      // We still pass the underlying profile name to the backend
      // for login, but label the option with the SSO session name.
      opt.value = p.name;
      opt.textContent = sessionName;
      ssoProfileSelect.appendChild(opt);
    }
  } catch (err) {
    if (ssoStatus) {
      ssoStatus.textContent = "Failed to load SSO profiles: " + err.message;
      ssoStatus.className = "status error";
    }
  }
}

if (ssoConnectBtn && ssoProfileSelect && ssoStatus) {
  ssoConnectBtn.addEventListener("click", async () => {
    const profileName = ssoProfileSelect.value;
    if (!profileName) {
      ssoStatus.textContent = "Please select an SSO profile.";
      ssoStatus.className = "status error";
      return;
    }

    currentSessionId = generateSessionId();
    ssoStatus.textContent = "Starting SSO login...";
    ssoStatus.className = "status";

    try {
      const start = await fetchJson("/api/sso/login/start", {
        method: "POST",
        body: JSON.stringify({ profileName }),
      });

      ssoStatus.innerHTML =
        'Open <a href="' +
        start.verificationUri +
        '" target="_blank" rel="noreferrer">this link</a> and complete login. ' +
        "User code: " +
        start.userCode +
        ". Waiting for completion...";
      ssoStatus.className = "status";

      const pollBody = {
        profileName,
        deviceCode: start.deviceCode,
        sessionId: currentSessionId,
      };

      let done = false;
      while (!done) {
        const res = await fetchJson("/api/sso/login/poll", {
          method: "POST",
          body: JSON.stringify(pollBody),
        });

        if (res.success) {
          done = true;
          break;
        }

        // Still waiting for user to complete authorization
        await new Promise((resolve) =>
          setTimeout(resolve, (start.intervalSeconds || 5) * 1000)
        );
      }

      ssoStatus.textContent = "SSO login successful. Discovering environments...";
      ssoStatus.className = "status success";

      // Discover environments via SSO ListAccounts / ListAccountRoles
      try {
        const envs = await fetchJson(
          `/api/sso/environments?sessionId=${encodeURIComponent(
            currentSessionId
          )}`
        );
        envSelect.innerHTML = "";
        envSelect.disabled = false;
        for (const env of envs) {
          const opt = document.createElement("option");
          opt.value = env.id;
          opt.textContent = env.label || env.id;
          opt.dataset.regions = JSON.stringify(env.regions || []);
          envSelect.appendChild(opt);
        }
        updateRegions();
        ssoStatus.textContent = `SSO connected – ${envs.length} environment(s) discovered.`;
        ssoStatus.className = "status success";
        // Enable downstream controls
        loadQueuesBtn.disabled = false;
        previewBtn.disabled = false;
        await saveSession();      } catch (envErr) {
        ssoStatus.textContent = "SSO connected but failed to discover environments: " + envErr.message;
        ssoStatus.className = "status error";
      }
    } catch (err) {
      ssoStatus.textContent = "SSO login failed: " + err.message;
      ssoStatus.className = "status error";
      currentSessionId = null;
      clearSession();
    }
  });
}

function updateRegions() {
  const selected = envSelect.options[envSelect.selectedIndex];
  if (!selected) return;
  const regions = JSON.parse(selected.dataset.regions || "[]");
  regionSelect.innerHTML = "";
  for (const region of regions) {
    const opt = document.createElement("option");
    opt.value = region;
    opt.textContent = region;
    regionSelect.appendChild(opt);
  }
}

envSelect.addEventListener("change", async () => {
  updateRegions();
  await saveSession();
});

loadQueuesBtn.addEventListener("click", async () => {
  const envId = envSelect.value;
  const region = regionSelect.value;
  if (!envId || !region) return;

  queuesStatus.textContent = "Loading queues...";
  queuesStatus.className = "status";

  try {
    const params = new URLSearchParams({
      envId,
      region,
    });
    if (currentSessionId) {
      params.set("sessionId", currentSessionId);
    }

    const data = await fetchJson(`/api/queues?${params.toString()}`);
    dlqSelect.innerHTML = "";
    dlqSelect.disabled = false;
    targetSelect.innerHTML = "";
    targetSelect.disabled = false;
    (data.queues || []).forEach((url) => {
      const name = url.split("/").slice(-1)[0];
      const opt1 = document.createElement("option");
      opt1.value = url;
      opt1.textContent = name;
      dlqSelect.appendChild(opt1);

      const opt2 = document.createElement("option");
      opt2.value = url;
      opt2.textContent = name;
      targetSelect.appendChild(opt2);
    });
    queuesStatus.textContent = `Loaded ${data.queues.length} queues`;
    queuesStatus.className = "status success";

    // Enable redrive button now that queues are loaded
    redriveBtn.disabled = false;
    await saveSession();
  } catch (err) {
    queuesStatus.textContent = "Failed to load queues: " + err.message;
    queuesStatus.className = "status error";
  }
});

previewBtn.addEventListener("click", async () => {
  const envId = envSelect.value;
  const region = regionSelect.value;
  const dlqUrl = dlqSelect.value;
  const attributePath = attrPathInput.value.trim();
  const expectedValue = attrValueInput.value;
  const maxMessages = parseInt(maxMessagesInput.value || "1000", 10);
  const excludeMatching = excludeMatchingCheckbox.checked;

  if (!envId || !region || !dlqUrl) {
    previewStatus.textContent =
      "Please select environment, region and DLQ.";
    previewStatus.className = "status error";
    return;
  }

  previewStatus.textContent = "Loading and filtering messages...";
  previewStatus.className = "status";
  messagesTableBody.innerHTML = "";
  currentMessages = [];

  try {
    const data = await fetchJson("/api/preview", {
      method: "POST",
      body: JSON.stringify({
        envId,
        region,
        dlqUrl,
        maxMessages,
        attributePath,
        expectedValue,
        excludeMatching,
        sessionId: currentSessionId,
      }),
    });

    previewStatus.textContent = attributePath
      ? `Fetched ${data.totalFetched} messages, ${data.totalMatched} matched filter.`
      : `Fetched ${data.totalFetched} messages.`;
    previewStatus.className = "status success";

    currentMessages = data.messages || [];
    renderMessagesTable();
    await saveSession();
  } catch (err) {
    previewStatus.textContent = "Failed to preview messages: " + err.message;
    previewStatus.className = "status error";
  }
});

function renderMessagesTable() {
  messagesTableBody.innerHTML = "";
  currentMessages.forEach((m, index) => {
    const tr = document.createElement("tr");
    const preview =
      (m.body || "").length > 200
        ? m.body.slice(0, 200) + "..."
        : m.body || "";

    tr.innerHTML = `
      <td><input type="checkbox" class="messageCheckbox" data-index="${index}" /></td>
      <td>${m.messageId || ""}</td>
      <td>${m.attributeValue !== undefined ? String(m.attributeValue) : ""}</td>
      <td><pre style="white-space: pre-wrap; margin: 0;">${preview}</pre></td>
    `;

    // Click on the row (excluding checkbox) to open message body modal
    tr.addEventListener("click", (e) => {
      if (e.target.type === "checkbox") return;
      showMessageBody(index);
    });

    messagesTableBody.appendChild(tr);
  });
}

selectAllCheckbox.addEventListener("change", () => {
  const checked = selectAllCheckbox.checked;
  document
    .querySelectorAll(".messageCheckbox")
    .forEach((cb) => (cb.checked = checked));
});

redriveBtn.addEventListener("click", async () => {
  const envId = envSelect.value;
  const region = regionSelect.value;
  const dlqUrl = dlqSelect.value;
  const targetUrl = targetSelect.value;
  const deleteAfterSend = deleteAfterSendCheckbox.checked;

  if (!envId || !region || !dlqUrl || !targetUrl) {
    redriveStatus.textContent =
      "Please select environment, region, DLQ and target queue.";
    redriveStatus.className = "status error";
    return;
  }
  if (dlqUrl === targetUrl) {
    redriveStatus.textContent = "DLQ and target queue must be different.";
    redriveStatus.className = "status error";
    return;
  }

  const selectedIndexes = Array.from(
    document.querySelectorAll(".messageCheckbox")
  )
    .filter((cb) => cb.checked)
    .map((cb) => parseInt(cb.dataset.index, 10));

  if (selectedIndexes.length === 0) {
    redriveStatus.textContent = "No messages selected.";
    redriveStatus.className = "status error";
    return;
  }

  const selectedMessages = selectedIndexes.map((i) => currentMessages[i]);

  redriveStatus.textContent = `Redriving ${selectedMessages.length} messages...`;
  redriveStatus.className = "status";

  try {
    const summary = await fetchJson("/api/redrive", {
      method: "POST",
      body: JSON.stringify({
        envId,
        region,
        dlqUrl,
        targetUrl,
        messages: selectedMessages,
        deleteAfterSend,
        sessionId: currentSessionId,
      }),
    });
    redriveStatus.textContent = `Sent: ${summary.sent}, Send failed: ${summary.sendFailed}, Deleted: ${summary.deleted}, Delete failed: ${summary.deleteFailed}`;
    redriveStatus.className = "status success";
  } catch (err) {
    redriveStatus.textContent = "Failed to redrive messages: " + err.message;
    redriveStatus.className = "status error";
  }
});

// ---- Message body modal ----

const messageModal = document.getElementById("messageModal");
const modalCloseBtn = document.getElementById("modalCloseBtn");
const modalMessageBody = document.getElementById("modalMessageBody");
const modalTitle = document.getElementById("modalTitle");

function showMessageBody(index) {
  const message = currentMessages[index];
  if (!message) return;

  let formatted = message.body || "";
  try {
    const parsed = JSON.parse(formatted);
    formatted = JSON.stringify(parsed, null, 2);
  } catch (_) {
    // Not JSON – show as-is
  }

  modalTitle.textContent = "Message " + (message.messageId || index);
  modalMessageBody.textContent = formatted;
  messageModal.style.display = "flex";
}

modalCloseBtn.addEventListener("click", () => {
  messageModal.style.display = "none";
});

messageModal.addEventListener("click", (e) => {
  if (e.target === messageModal) {
    messageModal.style.display = "none";
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && messageModal.style.display !== "none") {
    messageModal.style.display = "none";
  }
});

// Initial load
async function init() {
  await loadSsoProfiles();
  await restoreSession();
}

init();

