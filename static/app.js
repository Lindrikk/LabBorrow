/* LabBorrow front end: one page, views rendered into <main id="view">. */
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");
const state = { user: null, items: [], tab: null, modelLoaded: false, modelDirty: false, starterAdded: false };
let cleanup = null; // stops the camera / timers of the current view

const STABLE_FRAMES = 4;   // same item this many frames in a row = detected
const SCAN_INTERVAL = 300; // ms between AI checks

/* ---------------------------------------------------------------- utils */
async function api(path, method = "GET", body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (t) => (t ? new Date(t.replace(" ", "T")).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const pct = (x) => `${Math.round(x * 100)}%`;

let toastTimer;
function toast(msg, ms = 3000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function pill(status) {
  const text = { borrowed: "Borrowed", overdue: "Overdue", returned: "Returned" }[status] || status;
  return `<span class="pill ${status}">${text}</span>`;
}

async function ensureModel(statusEl) {
  if (state.modelLoaded) return;
  if (statusEl) statusEl.innerHTML = `<span class="spin"></span> Loading AI model…`;
  await Detector.load();
  const { model } = await api("/api/model");
  Detector.deserialize(model);
  state.starterAdded = !!(model && model.starter_added);
  state.modelLoaded = true;
}

async function loadItems() {
  state.items = (await api("/api/items")).items;
  return state.items;
}

/* ---------------------------------------------------------------- navigation */
const ICONS = {
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  home: '<path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>',
  brain: '<path d="M12 5a3 3 0 0 0-5.8 1A3 3 0 0 0 4 11a3 3 0 0 0 2 5 3 3 0 0 0 6 1V5zm0 0a3 3 0 0 1 5.8 1A3 3 0 0 1 20 11a3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 4 6.5"/>',
};
const TABS = {
  student: [["scan", "Scan", "scan"], ["mine", "My items", "list"], ["account", "Account", "user"]],
  admin: [["dashboard", "Dashboard", "home"], ["records", "Records", "list"], ["items", "Items", "box"], ["train", "Train AI", "brain"], ["students", "Students", "people"]],
};

function renderShell() {
  const u = state.user;
  $("#who").innerHTML = u ? `
    <button class="who-btn" id="whoBtn" title="Account settings"><b>${esc(u.full_name)}</b>${u.role === "admin" ? "Admin" : esc(u.student_no || "Student")} · Account</button>
    <button class="btn small" id="topLogout">Log out</button>` : "";
  if (u) {
    $("#whoBtn").onclick = () => go("account");
    $("#topLogout").onclick = logout;
  }
  const nav = $("#tabs");
  if (!u) { nav.hidden = true; return; }
  nav.hidden = false;
  nav.innerHTML = TABS[u.role].map(([id, label, icon]) =>
    `<button data-tab="${id}" class="${state.tab === id ? "on" : ""}">
       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>${label}
     </button>`).join("");
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) go(b.dataset.tab);
});

function go(tab) {
  if (state.tab === "train" && tab !== "train" && state.modelDirty &&
      !confirm("You have unsaved AI training. Leave without saving?")) {
    return;
  }
  if (cleanup) { cleanup(); cleanup = null; }
  if (tab !== "train") state.modelDirty = false;
  state.tab = tab;
  renderShell();
  window.scrollTo(0, 0);
  const views = { scan: viewScan, mine: viewMine, account: viewAccount, dashboard: viewDashboard,
                  records: viewRecords, items: viewItems, train: viewTrain, students: viewStudents };
  views[tab]().catch((err) => { view.innerHTML = `<div class="card error">${esc(err.message)}</div>`; });
}

function startApp() {
  go(state.user.role === "admin" ? "dashboard" : "scan");
}

/* ---------------------------------------------------------------- auth */
function viewAuth(mode = "login") {
  state.tab = null;
  renderShell();
  const reg = mode === "register";
  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  view.innerHTML = `
    <section class="intro">
      <div class="logos">
        <img src="school-logo.jpg" alt="Aurelio Arago Memorial National High School seal">
        <img src="starr-logo.png" alt="STEM STARR logo">
      </div>
      <p class="school">Aurelio Arago Memorial National High School</p>
      <p class="club">A STEM STARR Project</p>
      <h1>STEM STARR LabBorrow</h1>
      <p class="tagline">The laboratory equipment borrowing system of our school. Point your phone camera at an item and it is recorded for you.</p>
      <ul class="features">
        <li>${icon(ICONS.scan)}<span><b>Scan to borrow.</b> The AI recognises laboratory materials and records the borrow under your account automatically.</span></li>
        <li>${icon('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>')}<span><b>Scan to return.</b> Scan the same item again to return it, and keep track of what you still have.</span></li>
        <li>${icon('<path d="M12 3 4 7v5c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V7z"/><path d="m9 12 2 2 4-4"/>')}<span><b>Monitored by the lab admin.</b> Every borrow and return is logged with the student and time, and overdue items are flagged.</span></li>
      </ul>
    </section>
    <div class="card stack" style="max-width:420px;margin:0 auto">
      <div>
        <h1>${reg ? "Create student account" : "Log in"}</h1>
        <p class="sub">${reg ? "Students sign up here. Admin accounts are given by the laboratory in-charge." : "Use your LabBorrow student or admin account."}</p>
      </div>
      <div class="seg"><button data-m="login" class="${reg ? "" : "on"}">Log in</button><button data-m="register" class="${reg ? "on" : ""}">Sign up</button></div>
      <form id="authForm" class="stack">
        ${reg ? `
          <label class="field">Full name<input name="full_name" required autocomplete="name"></label>
          <div class="row">
            <label class="field grow">Student number<input name="student_no" autocomplete="off"></label>
            <label class="field grow">Section<input name="section" placeholder="e.g. 12-STEM A"></label>
          </div>` : ""}
        <label class="field">Username<input name="username" required autocapitalize="none" autocomplete="username"></label>
        <label class="field">Password<input name="password" type="password" required autocomplete="${reg ? "new-password" : "current-password"}"></label>
        <div class="error" id="authErr"></div>
        <button class="btn primary block">${reg ? "Create account" : "Log in"}</button>
      </form>
    </div>`;
  view.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => viewAuth(b.dataset.m)));
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      state.user = (await api(reg ? "/api/register" : "/api/login", "POST", body)).user;
      startApp();
    } catch (err) { $("#authErr").textContent = err.message; }
  };
}

