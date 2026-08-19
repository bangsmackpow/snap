const $ = (id) => document.getElementById(id);

const SCHEDULE_F_ACCOUNTS = [
  "Chemicals",
  "Feed",
  "Fertilizer & Lime",
  "Fuel",
  "Machine Hire",
  "Repairs & Maintenance",
  "Supplies",
  "Schedule F:Expense",
];

const state = {
  authenticated: false,
  queue: [],
  index: 0,
  current: null,
  // image viewer transforms per slot
  view: {
    check: { scale: 1, tx: 0, ty: 0, rot: 0, dragging: false, sx: 0, sy: 0 },
    invoice: { scale: 1, tx: 0, ty: 0, rot: 0, dragging: false, sx: 0, sy: 0 },
  },
  selectedBatch: [],
};

// ---- api -------------------------------------------------------------------

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

// ---- auth flow -------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(location.search);
  const token = params.get("t");

  if (token) {
    showAuth("Signing you in…");
    try {
      await api("/api/auth/accountant/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ t: token }),
      });
      history.replaceState(null, "", "/accountant.html");
      state.authenticated = true;
    } catch (e) {
      showAuth("That link is invalid, expired, or already used.", true);
      return;
    }
  }

  if (state.authenticated) {
    enterPortal();
  } else {
    // verify existing session
    try {
      const me = await api("/api/auth/me");
      if (me.authenticated && me.role === "accountant") {
        state.authenticated = true;
        enterPortal();
        return;
      }
    } catch {}
    showAuth("You need an accountant magic link to continue.", true);
  }
}

function showAuth(msg, isError) {
  $("auth-screen").hidden = false;
  $("portal").hidden = true;
  $("auth-msg").textContent = msg;
  $("auth-msg").style.color = isError ? "var(--red)" : "var(--muted)";
  $("auth-retry").hidden = !isError;
}

