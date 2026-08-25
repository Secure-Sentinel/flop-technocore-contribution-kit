const $ = (id) => document.getElementById(id);
const state = { identityExists: false, unlocked: false, did: null, records: [] };

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}

async function api(path, payload = null) {
  const response = await fetch(path, payload ? {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  } : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function setIdentity(did) {
  state.did = did;
  state.unlocked = true;
  $("didValue").textContent = did;
  $("didBox").classList.remove("hidden");
  $("statusDot").classList.add("ready");
  $("identityStatus").textContent = "Identity unlocked locally";
}

function renderStatus(status) {
  state.identityExists = status.exists;
  if (status.exists) {
    $("statusDot").classList.add("exists");
    $("identityStatus").textContent = "Encrypted identity found — enter passphrase to unlock";
  } else {
    $("identityStatus").textContent = "No local identity yet — create one to begin";
  }
}

function passphrase() {
  const value = $("passphrase").value;
  if (value.length < 12) throw new Error("Use an identity passphrase with at least 12 characters.");
  return value;
}

function addActivity(label, result) {
  state.records.push({ label, result });
  const timeline = $("timeline");
  timeline.querySelectorAll(".activity-item").forEach((node) => node.remove());
  for (const item of state.records) {
    const article = document.createElement("article");
    article.className = "activity-item";
    const marker = document.createElement("span");
    marker.className = "activity-marker";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.label;
    const detail = document.createElement("code");
    detail.textContent = `${item.result.room} · seq ${item.result.seq ?? "unknown"} · ${item.result.recordUrl}`;
    content.append(title, detail);
    article.append(marker, content);
    timeline.append(article);
  }
}

function download(name, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function refreshStatus() {
  try {
    renderStatus(await api("/api/status"));
  } catch (error) {
    showToast(error.message, true);
  }
}

$("identityButton").addEventListener("click", async () => {
  try {
    const secret = passphrase();
    const data = state.identityExists ? await api("/api/unlock", { passphrase: secret }) : await api("/api/init", { passphrase: secret });
    setIdentity(data.did);
    showToast(state.identityExists ? "Identity unlocked locally." : "Encrypted identity created locally.");
    await refreshStatus();
  } catch (error) {
    showToast(error.message, true);
  }
});

$("joinButton").addEventListener("click", async () => {
  try {
    const data = await api("/api/join", {
      passphrase: passphrase(),
      name: $("agentName").value.trim().toLowerCase() || "new-contributor",
      baseUrl: $("baseUrl").value.trim(),
    });
    setIdentity(data.result.did);
    addActivity("Signed lobby message published", data.result);
    showToast("Lobby proof published.");
  } catch (error) {
    showToast(error.message, true);
  }
});

$("contributeButton").addEventListener("click", async () => {
  try {
    const data = await api("/api/contribute", {
      passphrase: passphrase(),
      url: $("contributionUrl").value.trim(),
      summary: $("summary").value.trim(),
      type: $("contributionType").value,
      baseUrl: $("baseUrl").value.trim(),
    });
    setIdentity(data.result.did);
    addActivity("Contribution recorded in Technocore", data.result);
    showToast("Contribution evidence saved locally.");
  } catch (error) {
    showToast(error.message, true);
  }
});

$("exportButton").addEventListener("click", async () => {
  try {
    const data = await api("/api/export", {
      passphrase: passphrase(),
      artifactUrl: $("contributionUrl").value.trim(),
      commit: $("commit").value.trim(),
    });
    $("downloads").classList.remove("hidden");
    const downloads = $("downloads");
    downloads.replaceChildren();
    for (const [name, content] of Object.entries(data.files)) {
      const button = document.createElement("button");
      button.className = "download-card";
      const title = document.createElement("strong");
      title.textContent = name;
      const detail = document.createElement("span");
      detail.textContent = "Download public file";
      button.append(title, detail);
      button.addEventListener("click", () => download(name, content, name.endsWith("json") ? "application/json" : "text/plain"));
      downloads.append(button);
    }
    showToast("Proof kit ready. Verify public-proof.json offline before committing it.");
  } catch (error) {
    showToast(error.message, true);
  }
});

refreshStatus();

