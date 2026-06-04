(() => {
  const API = "";
  const fmt = (n) => n == null ? "—" : Number(n).toLocaleString("vi-VN") + " ₫";
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const $ = (id) => document.getElementById(id);

  let currentPage = 1;
  let searchDest = "";
  let searchTimer = null;

  // ── Fetch stats ──────────────────────────────────────
  async function loadStats() {
    try {
      const res = await fetch(`${API}/api/dashboard/stats`);
      const d = await res.json();
      renderStats(d);
      renderTopDestinations(d.topDestinations || []);
      renderActivityChart(d.dailyPlans || []);
    } catch (e) {
      console.error("Stats error:", e);
    }
  }

  function renderStats(d) {
    const set = (id, val) => { const el = $(id); if (el) { el.textContent = val; el.closest(".dash-card")?.classList.remove("dash-card--loading"); } };
    set("stat-total",      d.totalPlans?.toLocaleString("vi-VN") ?? "0");
    set("stat-dests",      d.uniqueDestinations?.toLocaleString("vi-VN") ?? "0");
    set("stat-people",     d.totalPeople?.toLocaleString("vi-VN") ?? "0");
    set("stat-within",     d.withinBudgetRate != null ? d.withinBudgetRate + "%" : "—");
    set("stat-avg-budget", d.avgBudget ? fmt(d.avgBudget) : "—");
    set("stat-avg-cost",   d.avgCost   ? fmt(d.avgCost)   : "—");
  }

  function renderTopDestinations(list) {
    const el = $("top-destinations");
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="dash-empty">Chưa có dữ liệu</div>'; return; }
    const max = list[0].count;
    el.innerHTML = list.map((item, i) => `
      <div class="dash-dest-row">
        <div>
          <div class="dash-dest-row__name">${i + 1}. ${escHtml(item.name)}</div>
          <div class="dash-dest-row__bar-wrap">
            <div class="dash-dest-row__bar" style="width:${Math.round(item.count / max * 100)}%"></div>
          </div>
        </div>
        <div class="dash-dest-row__count">${item.count} lịch trình</div>
      </div>`).join("");
  }

  function renderActivityChart(list) {
    const el = $("activity-chart");
    if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="dash-empty">Chưa có dữ liệu</div>'; return; }
    const max = Math.max(...list.map(r => r.count), 1);
    const CHART_H = 120; // px available for bars
    el.innerHTML = list.map(r => {
      const pct = Math.round(r.count / max * 100);
      const h = Math.max(4, Math.round(pct / 100 * CHART_H));
      const label = r.day ? r.day.slice(5) : ""; // MM-DD
      return `
        <div class="dash-chart__bar-wrap">
          <div class="dash-chart__bar" style="height:${h}px" data-tip="${r.day}: ${r.count} lịch trình"></div>
          <span class="dash-chart__label">${label}</span>
        </div>`;
    }).join("");
  }

  // ── Fetch plans table ────────────────────────────────
  async function loadPlans(page = 1) {
    currentPage = page;
    const tbody = $("plans-tbody");
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="dash-empty">Đang tải…</td></tr>`;
    try {
      const params = new URLSearchParams({ page, limit: 15 });
      if (searchDest) params.set("destination", searchDest);
      const res = await fetch(`${API}/api/plans?${params}`);
      const d = await res.json();
      renderTable(d.items || []);
      renderPagination(d.total, d.page, d.limit);
    } catch (e) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="dash-empty">Lỗi tải dữ liệu</td></tr>`;
    }
  }

  function renderTable(items) {
    const tbody = $("plans-tbody");
    if (!tbody) return;
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="dash-empty">Không có lịch trình nào</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(p => {
      const prefs = (p.preferences || []).slice(0, 3)
        .map(pr => `<span class="dash-badge dash-badge--pref">${escHtml(pr)}</span>`).join("");
      const status = p.withinBudget
        ? `<span class="dash-badge dash-badge--ok">✅ Trong ngân sách</span>`
        : `<span class="dash-badge dash-badge--over">⚠️ Vượt ngân sách</span>`;
      return `<tr>
        <td><span class="dash-dest-link" data-id="${p.id}">${escHtml(p.destination)}</span></td>
        <td>${escHtml(p.duration || "")}</td>
        <td>${p.people ?? "—"}</td>
        <td>${p.budget ? fmt(p.budget) : "—"}</td>
        <td>${p.totalCost ? fmt(p.totalCost) : "—"}</td>
        <td>${prefs || '<span style="color:var(--text-dim)">—</span>'}</td>
        <td>${status}</td>
        <td style="white-space:nowrap;font-size:.78rem;color:var(--text-muted)">${fmtDate(p.createdAt)}</td>
        <td style="white-space:nowrap">
          <button class="dash-action-btn" data-view="${p.id}">Xem</button>
          <button class="dash-action-btn dash-action-btn--danger" data-del="${p.id}">Xóa</button>
        </td>
      </tr>`;
    }).join("");
  }

  function renderPagination(total, page, limit) {
    const el = $("pagination");
    if (!el) return;
    const totalPages = Math.ceil(total / limit);
    if (totalPages <= 1) { el.innerHTML = ""; return; }
    let html = "";
    if (page > 1) html += `<button class="dash-page-btn" data-pg="${page - 1}">← Trước</button>`;
    const start = Math.max(1, page - 2);
    const end   = Math.min(totalPages, page + 2);
    for (let i = start; i <= end; i++) {
      html += `<button class="dash-page-btn${i === page ? " dash-page-btn--active" : ""}" data-pg="${i}">${i}</button>`;
    }
    if (page < totalPages) html += `<button class="dash-page-btn" data-pg="${page + 1}">Sau →</button>`;
    el.innerHTML = html;
  }

  // ── Plan detail modal ────────────────────────────────
  async function openModal(planId) {
    try {
      const res = await fetch(`${API}/api/plans/${planId}`);
      const p = await res.json();
      const modal = $("plan-modal");
      const body = $("modal-body");
      const title = $("modal-title");
      if (!modal || !body) return;

      if (title) title.textContent = `📍 ${p.destination || "Lịch trình"}`;

      const rows = [
        ["Điểm đến", p.destination],
        ["Thời gian", p.duration],
        ["Số người", p.people],
        ["Ngân sách", fmt(p.budget)],
        ["Chi phí thực", fmt(p.totalCost)],
        ["Trạng thái", p.withinBudget ? "✅ Trong ngân sách" : "⚠️ Vượt ngân sách"],
        ["Sở thích", (p.preferences || []).join(", ") || "—"],
        ["Ngày tạo", fmtDate(p.createdAt)],
        ["Prompt gốc", p.prompt || "—"],
      ];

      const rowsHtml = rows.map(([l, v]) =>
        `<div class="modal-row"><span class="modal-row__label">${l}</span><span class="modal-row__val">${escHtml(String(v ?? "—"))}</span></div>`
      ).join("");

      const budget = p.budgetSummary || {};
      const budgetHtml = `
        <hr class="modal-divider"/>
        <div style="font-weight:700;font-size:.875rem;margin-bottom:.5rem">💼 Ngân sách chi tiết</div>
        ${[
          ["Khách sạn", budget.hotel], ["Ăn uống", budget.food], ["Cafe", budget.cafe],
          ["Vé tham quan", budget.tickets], ["Di chuyển", budget.transport], ["Dự phòng", budget.backup],
          ["Tổng", budget.total],
        ].map(([l, v]) => `<div class="modal-row"><span class="modal-row__label">${l}</span><span class="modal-row__val">${fmt(v)}</span></div>`).join("")}`;

      const itineraryHtml = (p.itinerary || []).map(day => `
        <div class="modal-day-block">
          <div class="modal-day-title">Ngày ${day.day} — ${escHtml(day.title || "")}</div>
          ${(day.items || []).map(item => `
            <div class="modal-item-row">
              <span class="modal-item-time">${item.time || ""}</span>
              <span class="modal-item-name">${escHtml(item.name || "")}</span>
              <span class="modal-item-cost">${item.estimatedCost ? fmt(item.estimatedCost) : ""}</span>
            </div>`).join("")}
        </div>`).join("<hr class='modal-divider'/>");

      body.innerHTML = rowsHtml + budgetHtml + `<hr class="modal-divider"/><div style="font-weight:700;font-size:.875rem;margin-bottom:.75rem">📅 Lịch trình</div>` + itineraryHtml;
      modal.classList.remove("hidden");
    } catch (e) {
      console.error("Modal error:", e);
    }
  }

  function closeModal() {
    $("plan-modal")?.classList.add("hidden");
  }

  // ── Delete plan ──────────────────────────────────────
  async function deletePlan(planId) {
    if (!confirm("Xóa lịch trình này?")) return;
    try {
      await fetch(`${API}/api/plans/${planId}`, { method: "DELETE" });
      await Promise.all([loadStats(), loadPlans(currentPage)]);
    } catch (e) {
      alert("Lỗi khi xóa: " + e.message);
    }
  }

  // ── Events ───────────────────────────────────────────
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view],[data-del],[data-id],[data-pg]");
    if (!btn) {
      if (e.target.id === "modal-backdrop" || e.target.id === "modal-close") closeModal();
      return;
    }
    if (btn.dataset.view) { openModal(btn.dataset.view); return; }
    if (btn.dataset.del)  { deletePlan(btn.dataset.del); return; }
    if (btn.dataset.id)   { openModal(btn.dataset.id);   return; }
    if (btn.dataset.pg)   { loadPlans(+btn.dataset.pg);  return; }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  $("refresh-btn")?.addEventListener("click", () => {
    loadStats();
    loadPlans(currentPage);
  });

  $("search-dest")?.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchDest = e.target.value.trim();
      loadPlans(1);
    }, 400);
  });

  // ── Helpers ──────────────────────────────────────────
  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Init ─────────────────────────────────────────────
  loadStats();
  loadPlans(1);
})();