function enterPortal() {
  $("auth-screen").hidden = true;
  $("portal").hidden = false;
  populateCategorySelect($("category-select"));
  populateCategorySelect($("batch-category"));
  $("queue-filter").addEventListener("change", loadQueue);
  $("logout-btn").addEventListener("click", logout);
  bindViewer();
  bindKeyboard();
  loadQueue();
  loadRules();
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

// ---- queue -----------------------------------------------------------------

async function loadQueue() {
  const filter = $("queue-filter").value;
  const res = await api(`/api/accountant/queue?filter=${filter}&limit=100`);
  state.queue = res.transactions || [];
  $("queue-count").textContent = state.queue.length;
  renderQueue();
  if (state.queue.length && state.index < state.queue.length) {
    selectTxn(state.queue[state.index].id);
  } else {
    state.current = null;
    renderTxn(null);
  }
}

function renderQueue() {
  const ul = $("queue-list");
  if (!state.queue.length) {
    ul.innerHTML = `<li class="queue-item">No transactions in this view.</li>`;
    return;
  }
  ul.innerHTML = state.queue
    .map((t, i) => {
      const amt = t.amount != null ? "$" + (t.amount / 100).toFixed(2) : "—";
      const cls = ["queue-item"];
      if (i === state.index) cls.push("active");
      if (t.flagged) cls.push("flagged");
      if (t.status === "verified") cls.push("verified");
      return `<li class="${cls.join(" ")}" data-idx="${i}">
        <span class="queue-vendor">${escapeHtml(t.vendor_payee || "Unlabeled")}</span>
        <span class="queue-meta"><span>${fmtDate(t.transaction_date)}</span><span>${amt}</span></span>
      </li>`;
    })
    .join("");
  ul.querySelectorAll(".queue-item[data-idx]").forEach((li) => {
    li.addEventListener("click", () => {
      state.index = +li.dataset.idx;
      selectTxn(state.queue[state.index].id);
    });
  });
}

async function selectTxn(id) {
  const res = await api(`/api/accountant/transactions/${id}`);
  state.current = res.transaction;
  state.index = state.queue.findIndex((t) => t.id === id);
  renderQueue();
  renderTxn(state.current);
}

// ---- transaction form + render ---------------------------------------------

function renderTxn(tx) {
  $("txn-id").textContent = tx ? tx.id : "Select a transaction";
  const form = $("txn-form");
  if (!tx) {
    form.reset();
    form.vendor_payee.disabled = true;
    setImages(null, null);
    $("form-status").textContent = "";
    return;
  }
  form.vendor_payee.disabled = false;
  form.vendor_payee.value = tx.vendor_payee || "";
  form.check_number.value = tx.check_number || "";
  form.transaction_date.value = tx.transaction_date
    ? new Date(tx.transaction_date).toISOString().slice(0, 10)
    : "";
  form.amount.value = tx.amount != null ? (tx.amount / 100).toFixed(2) : "";
  form.memo.value = tx.memo || "";
  form.category_code.value = tx.category_code || "Schedule F:Expense";
  form.flag_reason.value = tx.flag_reason || "";

  setImages(tx.check_preview_url, tx.invoice_preview_url);
  $("form-status").textContent = "";
}

function setImages(checkUrl, invoiceUrl) {
  resetView("check");
  resetView("invoice");
  const checkImg = document.querySelector('.image-canvas[data-slot="check"] img');
  const invImg = document.querySelector('.image-canvas[data-slot="invoice"] img');
  checkImg.src = checkUrl || "";
  checkImg.alt = checkUrl ? "Check" : "No check image";
  invImg.src = invoiceUrl || "";
  invImg.alt = invoiceUrl ? "Invoice" : "No invoice image";
}

// ---- one-tap actions -------------------------------------------------------

function currentPatch() {
  const f = $("txn-form");
  const amount = f.amount.value === "" ? null : Math.round(parseFloat(f.amount.value) * 100);
  return {
    vendor_payee: f.vendor_payee.value,
    check_number: f.check_number.value,
    transaction_date: f.transaction_date.value
      ? new Date(f.transaction_date.value).getTime()
      : null,
    amount,
    memo: f.memo.value,
    category_code: f.category_code.value,
  };
}

async function approveNext() {
  if (!state.current) return;
  const patch = { ...currentPatch(), status: "verified", flagged: 0, flag_reason: null };
  await saveTxn(patch);
  next(1);
}

async function flagTxn() {
  if (!state.current) return;
  const patch = {
    ...currentPatch(),
    flagged: 1,
    flag_reason: $("txn-form").flag_reason.value || "Flagged in review",
  };
  await saveTxn(patch);
  next(1);
}

async function unlinkTxn() {
  if (!state.current) return;
  if (!confirm("Unlink / split this check+invoice pair?")) return;
  try {
    await api(`/api/accountant/transactions/${state.current.id}/unlink`, { method: "POST" });
    setStatus("Unlinked.", "ok");
    next(1);
  } catch (e) {
    setStatus(e.message, "error");
  }
}

async function saveTxn(patch) {
  try {
    await api(`/api/accountant/transactions/${state.current.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setStatus("Saved.", "ok");
  } catch (e) {
    setStatus("Save failed: " + e.message, "error");
  }
}

function next(dir) {
  const n = state.queue.length;
  if (!n) return;
  state.index = (state.index + dir + n) % n;
  selectTxn(state.queue[state.index].id);
}

$("approve-btn").addEventListener("click", approveNext);
$("flag-btn").addEventListener("click", flagTxn);
$("unlink-btn").addEventListener("click", unlinkTxn);

// ---- category dropdown -----------------------------------------------------

function populateCategorySelect(sel) {
  sel.innerHTML = SCHEDULE_F_ACCOUNTS.map((a) => `<option value="${a}">${a}</option>`).join("");
}

// ---- image viewer: zoom / pan / rotate -------------------------------------

function bindViewer() {
  document.querySelectorAll(".image-canvas").forEach((canvas) => {
    const slot = canvas.dataset.slot;
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = state.view[slot];
      v.scale = Math.min(5, Math.max(0.2, v.scale + (e.deltaY < 0 ? 0.1 : -0.1)));
      applyTransform(slot);
    }, { passive: false });
    canvas.addEventListener("mousedown", (e) => {
      const v = state.view[slot];
      v.dragging = true;
      v.sx = e.clientX;
      v.sy = e.clientY;
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("mousemove", (e) => {
      const v = state.view[slot];
      if (!v.dragging) return;
      v.tx += e.clientX - v.sx;
      v.ty += e.clientY - v.sy;
      v.sx = e.clientX;
      v.sy = e.clientY;
      applyTransform(slot);
    });
    window.addEventListener("mouseup", () => {
      document.querySelectorAll(".image-canvas").forEach((c) => {
        state.view[c.dataset.slot].dragging = false;
        c.classList.remove("dragging");
      });
    });
  });
}

function applyTransform(slot) {
  const v = state.view[slot];
  const img = document.querySelector(`.image-canvas[data-slot="${slot}"] img`);
  img.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale}) rotate(${v.rot}deg)`;
}

function resetView(slot) {
  state.view[slot] = { scale: 1, tx: 0, ty: 0, rot: 0, dragging: false, sx: 0, sy: 0 };
  applyTransform(slot);
}

$("zoom-in").addEventListener("click", () => {
  const slot = "check";
  state.view[slot].scale = Math.min(5, state.view[slot].scale + 0.2);
  applyTransform(slot);
});
$("zoom-out").addEventListener("click", () => {
  const slot = "check";
  state.view[slot].scale = Math.max(0.2, state.view[slot].scale - 0.2);
  applyTransform(slot);
});
$("rotate-btn").addEventListener("click", () => {
  ["check", "invoice"].forEach((s) => {
    state.view[s].rot = (state.view[s].rot + 90) % 360;
    applyTransform(s);
  });
});
$("reset-view").addEventListener("click", () => {
  resetView("check");
  resetView("invoice");
});

// ---- keyboard shortcuts ----------------------------------------------------

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    switch (e.key.toLowerCase()) {
      case "a": e.preventDefault(); approveNext(); break;
      case "f": e.preventDefault(); flagTxn(); break;
      case "u": e.preventDefault(); unlinkTxn(); break;
      case "r": e.preventDefault(); $("rotate-btn").click(); break;
      case "arrowright": e.preventDefault(); next(1); break;
      case "arrowleft": e.preventDefault(); next(-1); break;
    }
  });
}

