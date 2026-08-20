const $ = (id) => document.getElementById(id);

const state = {
  authenticated: false,
  username: null,
};

async function api(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return body;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

// ---- auth / boot -----------------------------------------------------------

async function init() {
  try {
    const me = await api("/api/admin/me");
    if (me.authenticated) {
      state.authenticated = true;
      state.username = me.username;
      enterDashboard();
      return;
    }
  } catch {}
  showLogin();
}

function showLogin() {
  $("login-screen").hidden = false;
  $("dashboard").hidden = true;
}

function enterDashboard() {
  $("login-screen").hidden = true;
  $("dashboard").hidden = false;
  $("admin-user").textContent = state.username;
  loadUsers();
  loadCodes();
  loadSessions();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  btn.disabled = true;
  $("login-error").textContent = "";
  try {
    const res = await api("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: e.target.username.value,
        password: e.target.password.value,
      }),
    });
    state.authenticated = res.authenticated;
    state.username = res.username;
    enterDashboard();
  } catch (err) {
    $("login-error").textContent =
      err.message === "bad_credentials" ? "Incorrect username or password." : "Sign in failed.";
  } finally {
    btn.disabled = false;
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" }).catch(() => {});
  state.authenticated = false;
  showLogin();
});

// ---- tabs ------------------------------------------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

// ---- users -----------------------------------------------------------------

async function loadUsers() {
  const res = await api("/api/admin/users");
  const users = res.users || [];
  const body = $("users-body");
  if (!users.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No admin users yet.</td></tr>`;
    return;
  }
  body.innerHTML = users
    .map(
      (u) => `<tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td><span class="badge ${u.active ? "active" : "inactive"}">${u.active ? "Active" : "Disabled"}</span></td>
        <td>${fmtDate(u.last_login_at)}</td>
        <td>${fmtDate(u.created_at)}</td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-reset="${u.id}">Reset pw</button>
          <button class="btn ghost sm" data-toggle="${u.id}" data-active="${u.active}">${u.active ? "Disable" : "Enable"}</button>
          <button class="btn danger sm" data-del="${u.id}">Delete</button>
        </div></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => openUserDialog(b.dataset.reset)));
  body.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/admin/users/${b.dataset.toggle}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: b.dataset.active === "1" ? 0 : 1 }),
      });
      loadUsers();
    })
  );
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this admin user?")) return;
      await api(`/api/admin/users/${b.dataset.del}`, { method: "DELETE" });
      loadUsers();
    })
  );
}

const userDialog = $("user-dialog");
let editingUserId = null;

function openUserDialog(id) {
  editingUserId = id || null;
  $("user-dialog-title").textContent = id ? "Reset Password" : "Add Admin User";
  $("user-form").username.value = id ? "" : "";
  $("user-form").username.disabled = !!id;
  $("user-form").password.value = "";
  $("user-form-error").textContent = "";
  userDialog.showModal();
}

$("add-user-btn").addEventListener("click", () => openUserDialog(null));

$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("user-form-error").textContent = "";
  try {
    if (editingUserId) {
      await api(`/api/admin/users/${editingUserId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: e.target.password.value }),
      });
    } else {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: e.target.username.value, password: e.target.password.value }),
      });
    }
    userDialog.close();
    loadUsers();
  } catch (err) {
    $("user-form-error").textContent =
      err.message === "username_taken" ? "That username is already taken." : "Save failed.";
  }
});

// ---- enrollment codes ------------------------------------------------------

async function loadCodes() {
  const res = await api("/api/admin/enroll-codes");
  const codes = res.codes || [];
  const body = $("codes-body");
  if (!codes.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">No enrollment codes yet.</td></tr>`;
    return;
  }
  const now = Date.now();
  body.innerHTML = codes
    .map((c) => {
      const expired = c.expires_at != null && c.expires_at <= now;
      const usedUp = c.max_uses != null && c.used_count >= c.max_uses;
      const status = !c.active ? "inactive" : expired ? "expired" : usedUp ? "inactive" : "active";
      const label = status === "active" ? "Active" : status === "expired" ? "Expired" : "Disabled";
      return `<tr>
        <td>${escapeHtml(c.label || "—")}</td>
        <td>${c.used_count}${c.max_uses != null ? ` / ${c.max_uses}` : ""}</td>
        <td>${c.expires_at ? fmtDate(c.expires_at) : "Never"}</td>
        <td><span class="badge ${status}">${label}</span></td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-toggle="${c.id}" data-active="${c.active}">${c.active ? "Revoke" : "Enable"}</button>
          <button class="btn danger sm" data-del="${c.id}">Delete</button>
        </div></td>
      </tr>`;
    })
    .join("");
  body.querySelectorAll("[data-toggle]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/admin/enroll-codes/${b.dataset.toggle}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: b.dataset.active === "1" ? 0 : 1 }),
      });
      loadCodes();
    })
  );
  body.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Delete this enrollment code?")) return;
      await api(`/api/admin/enroll-codes/${b.dataset.del}`, { method: "DELETE" });
      loadCodes();
    })
  );
}

const codeDialog = $("code-dialog");
$("add-code-btn").addEventListener("click", () => {
  $("code-form").reset();
  $("code-form-error").textContent = "";
  codeDialog.showModal();
});

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("code-form-error").textContent = "";
  const expires = e.target.expires_at.value;
  const maxUses = e.target.max_uses.value;
  try {
    const res = await api("/api/admin/enroll-codes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: e.target.label.value || null,
        max_uses: maxUses ? Number(maxUses) : null,
        expires_at: expires ? new Date(expires).getTime() : null,
      }),
    });
    codeDialog.close();
    $("reveal-code").textContent = res.code;
    $("reveal-dialog").showModal();
    loadCodes();
  } catch (err) {
    $("code-form-error").textContent = "Failed to generate code.";
  }
});

$("copy-code-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("reveal-code").textContent);
  $("copy-code-btn").textContent = "Copied!";
  setTimeout(() => ($("copy-code-btn").textContent = "Copy"), 1500);
});

// ---- sessions --------------------------------------------------------------

async function loadSessions() {
  const res = await api("/api/admin/sessions");
  const sessions = res.sessions || [];
  const body = $("sessions-body");
  if (!sessions.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">No active sessions.</td></tr>`;
    return;
  }
  body.innerHTML = sessions
    .map(
      (s) => `<tr>
        <td><span class="badge ${s.user_role === "admin" ? "active" : "inactive"}">${s.user_role}</span></td>
        <td>${fmtDate(s.created_at)}</td>
        <td>${fmtDate(s.expires_at)}</td>
        <td><div class="row-actions">
          <button class="btn danger sm" data-revoke="${s.id}">Revoke</button>
        </div></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("[data-revoke]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Revoke this session (force logout)?")) return;
      await api(`/api/admin/sessions/${b.dataset.revoke}/revoke`, { method: "POST" });
      loadSessions();
    })
  );
}

// close modals via data-close
document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => b.closest("dialog").close())
);

init();