async function viewAccount() {
  const u = state.user;
  view.innerHTML = `
    <h1>Account</h1>
    <div class="card stack">
      <div><div class="title"><b>${esc(u.full_name)}</b></div>
        <div class="hint">@${esc(u.username)} · ${u.role === "admin" ? "Admin" : `Student ${esc(u.student_no || "")} ${esc(u.section || "")}`}</div></div>
      <button class="btn block" id="logout">Log out</button>
    </div>
    <h2>Change password</h2>
    <form class="card stack" id="pw">
      <label class="field">Current password<input name="old_password" type="password" required></label>
      <label class="field">New password<input name="new_password" type="password" required minlength="6"></label>
      <div class="error" id="pwErr"></div>
      <button class="btn primary">Update password</button>
    </form>`;
  $("#logout").onclick = logout;
  $("#pw").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/change-password", "POST", Object.fromEntries(new FormData(e.target)));
      e.target.reset(); toast("Password updated");
    } catch (err) { $("#pwErr").textContent = err.message; }
  };
}

async function logout() {
  if (cleanup) { cleanup(); cleanup = null; }
  await api("/api/logout", "POST");
  state.user = null; state.modelLoaded = false;
  viewAuth();
}

/* ---------------------------------------------------------------- camera widget */
/* Builds a camera box that runs the detector on every frame and calls onFrame(prediction). */
function cameraBox(container, { onFrame }) {
  container.innerHTML = `
    <div class="cam">
      <video playsinline muted></video>
      <div class="frame"><div class="frame-small"></div></div>
      <div class="placeholder" id="camPh"></div>
      <div class="label" hidden><span id="camLabel"></span><span id="camConf"></span></div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn grow" id="camToggle">Start camera</button>
      <label class="btn grow">Use a photo<input type="file" accept="image/*" capture="environment" id="camFile" hidden></label>
    </div>
    <label class="zoom" id="camZoom" hidden>Zoom <input type="range" id="camZoomRange"></label>
    <p class="hint" style="margin:8px 0 0">Small items like test tubes: hold them inside the small inner square, or use Zoom.</p>`;
  const video = $("video", container), box = $(".cam", container), ph = $("#camPh", container);
  const labelBar = $(".label", container), toggle = $("#camToggle", container);
  let timer = null, running = false, paused = false;

  function showPrediction(p) {
    labelBar.hidden = false;
    if (!p) { $("#camLabel", container).textContent = "AI not trained yet"; $("#camConf", container).textContent = ""; return; }
    $("#camLabel", container).textContent = p.accepted ? p.label : "No lab item detected";
    $("#camConf", container).textContent = p.accepted ? pct(p.confidence) : "";
    box.classList.toggle("hit", p.accepted);
  }

  async function start() {
    if (!Camera.supported()) {
      ph.textContent = "Live camera needs HTTPS (or localhost). Use \"Use a photo\" instead, or run the server with --https.";
      return;
    }
    try {
      ph.innerHTML = `<span><span class="spin"></span> Starting camera…</span>`;
      await ensureModel(ph);
      await Camera.start(video);
      ph.textContent = "";
      running = true; toggle.textContent = "Stop camera";
      const zoom = Camera.zoomRange(), zoomRow = $("#camZoom", container), range = $("#camZoomRange", container);
      zoomRow.hidden = !zoom;
      if (zoom) {
        Object.assign(range, { min: zoom.min, max: Math.min(zoom.max, zoom.min * 5), step: zoom.step || 0.1, value: zoom.min });
        range.oninput = () => Camera.setZoom(Number(range.value));
      }
      timer = setInterval(() => {
        if (paused || video.readyState < 2) return;
        const p = Detector.predictFrame(video);
        showPrediction(p);
        onFrame(p);
      }, SCAN_INTERVAL);
    } catch (err) {
      ph.textContent = `Camera unavailable: ${err.message}. You can still use a photo.`;
    }
  }
  function stop() {
    clearInterval(timer); timer = null; running = false;
    Camera.stop(); video.srcObject = null; toggle.textContent = "Start camera";
    $("#camZoom", container).hidden = true;
    labelBar.hidden = true; box.classList.remove("hit");
    ph.textContent = "Camera stopped";
  }
  toggle.onclick = () => (running ? stop() : start());

  $("#camFile", container).onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (running) stop();
    try {
      await ensureModel(ph);
      const img = await fileToImage(file);
      ph.textContent = "";
      video.hidden = true;
      box.querySelector("img.still")?.remove();
      img.className = "still";
      box.prepend(img);
      const p = Detector.predictFrame(img);
      showPrediction(p);
      onFrame(p, { photo: true, image: img });
    } catch (err) { toast(err.message); }
  };

  return {
    video,
    start,
    stop,
    pause(v) { paused = v; },
    destroy() { clearInterval(timer); Camera.stop(); },
    resetPhoto() { box.querySelector("img.still")?.remove(); video.hidden = false; },
  };
}

