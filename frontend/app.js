// COUNTER.exe — frontend logic
(() => {
  // Same-origin: FE container proxies /api → api:8000 via docker network
  const API_BASE = "";

  const $ = (id) => document.getElementById(id);

  const counter   = $("counter");
  const numEl     = $("num");
  const incBtn    = $("inc");
  const decBtn    = $("dec");
  const resetBtn  = $("reset");
  const log       = $("log");
  const clock     = $("clock");

  let current = 0;
  let isLocked = false;

  // ---------- API ----------
  const api = {
    async get()    { return (await fetch(`${API_BASE}/api/count`)).json(); },
    async post(p)  { return (await fetch(`${API_BASE}${p}`, { method: "POST" })).json(); },
  };

  // ---------- Render ----------
  const pad = (n) => {
    // Always show 3+ digits, with sign for negatives
    const s = String(n);
    return s.startsWith("-") ? "-" + String(Math.abs(n)).padStart(3, "0") : s.padStart(3, "0");
  };

  const render = (n, mode = "idle") => {
    current = n;
    numEl.textContent = pad(n);
    counter.dataset.value = String(n);

    counter.classList.remove("is-bump", "is-minus", "is-reset");
    void counter.offsetWidth; // restart animation
    if (mode === "up")   counter.classList.add("is-bump");
    if (mode === "down") counter.classList.add("is-minus", "is-bump");
    if (mode === "reset")counter.classList.add("is-reset");
  };

  // ---------- Log feed ----------
  const logEvent = (msg, kind = "up") => {
    const el = document.createElement("span");
    el.className = `log__item log__item--${kind}`;
    const t = new Date().toTimeString().slice(0, 8);
    el.textContent = `[${t}] ${msg}`;
    log.prepend(el);
    // keep at most 5 entries
    while (log.children.length > 5) log.lastChild.remove();
  };

  // ---------- Actions ----------
  const safe = async (fn) => {
    if (isLocked) return;
    isLocked = true;
    try { await fn(); }
    finally { setTimeout(() => (isLocked = false), 120); }
  };

  const inc = () => safe(async () => {
    const { count } = await api.post("/api/increment");
    render(count, "up");
    logEvent(`+1 → ${pad(count)}`, "up");
    ripple(incBtn);
  });

  const dec = () => safe(async () => {
    const { count } = await api.post("/api/decrement");
    render(count, "down");
    logEvent(`-1 → ${pad(count)}`, "down");
  });

  const reset = () => safe(async () => {
    const { count } = await api.post("/api/reset");
    render(count, "reset");
    logEvent(`RESET → ${pad(count)}`, "rst");
  });

  // ---------- Ripple on click ----------
  const ripple = (el) => {
    const r = el.getBoundingClientRect();
    const d = Math.max(r.width, r.height);
    const node = document.createElement("span");
    node.className = "ripple";
    node.style.width = node.style.height = d + "px";
    node.style.left = (event.clientX - r.left - d / 2) + "px";
    node.style.top  = (event.clientY - r.top  - d / 2) + "px";
    el.appendChild(node);
    setTimeout(() => node.remove(), 700);
  };

  // ---------- Wire up ----------
  incBtn.addEventListener("click", inc);
  decBtn.addEventListener("click", dec);
  resetBtn.addEventListener("click", reset);

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); inc(); }
    else if (e.code === "ArrowDown") { e.preventDefault(); dec(); }
    else if (e.key.toLowerCase() === "r")           { e.preventDefault(); reset(); }
  });

  // Clock
  const tick = () => {
    const d = new Date();
    clock.textContent = d.toTimeString().slice(0, 8);
  };
  tick(); setInterval(tick, 1000);

  // Boot — fetch initial count
  api.get().then(({ count }) => render(count, "idle"))
          .catch(() => render(0, "idle"));
})();
