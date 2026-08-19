const $ = (id) => document.getElementById(id);

const state = {
  enrolled: false,
  role: null,
  mode: "quick",
  busy: false,
  pair: { invoiceId: null, checkId: null, invoiceExt: null, checkExt: null },
};

// ---- api helper ------------------------------------------------------------

async function api(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const err = new Error(body?.error || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return body;
}

// ---- boot ------------------------------------------------------------------

function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

async function init() {
  registerSW();
  try {
    const me = await api("/api/auth/me");
    state.enrolled = me.authenticated;
    state.role = me.role;
  } catch {
    state.enrolled = false;
  }
  renderAuth();
  if (state.enrolled) loadRecent();
}

function renderAuth() {
  $("enroll-screen").hidden = state.enrolled;
  $("capture-screen").hidden = !state.enrolled;
  $("export-open-btn").hidden = !state.enrolled;
  const badge = $("auth-badge");
  if (state.enrolled) {
    badge.hidden = false;
    badge.textContent = "● " + (state.role === "farmer" ? "Farmer" : "Accountant");
  } else {
    badge.hidden = true;
  }
}

// ---- enrollment ------------------------------------------------------------

$("enroll-btn").addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true, "Enrolling…");
  try {
    const body = {};
    const key = $("enroll-key").value.trim();
    if (key) body.enroll_key = key;
    const res = await api("/api/auth/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    state.enrolled = res.authenticated;
    state.role = res.role;
    renderAuth();
    if (state.enrolled) loadRecent();
  } catch (err) {
    setStatus(err.message === "bad_enroll_key" ? "Wrong enroll code." : "Enroll failed.", true);
  } finally {
    setBusy(false);
  }
});

// ---- mode toggle -----------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  state.pair = { invoiceId: null, checkId: null, invoiceExt: null, checkExt: null };
  $("mode-quick").classList.toggle("active", mode === "quick");
  $("mode-pair").classList.toggle("active", mode === "pair");
  hideCard();
  updateCaptureUI();
}

$("mode-quick").addEventListener("click", () => setMode("quick"));
$("mode-pair").addEventListener("click", () => setMode("pair"));

function updateCaptureUI() {
  const btn = $("capture-btn");
  if (state.mode === "quick") {
    $("capture-hint").textContent = "Snap a photo of a check or invoice";
    btn.textContent = "Snap Photo";
  } else if (!state.pair.invoiceId) {
    $("capture-hint").textContent = "Step 1 of 2 — snap the invoice";
    btn.textContent = "Snap Invoice";
  } else if (!state.pair.checkId) {
    $("capture-hint").textContent = "Step 2 of 2 — snap the matching check";
    btn.textContent = "Snap Check";
  } else {
    $("capture-hint").textContent = "Ready to save the pair";
    btn.textContent = "Start Over";
  }
}

// ---- capture ---------------------------------------------------------------

$("capture-btn").addEventListener("click", () => {
  if (state.mode === "pair" && state.pair.invoiceId && state.pair.checkId) {
    setMode("pair");
    return;
  }
  $("file-input").click();
});

$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file || state.busy) return;
  await handleFile(file);
});

async function handleFile(file) {
  setBusy(true, "Uploading & extracting…");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await api("/api/upload", { method: "POST", body: fd });
    const ext = res.extraction;
    if (state.mode === "pair") {
      if (!state.pair.invoiceId && ext?.doc_type === "invoice") {
        state.pair.invoiceId = res.document.id;
        state.pair.invoiceExt = ext;
      } else if (!state.pair.checkId && ext?.doc_type === "check") {
        state.pair.checkId = res.document.id;
        state.pair.checkExt = ext;
      } else {
        renderResult(res);
      }
      updateCaptureUI();
      if (state.pair.invoiceId && state.pair.checkId) {
        renderPairReady();
      } else if (state.pair.invoiceId || state.pair.checkId) {
        renderPairPartial(res);
      }
    } else {
      renderResult(res);
    }
  } catch (err) {
    setStatus(err.message === "vision_api_key_missing"
      ? "Extraction service is not configured yet."
      : err.message === "unauthorized" ? "Session expired — re-enroll."
      : "Upload failed: " + (err.message || "unknown error"), true);
  } finally {
    setBusy(false);
  }
}

// ---- rendering -------------------------------------------------------------