/* ---------------------------------------------------------------- student: scan */
async function viewScan() {
  let mode = "borrow", streakKey = null, streak = 0, busy = false;
  view.innerHTML = `
    <h1>Scan a lab item</h1>
    <p class="sub">Point the camera at one item inside the frame. It is recorded automatically once recognised.</p>
    <div class="seg" style="margin-bottom:12px"><button data-mode="borrow" class="on">Borrow</button><button data-mode="return">Return</button></div>
    <div id="camArea"></div>
    <div class="meter" style="background:var(--surface-2)"><i id="lock"></i></div>
    <div id="result" style="margin-top:12px"></div>`;
  view.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => {
    mode = b.dataset.mode;
    view.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
    $("#result").innerHTML = "";
  }));

  const cam = cameraBox($("#camArea"), {
    onFrame(p, opts = {}) {
      if (busy) return;
      if (opts.photo) {
        if (p && p.accepted) record(p);
        else showResult(false, p ? "This photo was not recognised as a laboratory item. Try again closer, with better light." : "The AI has not been trained yet. Ask the admin to train it.");
        return;
      }
      if (p && p.accepted && p.key === streakKey) streak++;
      else { streakKey = p && p.accepted ? p.key : null; streak = streakKey ? 1 : 0; }
      $("#lock").style.width = `${(Math.min(streak, STABLE_FRAMES) / STABLE_FRAMES) * 100}%`;
      if (streak >= STABLE_FRAMES) record(p);
    },
  });
  cleanup = () => cam.destroy();
  cam.start();

  function showResult(ok, html, actions = "") {
    $("#result").innerHTML = `<div class="card result ${ok ? "" : "bad"} stack"><div>${html}</div>${actions ? `<div class="row">${actions}</div>` : ""}</div>`;
  }

  function scanNext() {
    busy = false; streak = 0; streakKey = null;
    $("#lock").style.width = "0";
    $("#result").innerHTML = "";
    cam.resetPhoto();
    cam.pause(false);
  }

  async function record(p) {
    busy = true; cam.pause(true);
    if (navigator.vibrate) navigator.vibrate(80);
    try {
      if (mode === "borrow") {
        const { borrow, undo_seconds } = await api("/api/borrow", "POST", { item_id: p.itemId, confidence: p.confidence });
        let left = undo_seconds;
        showResult(true,
          `<b>${esc(borrow.item_name)}</b> recorded as borrowed.<div class="hint">Due ${fmt(borrow.due_at)} · AI confidence ${pct(p.confidence)}</div>`,
          `<button class="btn" id="undo">Undo (${left}s)</button><button class="btn primary grow" id="next">Scan next item</button>`);
        const tick = setInterval(() => {
          left--;
          const u = $("#undo");
          if (!u) return clearInterval(tick);
          if (left <= 0) { clearInterval(tick); u.remove(); } else u.textContent = `Undo (${left}s)`;
        }, 1000);
        $("#undo").onclick = async () => {
          clearInterval(tick);
          try { await api(`/api/borrow/${borrow.id}/undo`, "POST"); toast("Borrow cancelled"); scanNext(); }
          catch (err) { toast(err.message); }
        };
        $("#next").onclick = () => { clearInterval(tick); scanNext(); };
      } else {
        const { borrow } = await api("/api/return", "POST", { item_id: p.itemId });
        showResult(true, `<b>${esc(borrow.item_name)}</b> returned. Thank you!`,
          `<button class="btn primary grow" id="next">Scan next item</button>`);
        $("#next").onclick = scanNext;
      }
    } catch (err) {
      showResult(false, `<b>${esc(p.label)}</b>: ${esc(err.message)}`, `<button class="btn primary grow" id="next">Scan again</button>`);
      $("#next").onclick = scanNext;
    }
  }
}