// ---- category rules --------------------------------------------------------

async function loadRules() {
  try {
    const res = await api("/api/accountant/category-rules");
    renderRules(res.rules || []);
  } catch {}
}

function renderRules(rules) {
  const body = $("rules-body");
  body.innerHTML = rules
    .map(
      (r) => `<tr>
        <td>${r.match_on}</td>
        <td>${escapeHtml(r.keyword)}</td>
        <td>${escapeHtml(r.account)}</td>
        <td><button class="del" data-id="${r.id}">✕</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll(".del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await api(`/api/accountant/category-rules/${btn.dataset.id}`, { method: "DELETE" });
      loadRules();
    });
  });
}

$("rules-btn").addEventListener("click", () => $("rules-dialog").showModal());
$("rules-close").addEventListener("click", () => $("rules-dialog").close());
$("rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  await api("/api/accountant/category-rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      match_on: f.match_on.value,
      keyword: f.keyword.value,
      account: f.account.value,
      priority: Number(f.priority.value || 100),
    }),
  });
  f.reset();
  loadRules();
});

// ---- batch categorize ------------------------------------------------------

$("queue-list").addEventListener("click", (e) => {
  const li = e.target.closest(".queue-item");
  if (!li) return;
  if (e.shiftKey) {
    e.preventDefault();
    toggleBatch(li);
  }
});

function toggleBatch(li) {
  const idx = +li.dataset.idx;
  const id = state.queue[idx].id;
  const i = state.selectedBatch.indexOf(id);
  if (i >= 0) state.selectedBatch.splice(i, 1);
  else state.selectedBatch.push(id);
  li.classList.toggle("batch-selected", i < 0);
}

// Batch icon/menu is minimal: use the category select + a keyboard/mouse flow.
// We expose a "Batch" affordance via double-click to open the dialog.
$("queue-list").addEventListener("dblclick", (e) => {
  const li = e.target.closest(".queue-item");
  if (!li) return;
  toggleBatch(li);
  openBatchDialog();
});

function openBatchDialog() {
  if (!state.selectedBatch.length) {
    alert("Select transactions with Shift+click (or double-click) first.");
    return;
  }
  $("batch-count").textContent = `${state.selectedBatch.length} transaction(s) selected`;
  $("batch-dialog").showModal();
}

$("batch-apply").addEventListener("click", async () => {
  const cat = $("batch-category").value;
  await api("/api/accountant/batch-categorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction_ids: state.selectedBatch, category_code: cat }),
  });
  state.selectedBatch = [];
  $("batch-dialog").close();
  loadQueue();
});

$("batch-close").addEventListener("click", () => $("batch-dialog").close());

// ---- audit log -------------------------------------------------------------

$("audit-btn").addEventListener("click", async () => {
  const res = await api("/api/accountant/audit?limit=100");
  $("audit-list").innerHTML = (res.audit || [])
    .map(
      (a) =>
        `<li><strong>${a.action}</strong> — ${new Date(a.created_at).toLocaleString()} ${
          a.transaction_id ? `(tx ${a.transaction_id.slice(0, 8)})` : ""
        }<br/><span class="hint">${escapeHtml(a.detail || "")}</span></li>`
    )
    .join("");
  $("audit-dialog").showModal();
});
$("audit-close").addEventListener("click", () => $("audit-dialog").close());

// ---- export trigger --------------------------------------------------------

$("export-btn").addEventListener("click", () => $("export-dialog").showModal());
$("export-close").addEventListener("click", () => $("export-dialog").close());
$("export-confirm").addEventListener("click", async () => {
  const range = $("export-range").value;
  const btn = $("export-confirm");
  btn.disabled = true;
  $("export-status").textContent = "Building package…";
  $("export-status").classList.remove("error");
  try {
    const res = await api("/api/accountant/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range }),
    });
    $("export-status").textContent = `Saved ${res.fileName} (${res.recordCount} records) to R2.`;
    $("export-status").classList.add("ok");
  } catch (e) {
    $("export-status").textContent = "Export failed: " + e.message;
    $("export-status").classList.add("error");
  } finally {
    btn.disabled = false;
  }
});

// ---- utils -----------------------------------------------------------------

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString();
}

function setStatus(msg, cls) {
  const el = $("form-status");
  el.textContent = msg;
  el.className = "status " + (cls || "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

init();