function money(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function moneyCents(n) {
  if (n == null) return "—";
  return money(n / 100);
}

function fieldHtml(k, v) {
  if (v == null || v === "" || v === "—") return "";
  return `<li><span class="k">${k}</span><span class="v">${v}</span></li>`;
}

function renderResult(res) {
  const card = $("result-card");
  const ext = res.extraction;
  const doc = res.document;
  const type = ext?.doc_type === "check" ? "check" : ext?.doc_type === "invoice" ? "invoice" : null;

  let body = "";
  let chip = "";
  if (type === "check") {
    chip = `<span class="chip check">Check</span>`;
    body = [
      fieldHtml("Check #", ext.check_number),
      fieldHtml("Payee", ext.payee),
      fieldHtml("Amount", money(ext.amount_numeric)),
      fieldHtml("Date", ext.date),
      fieldHtml("Memo", ext.memo_line),
    ].join("");
  } else if (type === "invoice") {
    chip = `<span class="chip invoice">Invoice</span>`;
    body = [
      fieldHtml("Vendor", ext.vendor_name),
      fieldHtml("Invoice #", ext.invoice_number),
      fieldHtml("Total", money(ext.total_due)),
      fieldHtml("Date", ext.invoice_date),
      fieldHtml("Items", ext.line_items_summary),
    ].join("");
  } else {
    chip = `<span class="chip error">${doc.doc_type === "unknown" ? "Not a check/invoice" : "Extraction failed"}</span>`;
    body = `<p>${doc.extraction_error || "Could not read this image."}</p>`;
  }

  let matchNote = "";
  let statusChip = "";
  if (res.transaction) {
    statusChip = `<span class="chip ${res.transaction.status}">${res.transaction.status}</span>`;
  }
  if (res.matched) {
    const m = res.matched;
    matchNote = `<div class="match-note">Automatically matched (${res.transaction?.confidence_score ?? "—"}% confidence): ${m.doc_type === "check" ? "check" : "invoice"} #${m.doc_type === "check" ? "?" : "?"}</div>`;
  }

  card.innerHTML = `
    <div class="result-head">
      <div class="result-title">${chip}</div>
      <div>${statusChip}</div>
    </div>
    <ul class="fields">${body}</ul>
    ${matchNote}
    <div class="card-actions">
      <a class="inline-link" href="/api/documents/${doc.id}/preview" target="_blank" rel="noopener">View image</a>
      ${doc.status === "error" ? `<button class="big-btn ghost" data-retry="${doc.id}">Retry extraction</button>` : ""}
      <button class="big-btn" data-done>Done</button>
    </div>`;
  card.hidden = false;

  card.querySelector("[data-done]").addEventListener("click", () => {
    hideCard();
    setStatus("");
    updateCaptureUI();
  });
  const retry = card.querySelector("[data-retry]");
  if (retry) {
    retry.addEventListener("click", async () => {
      setBusy(true, "Re-extracting…");
      try {
        const r = await api(`/api/documents/${retry.dataset.retry}/extract`, { method: "POST" });
        renderResult(r);
      } catch (err) {
        setStatus("Retry failed.", true);
      } finally {
        setBusy(false);
      }
    });
  }
}

function renderPairPartial(res) {
  const card = $("result-card");
  const ext = res.extraction;
  const captured = state.pair.invoiceExt || state.pair.checkExt;
  const label = ext?.doc_type === "invoice" ? "Invoice captured" : "Check captured";
  card.innerHTML = `
    <div class="result-head">
      <div class="result-title">${label} ✓</div>
    </div>
    <p class="hint">Now snap the ${ext?.doc_type === "invoice" ? "check" : "invoice"} to complete the pair.</p>
    <div class="card-actions">
      <button class="big-btn" data-done>Done</button>
    </div>`;
  card.hidden = false;
  card.querySelector("[data-done]").addEventListener("click", () => {
    hideCard();
    setStatus("");
    updateCaptureUI();
  });
}

function renderPairReady() {
  const card = $("result-card");
  const inv = state.pair.invoiceExt;
  const chk = state.pair.checkExt;
  card.innerHTML = `
    <div class="result-head">
      <div class="result-title">Ready to pair</div>
    </div>
    <ul class="fields">
      ${fieldHtml("Vendor (invoice)", inv?.vendor_name)}
      ${fieldHtml("Invoice total", money(inv?.total_due))}
      ${fieldHtml("Check #", chk?.check_number)}
      ${fieldHtml("Payee (check)", chk?.payee)}
      ${fieldHtml("Check amount", money(chk?.amount_numeric))}
    </ul>
    <div class="card-actions">
      <button class="big-btn amber" id="save-pair-btn">Save &amp; Pair</button>
      <button class="big-btn ghost" id="pair-done-btn">Discard pair</button>
    </div>`;
  card.hidden = false;

  $("save-pair-btn").addEventListener("click", saveAndPair);
  $("pair-done-btn").addEventListener("click", () => setMode("pair"));
}

async function saveAndPair() {
  setBusy(true, "Pairing…");
  try {
    const res = await api("/api/transactions/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        check_doc_id: state.pair.checkId,
        invoice_doc_id: state.pair.invoiceId,
      }),
    });
    state.pair = { invoiceId: null, checkId: null, invoiceExt: null, checkExt: null };
    renderPaired(res.transaction);
    loadRecent();
  } catch (err) {
    setStatus("Pairing failed: " + (err.message || "unknown error"), true);
    updateCaptureUI();
  } finally {
    setBusy(false);
  }
}