/* ---------------------------------------------------------------- student: my items */
async function viewMine() {
  const { borrows } = await api("/api/my-borrows");
  const active = borrows.filter((b) => b.status !== "returned");
  const done = borrows.filter((b) => b.status === "returned");
  const li = (b) => `<li><div class="main"><div class="title">${esc(b.item_name)}</div>
      <div class="meta">Borrowed ${fmt(b.borrowed_at)} · ${b.returned_at ? `Returned ${fmt(b.returned_at)}` : `Due ${fmt(b.due_at)}`}</div></div>${pill(b.status)}</li>`;
  view.innerHTML = `
    <h1>My borrowed items</h1>
    <p class="sub">To return an item, go to Scan → Return and scan it.</p>
    <div class="card">${active.length ? `<ul class="list">${active.map(li).join("")}</ul>` : `<div class="empty">You have no borrowed items.</div>`}</div>
    <h2>History</h2>
    <div class="card">${done.length ? `<ul class="list">${done.map(li).join("")}</ul>` : `<div class="empty">No returned items yet.</div>`}</div>`;
}

/* ---------------------------------------------------------------- admin: dashboard */
async function viewDashboard() {
  async function draw() {
    const [s, { borrows }] = await Promise.all([api("/api/admin/summary"), api("/api/admin/borrows?status=active")]);
    borrows.sort((a, b) => (a.status === "overdue" ? -1 : 0) - (b.status === "overdue" ? -1 : 0));
    view.innerHTML = `
      <h1>Dashboard</h1>
      <p class="sub">Live view of borrowed laboratory materials. Refreshes every 15 seconds.</p>
      <div class="stats">
        <div class="stat"><div class="n">${s.borrowed}</div><div class="k">Currently borrowed</div></div>
        <div class="stat ${s.overdue ? "alert" : ""}"><div class="n">${s.overdue}</div><div class="k">Overdue</div></div>
        <div class="stat"><div class="n">${s.returned_today}</div><div class="k">Returned today</div></div>
        <div class="stat"><div class="n">${s.students}</div><div class="k">Students</div></div>
      </div>
      <h2>Not yet returned</h2>
      <div class="card">${borrows.length ? `<ul class="list">${borrows.map(borrowRow).join("")}</ul>` : `<div class="empty">Everything has been returned.</div>`}</div>
      <h2>Stock</h2>
      <div class="card"><ul class="list">${s.items.map((i) => `<li><div class="main"><div class="title">${esc(i.name)}</div>
        <div class="meta">${esc(i.category || "")}</div></div><span class="pill ${i.available > 0 ? "neutral" : "overdue"}">${i.available}/${i.quantity} available</span></li>`).join("")}</ul></div>`;
    bindReturnButtons(draw);
  }
  await draw();
  const t = setInterval(() => draw().catch(() => {}), 15000);
  cleanup = () => clearInterval(t);
}

function borrowRow(b) {
  return `<li><div class="main"><div class="title">${esc(b.item_name)} · ${esc(b.full_name)}</div>
    <div class="meta">${esc(b.student_no || b.username)}${b.section ? " · " + esc(b.section) : ""} · borrowed ${fmt(b.borrowed_at)} ·
      ${b.returned_at ? `returned ${fmt(b.returned_at)}` : `due ${fmt(b.due_at)}`}</div></div>
    ${b.returned_at ? pill("returned") : `${pill(b.status)} <button class="btn small" data-return="${b.id}">Mark returned</button>`}</li>`;
}

function bindReturnButtons(redraw) {
  view.querySelectorAll("[data-return]").forEach((btn) => (btn.onclick = async () => {
    try { await api("/api/return", "POST", { borrow_id: Number(btn.dataset.return) }); toast("Marked as returned"); redraw(); }
    catch (err) { toast(err.message); }
  }));
}

/* ---------------------------------------------------------------- admin: records */
async function viewRecords() {
  let filter = "all", q = "";
  const { borrows } = await api("/api/admin/borrows");
  view.innerHTML = `
    <h1>Borrow records</h1>
    <p class="sub">Every borrow and return, newest first.</p>
    <div class="row" style="margin-bottom:10px">
      <input class="grow" id="q" placeholder="Search student or item" style="padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface)">
      <button class="btn" id="csv">Export CSV</button>
    </div>
    <div class="chips" id="chips">${["all", "borrowed", "overdue", "returned"].map((f) =>
      `<button data-f="${f}" class="${f === filter ? "on" : ""}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}</div>
    <div class="card" style="margin-top:10px" id="recList"></div>`;
  const rows = () => borrows.filter((b) => (filter === "all" || b.status === filter) &&
    (`${b.full_name} ${b.username} ${b.item_name} ${b.student_no} ${b.section}`).toLowerCase().includes(q));
  const draw = () => {
    const r = rows();
    $("#recList").innerHTML = r.length ? `<ul class="list">${r.map(borrowRow).join("")}</ul>` : `<div class="empty">No records.</div>`;
    bindReturnButtons(() => go("records"));
  };
  $("#chips").onclick = (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    filter = b.dataset.f;
    view.querySelectorAll("#chips button").forEach((x) => x.classList.toggle("on", x === b));
    draw();
  };
  $("#q").oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  $("#csv").onclick = () => {
    const cols = ["item_name", "full_name", "student_no", "section", "borrowed_at", "due_at", "returned_at", "status"];
    const csv = [cols.join(","), ...rows().map((b) => cols.map((c) => `"${String(b[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `lab-borrows-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
  draw();
}

/* ---------------------------------------------------------------- admin: items */
async function viewItems() {
  await loadItems();
  view.innerHTML = `
    <h1>Laboratory items</h1>
    <p class="sub">Add every item type here, then teach the AI to recognise it in <b>Train AI</b>.</p>
    <form class="card stack" id="add">
      <label class="field">Item name<input name="name" required placeholder="e.g. Beaker 250 mL"></label>
      <div class="row">
        <label class="field grow">Category<input name="category" placeholder="Glassware"></label>
        <label class="field" style="width:110px">Quantity<input name="quantity" type="number" min="0" value="1"></label>
      </div>
      <div class="error" id="addErr"></div>
      <button class="btn primary">Add item</button>
    </form>
    <h2>All items</h2>
    <div class="card"><ul class="list" id="itemList"></ul></div>`;
  const draw = () => {
    $("#itemList").innerHTML = state.items.map((i) => `
      <li><div class="main"><div class="title">${esc(i.name)}</div>
        <div class="meta">${esc(i.category || "No category")} · ${i.borrowed} borrowed · AI samples: ${Detector.count(String(i.id)) || (state.modelLoaded ? 0 : "?")}</div></div>
        <input class="qty" type="number" min="0" value="${i.quantity}" data-qty="${i.id}" aria-label="Quantity">
        <button class="btn small danger" data-del="${i.id}">Delete</button></li>`).join("");
    view.querySelectorAll("[data-qty]").forEach((inp) => (inp.onchange = async () => {
      try { state.items = (await api(`/api/items/${inp.dataset.qty}`, "PUT", { quantity: Number(inp.value) })).items; toast("Quantity saved"); draw(); }
      catch (err) { toast(err.message); }
    }));
    view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Delete this item?")) return;
      try { state.items = (await api(`/api/items/${b.dataset.del}`, "DELETE")).items; draw(); }
      catch (err) { toast(err.message, 5000); }
    }));
  };
  $("#add").onsubmit = async (e) => {
    e.preventDefault();
    try {
      state.items = (await api("/api/items", "POST", Object.fromEntries(new FormData(e.target)))).items;
      e.target.reset(); $("#addErr").textContent = ""; draw();
    } catch (err) { $("#addErr").textContent = err.message; }
  };
  draw();
}