function renderPaired(tx) {
  const card = $("result-card");
  card.innerHTML = `
    <div class="paired-confirm">
      <div class="big-check">✓</div>
      <div class="amount">${moneyCents(tx.amount)}</div>
      <p>${tx.vendor_payee || "Payment"} — check #${tx.check_number || "—"}</p>
      <p><span class="chip paired">paired</span> <span class="chip verified-note" style="display:none"></span></p>
    </div>
    <div class="card-actions">
      <button class="big-btn" data-done>Done</button>
    </div>`;
  card.hidden = false;
  card.querySelector("[data-done]").addEventListener("click", () => {
    hideCard();
    setStatus("");
    updateCaptureUI();
  });
}

function hideCard() {
  $("result-card").hidden = true;
  $("result-card").innerHTML = "";
}

// ---- recent list ------------------------------------------------------------

async function loadRecent() {
  const list = $("recent-list");
  try {
    const res = await api("/api/transactions?limit=6");
    const txs = res.transactions || [];
    if (!txs.length) {
      list.innerHTML = `<li class="recent-empty">No transactions yet — snap your first check.</li>`;
      return;
    }
    list.innerHTML = txs
      .map((t) => {
        const who = t.vendor_payee || "Unlabeled";
        const amt = moneyCents(t.amount);
        const d = t.transaction_date ? new Date(t.transaction_date).toLocaleDateString() : "";
        return `<li>
          <div>
            <strong>${who}</strong>
            <div class="hint" style="text-align:left;min-height:0">${d} · check #${t.check_number || "—"}</div>
          </div>
          <div>
            <span class="chip ${t.status}">${t.status}</span>
            <strong>${amt}</strong>
          </div>
        </li>`;
      })
      .join("");
  } catch {
    list.innerHTML = `<li class="recent-empty">Could not load recent.</li>`;
  }
}

// ---- export dialog -----------------------------------------------------------

const exportDialog = $("export-dialog");

$("export-open-btn").addEventListener("click", () => {
  $("export-status").textContent = "";
  exportDialog.showModal();
});

$("export-download-btn").addEventListener("click", async () => {
  const checked = document.querySelector('input[name="range"]:checked');
  const range = checked?.value || "month";
  const statusEl = $("export-status");
  const btn = $("export-download-btn");
  btn.disabled = true;
  statusEl.textContent = "Building package…";
  statusEl.classList.remove("error");
  try {
    const res = await fetch(`/api/exports/bundle?range=${range}`);
    if (!res.ok) {
      let msg = "Export failed";
      try {
        const j = await res.json();
        if (j?.error) msg = j.error === "unauthorized" ? "Session expired." : "Export failed";
      } catch {}
      throw new Error(msg);
    }
    const disposition = res.headers.get("Content-Disposition") || "";
    const m = disposition.match(/filename="?([^"]+)"?/);
    const filename = m?.[1] || "snap-accountant.zip";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    statusEl.textContent = "Downloaded — bundle saved to your accountant package.";
  } catch (err) {
    statusEl.textContent = err.message || "Export failed.";
    statusEl.classList.add("error");
  } finally {
    btn.disabled = false;
  }
});

// ---- misc ------------------------------------------------------------------

function setBusy(busy, msg) {
  state.busy = busy;
  $("capture-btn").disabled = busy;
  if (busy) {
    setStatus(msg || "Working…", false);
  }
}

function setStatus(msg, isError) {
  const el = $("status-line");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
}

init();