/* ---------------------------------------------------------------- admin: train AI */
async function viewTrain() {
  await loadItems();
  view.innerHTML = `
    <h1>Train the AI</h1>
    <p class="sub">Pick an item, point the camera at it and <b>hold</b> the capture button while slowly turning the item.
      Aim for 40+ samples per item (each capture saves a normal and a zoomed-in view) from different angles, distances and lighting. Include the item held far away too. Also train <b>Not a lab item</b>
      with hands, faces, phones, bags and the empty table so the app ignores non-lab objects.</p>
    <div class="card stack">
      <label class="field">Teaching item
        <select id="cls">
          ${state.items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("")}
          <option value="${UNKNOWN}">✕ Not a lab item (background, hands, people…)</option>
        </select>
      </label>
      <div id="camArea"></div>
      <div class="row">
        <button class="btn primary grow" id="hold" style="touch-action:none;user-select:none">Hold to capture</button>
        <label class="btn">Add photos<input type="file" accept="image/*" multiple id="photos" hidden></label>
      </div>
      <div class="hint" id="status"></div>
    </div>
    <h2>Starter AI</h2>
    <div class="card stack" id="starter"><div class="hint">Checking…</div></div>
    <h2>Samples per class</h2>
    <div class="card"><ul class="list" id="counts"></ul></div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="save">Save AI model</button>
    </div>
    <p class="hint">The camera box also shows a live prediction, so you can test the AI while training.</p>`;

  const status = $("#status");
  await ensureModel(status);
  status.textContent = "AI ready.";
  const cam = cameraBox($("#camArea"), { onFrame() {} });
  cleanup = () => { cam.destroy(); clearInterval(holdTimer); };
  cam.start();

  const selected = () => {
    const key = $("#cls").value;
    if (key === UNKNOWN) return { key, label: "Not a lab item", itemId: null };
    const item = state.items.find((i) => String(i.id) === key);
    return { key, label: item.name, itemId: item.id };
  };

  function drawCounts() {
    const rows = [...state.items.map((i) => ({ key: String(i.id), label: i.name })), { key: UNKNOWN, label: "Not a lab item" }];
    $("#counts").innerHTML = rows.map((r) => {
      const n = Detector.count(r.key);
      return `<li><div class="main"><div class="title">${esc(r.label)}</div></div>
        <span class="pill ${n >= 40 ? "returned" : n ? "borrowed" : "neutral"}">${n} samples</span>
        ${n ? `<button class="btn small danger" data-clear="${r.key}">Clear</button>` : ""}</li>`;
    }).join("");
    view.querySelectorAll("[data-clear]").forEach((b) => (b.onclick = () => {
      if (!confirm("Delete all samples for this class?")) return;
      Detector.clearClass(b.dataset.clear); state.modelDirty = true; drawCounts();
    }));
  }
  drawCounts();
  drawStarterCard(() => go("train")); // re-render so new items appear in the list and dropdown

  let holdTimer = null;
  const hold = $("#hold");
  const capture = () => {
    if (cam.video.readyState < 2) return;
    const s = selected();
    const n = Detector.addFrameSamples(s.key, s.label, s.itemId, cam.video);
    state.modelDirty = true;
    hold.textContent = `Capturing… ${n}`;
  };
  hold.onpointerdown = (e) => {
    e.preventDefault();
    if (!Camera.stream) { toast("Start the camera first (or use Add photos)"); return; }
    capture();
    holdTimer = setInterval(capture, 150);
  };
  const release = () => {
    if (!holdTimer) return;
    clearInterval(holdTimer); holdTimer = null;
    hold.textContent = "Hold to capture";
    drawCounts();
  };
  hold.onpointerup = hold.onpointerleave = hold.onpointercancel = release;

  $("#photos").onchange = async (e) => {
    const s = selected();
    const files = [...e.target.files];
    e.target.value = "";
    for (const [i, f] of files.entries()) {
      status.textContent = `Adding photo ${i + 1} of ${files.length}…`;
      Detector.addFrameSamples(s.key, s.label, s.itemId, await fileToImage(f));
    }
    state.modelDirty = true;
    status.textContent = `Added ${files.length} photo(s) to ${s.label}.`;
    drawCounts();
  };

  $("#save").onclick = async () => {
    const btn = $("#save");
    btn.disabled = true;
    try {
      await trainAndSave((p) => (btn.textContent = `Training AI… ${pct(p)}`));
      toast("AI model trained and saved. Students will use it on their next scan.");
    } catch (err) { toast(err.message, 5000); }
    btn.disabled = false; btn.textContent = "Save AI model";
  };
}

async function trainAndSave(onProgress) {
  await Detector.train({ onProgress });
  await api("/api/model", "POST", { ...Detector.serialize(), starter_added: state.starterAdded });
  state.modelDirty = false;
}

/* ---------------------------------------------------------------- admin: starter AI */
/* The starter AI (static/starter_model.json) holds fingerprints of free example photos of
   standard lab equipment, keyed by item name, so a new install recognises them out of the box. */
const STARTER_CATEGORIES = {
  "Beaker": "Glassware", "Erlenmeyer Flask": "Glassware", "Test Tube": "Glassware", "Graduated Cylinder": "Glassware",
  "Volumetric Flask": "Glassware", "Round-bottom Flask": "Glassware", "Funnel": "Glassware", "Watch Glass": "Glassware",
  "Bunsen Burner": "Heating", "Tripod Stand": "Heating", "Crucible Tongs": "Tools", "Test Tube Rack": "Tools",
  "Spatula": "Tools", "Mortar and Pestle": "Tools", "Thermometer": "Measuring", "Pipette": "Measuring",
  "Burette": "Measuring", "Dropper": "Measuring", "Petri Dish": "Biology", "Triple Beam Balance": "Measuring",
  "Microscope": "Optics", "Magnifying Glass": "Optics", "Microscope Slide": "Optics",
};

async function drawStarterCard(onChange) {
  const card = $("#starter");
  const [starter, photos] = await Promise.all([
    fetch("starter_model.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    api("/api/admin/pretrain-images").then((d) => d.classes).catch(() => ({})),
  ]);
  const nPhotos = Object.values(photos).reduce((a, f) => a + f.length, 0);
  const items = starter ? Object.keys(starter.classes).filter((k) => k !== UNKNOWN) : [];
  card.innerHTML = `
    ${starter ? `<div>Recognises <b>${items.length} standard lab items</b> out of the box, learned from free example photos.
      ${starter.accuracy != null ? `Accuracy on test photos it never saw: <b>${pct(starter.accuracy)}</b>.` : ""}</div>
      <div class="hint">Adding it creates any missing items (quantity 1, so set real quantities in Items) and keeps your own training.
      Web photos look different from your lab, so still add 10–20 camera samples of your real items for best results.</div>
      <button class="btn primary" id="addStarter" ${state.starterAdded ? "disabled" : ""}>${state.starterAdded ? "Starter AI added ✓" : "Add starter AI"}</button>`
      : `<div class="hint">No starter AI yet.</div>`}
    ${nPhotos ? `<button class="btn" id="buildStarter">Rebuild starter AI from ${nPhotos} downloaded photos</button>` : ""}
    <div class="hint" id="starterStatus"></div>`;
  const status = $("#starterStatus");
  if ($("#addStarter")) $("#addStarter").onclick = async (e) => {
    e.target.disabled = true;
    try { await addStarter(starter, status); onChange(); toast("Starter AI added and saved"); drawStarterCard(onChange); }
    catch (err) { status.textContent = err.message; e.target.disabled = false; }
  };
  if ($("#buildStarter")) $("#buildStarter").onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await buildStarter(photos, status); toast(`Starter AI rebuilt (${pct(r.accuracy)} test accuracy)`); drawStarterCard(onChange); }
    catch (err) { status.textContent = err.message; e.target.disabled = false; }
  };
}

async function addStarter(starter, status) {
  status.textContent = "Adding starter AI…";
  await loadItems();
  for (const [name, c] of Object.entries(starter.classes)) {
    let key = UNKNOWN, itemId = null, label = "Not a lab item";
    if (name !== UNKNOWN) {
      const find = () => state.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
      if (!find()) state.items = (await api("/api/items", "POST", { name, category: c.category, quantity: 1 })).items;
      const item = find();
      key = String(item.id); itemId = item.id; label = item.name;
    }
    if (!Detector.classes[key]) Detector.classes[key] = { label, itemId, samples: [] };
    Detector.classes[key].samples.push(...c.samples.map(decodeSample));
  }
  state.starterAdded = true;
  await trainAndSave((p) => (status.textContent = `Training AI… ${pct(p)}`));
  status.textContent = "";
}

/* Turns the downloaded photos into fingerprints, measures accuracy on held-out photos, saves starter_model.json.
   Each photo is also learned mirrored, so the AI copes with items facing either way. */
function mirrored(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext("2d");
  x.translate(c.width, 0); x.scale(-1, 1); x.drawImage(img, 0, 0);
  return c;
}

async function buildStarter(photos, status, { holdout = true } = {}) {
  const total = Object.values(photos).reduce((a, f) => a + f.length, 0);
  const emb = {}; // name -> [[original, mirrored], ...] one entry per photo
  const seen = [];
  let done = 0, dupes = 0;
  for (const [name, files] of Object.entries(photos)) {
    emb[name] = [];
    for (const f of files) {
      try {
        const img = await urlToImage(`/pretrain/${encodeURIComponent(name)}/${encodeURIComponent(f)}`);
        const e = Float32Array.from(Detector.embed(img));
        // the same picture filed under two items would teach the AI nonsense: keep the first only
        if (seen.some(([n, o]) => n !== name && dot(o, e) > 0.97)) { dupes++; continue; }
        seen.push([name, e]);
        emb[name].push([e, Float32Array.from(Detector.embed(mirrored(img)))]);
      } catch { /* skip unreadable photo */ }
      if (++done % 10 === 0) { status.textContent = `Learning photos… ${done}/${total}`; await yieldNow(); }
    }
  }
  const saved = { classes: Detector.classes, head: Detector.head, stale: Detector.headStale };
  const asClasses = (pick) => {
    const out = {};
    for (const [name, list] of Object.entries(emb)) {
      const samples = list.filter((_, i) => pick(i)).flat();
      if (samples.length) out[name] = { label: name, itemId: name, samples };
    }
    return out;
  };
  let accuracy = null, perClass = {}, testCount = 0;
  try {
    if (holdout) { // every 5th photo is kept aside to test the AI on photos it never saw
      status.textContent = "Testing accuracy…";
      Detector.classes = asClasses((i) => i % 5 !== 4);
      await Detector.train();
      let correct = 0;
      for (const [name, list] of Object.entries(emb)) {
        list.forEach(([e], i) => {
          if (i % 5 !== 4) return;
          const p = Detector.predictEmbedding(e);
          const ok = name === UNKNOWN ? !p.accepted : p.accepted && p.key === name;
          const pc = (perClass[name] ||= { n: 0, ok: 0, guesses: {} });
          pc.n++; pc.ok += ok; correct += ok; testCount++;
          if (!ok) { const g = p.accepted ? p.key : "rejected"; pc.guesses[g] = (pc.guesses[g] || 0) + 1; }
        });
      }
      accuracy = correct / testCount;
    }
  } finally {
    Detector.classes = saved.classes; Detector.head = saved.head; Detector.headStale = saved.stale;
  }
  const model = { version: 3, accuracy, test_photos: testCount, duplicates_removed: dupes, per_class: perClass, classes: {} };
  for (const [name, c] of Object.entries(asClasses(() => true))) {
    model.classes[name] = { category: STARTER_CATEGORIES[name] || "", samples: c.samples.map(encodeSample) };
  }
  status.textContent = "Saving starter AI…";
  await api("/api/admin/starter-model", "POST", model);
  status.textContent = "";
  return model;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------------------------------------------------------- admin: students */
async function viewStudents() {
  const { students } = await api("/api/admin/students");
  view.innerHTML = `
    <h1>Students</h1>
    <p class="sub">${students.length} registered student account(s).</p>
    <div class="card">${students.length ? `<ul class="list">${students.map((s) => `
      <li><div class="main"><div class="title">${esc(s.full_name)}</div>
        <div class="meta">@${esc(s.username)} · ${esc(s.student_no || "no student no.")} · ${esc(s.section || "no section")} · ${s.total} total borrows</div></div>
        <span class="pill ${s.active ? "borrowed" : "neutral"}">${s.active} active</span></li>`).join("")}</ul>`
      : `<div class="empty">No students yet. Students create their own accounts from the Sign up screen.</div>`}</div>`;
}

/* ---------------------------------------------------------------- boot */
window.addEventListener("beforeunload", (e) => { if (state.modelDirty) { e.preventDefault(); e.returnValue = ""; } });

(async () => {
  try {
    state.user = (await api("/api/me")).user;
  } catch { state.user = null; }
  if (state.user) startApp(); else viewAuth();
})();
