(() => {
  // Inline polyline6 decoder (replaces @mapbox/polyline CDN which doesn't expose a global)
  function decodePolyline(str, precision) {
    const factor = Math.pow(10, precision || 5);
    let index = 0, lat = 0, lng = 0;
    const coords = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lat / factor, lng / factor]);
    }
    return coords;
  }

  const API_BASE = "";

  // Load Mapbox token from backend config (fallback: ?mapbox= query param)
  const params = new URLSearchParams(location.search);
  const tokenFromUrl = params.get("mapbox") || "";
  if (tokenFromUrl) {
    mapboxgl.accessToken = tokenFromUrl;
  } else {
    fetch(`${API_BASE}/api/config`)
      .then(r => r.json())
      .then(cfg => { if (cfg.mapboxToken) mapboxgl.accessToken = cfg.mapboxToken; })
      .catch(() => {});
  }

  // State
  let conversation = [];
  let currentPlan = null;
  let map = null;
  let renderedLayerIds = [];

  // DOM refs
  const messagesEl = document.getElementById("messages");
  const userInputEl = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");
  const loadingEl = document.getElementById("loading");
  const resultEl = document.getElementById("result");
  const heroEl = document.getElementById("hero");

  // ── Helpers ──────────────────────────────────────────────

  const fmt = (n) => n ? n.toLocaleString("vi-VN") + " ₫" : "Miễn phí";

  const addMessage = (role, content) => {
    conversation.push({ role, content });
    const el = document.createElement("div");
    el.className = `msg msg--${role}`;
    el.textContent = content;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const setLoading = (on) => {
    loadingEl.classList.toggle("hidden", !on);
    heroEl.classList.toggle("hidden", on);
    resultEl.classList.add("hidden");
  };

  // ── API ───────────────────────────────────────────────────

  const sendChat = async (regenerateStyle = null) => {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation, regenerate_style: regenerateStyle }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  };

  // ── Render ────────────────────────────────────────────────

  const renderPlan = (plan) => {
    currentPlan = plan;
    renderItinerary(plan.itinerary);
    renderBudget(plan.budgetSummary, plan.warnings || []);
    renderMap(plan.mapData);
    heroEl.classList.add("hidden");
    loadingEl.classList.add("hidden");
    resultEl.classList.remove("hidden");
  };

  const renderItinerary = (itinerary) => {
    const el = document.getElementById("itinerary-content");
    el.innerHTML = "";
    for (const day of itinerary) {
      const block = document.createElement("div");
      block.className = "day-block";
      block.innerHTML = `<div class="day-title">📅 Ngày ${day.day} — ${day.title || ""}</div>`;
      for (const item of day.items || []) {
        const card = document.createElement("div");
        card.className = "place-card";
        card.innerHTML = `
          <img class="place-img" src="${item.photoUrl || ''}" alt="${item.name}" onerror="this.style.display='none'">
          <div class="place-info">
            <div class="place-time">${item.time || ''} · ${item.type || ''}</div>
            <div class="place-name">${item.name}</div>
            <div class="place-meta">
              ${item.rating ? `<span class="badge badge--rating">⭐ ${item.rating}</span>` : ''}
              ${item.estimatedCost != null ? `<span class="badge badge--cost">${fmt(item.estimatedCost)}/người</span>` : ''}
              ${item.travelTimeFromPrevious ? `<span class="badge badge--travel">🚗 ${item.travelTimeFromPrevious}</span>` : ''}
            </div>
            ${item.reason ? `<div class="place-reason">${item.reason}</div>` : ''}
          </div>`;
        block.appendChild(card);
      }
      el.appendChild(block);
    }
  };

  const renderBudget = (budget, warnings) => {
    const el = document.getElementById("budget-content");
    const rows = [
      ["🏨 Khách sạn", budget.hotel],
      ["🍜 Ăn uống", budget.food],
      ["☕ Cafe", budget.cafe],
      ["🎫 Vé tham quan", budget.tickets],
      ["🚗 Di chuyển", budget.transport],
      ["🛡 Dự phòng (10%)", budget.backup],
    ];
    el.innerHTML = rows.map(([label, val]) =>
      `<div class="budget-row"><span>${label}</span><span>${fmt(val)}</span></div>`
    ).join("") +
    `<div class="budget-row">
      <span><strong>Tổng</strong></span>
      <span class="budget-total ${budget.withinBudget ? 'budget-ok' : 'budget-over'}">${fmt(budget.total)}</span>
    </div>` +
    (budget.withinBudget
      ? `<div style="color:var(--success);font-size:.85rem;margin-top:.5rem">✅ Trong ngân sách</div>`
      : `<div style="color:var(--danger);font-size:.85rem;margin-top:.5rem">⚠️ Vượt ${fmt(budget.budgetGap)}</div>`) +
    warnings.map(w => `<div class="warning-item">⚠️ ${w}</div>`).join("");
  };

  const renderMap = (mapData) => {
    if (!mapboxgl.accessToken) return;
    if (!map) {
      map = new mapboxgl.Map({
        container: "map",
        style: "mapbox://styles/mapbox/dark-v11",
        zoom: 11,
      });
    }

    const doRender = () => {
      // Remove previously rendered layers/sources
      renderedLayerIds.forEach(sid => {
        if (map.getLayer(sid)) map.removeLayer(sid);
        if (map.getSource(sid)) map.removeSource(sid);
      });
      renderedLayerIds = [];

      // Remove old markers
      document.querySelectorAll(".travel-marker").forEach(el => el.remove());

      const bounds = new mapboxgl.LngLatBounds();

      (mapData.days || []).forEach((day, i) => {
        const color = day.color || "#38bdf8";

        // Draw route polyline (polyline6 encoded)
        if (day.routePolyline) {
          const coords = decodePolyline(day.routePolyline, 6).map(([lat, lng]) => [lng, lat]);
          const sid = `route-${i}`;
          map.addSource(sid, {
            type: "geojson",
            data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } }
          });
          map.addLayer({
            id: sid, type: "line", source: sid,
            paint: { "line-color": color, "line-width": 3, "line-opacity": 0.8 }
          });
          renderedLayerIds.push(sid);
        }

        // Add markers
        (day.markers || []).forEach((m, j) => {
          if (!m.lat || !m.lng) return;
          const lngLat = [m.lng, m.lat];
          bounds.extend(lngLat);

          const el = document.createElement("div");
          el.className = "travel-marker";
          el.style.cssText = `width:28px;height:28px;border-radius:50%;background:${color};border:2px solid white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white;cursor:pointer;`;
          el.textContent = j + 1;

          const popup = new mapboxgl.Popup({ offset: 12 }).setHTML(`
            <div style="max-width:180px">
              ${m.photoUrl ? `<img src="${m.photoUrl}" style="width:100%;height:90px;object-fit:cover;border-radius:6px;margin-bottom:4px" onerror="this.style.display='none'">` : ''}
              <strong>${m.name}</strong><br>
              ${m.rating ? `⭐ ${m.rating}` : ''} ${m.cost ? `· ${m.cost.toLocaleString('vi-VN')}₫` : ''}
            </div>`);

          new mapboxgl.Marker({ element: el }).setLngLat(lngLat).setPopup(popup).addTo(map);
        });
      });

      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
    };

    if (map.loaded()) doRender();
    else map.on("load", doRender);
  };

  // ── Event handlers ────────────────────────────────────────

  const handleSend = async () => {
    const text = userInputEl.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    addMessage("user", text);
    userInputEl.value = "";
    setLoading(true);

    try {
      const res = await sendChat();
      if (res.type === "clarification") {
        setLoading(false);
        addMessage("assistant", res.clarification);
      } else {
        renderPlan(res.plan);
      }
    } catch (e) {
      setLoading(false);
      addMessage("assistant", "Có lỗi xảy ra. Vui lòng thử lại.");
    } finally {
      sendBtn.disabled = false;
    }
  };

  const handleAction = async (style) => {
    if (!currentPlan) return;
    setLoading(true);
    try {
      const res = await sendChat(style);
      if (res.type === "plan") renderPlan(res.plan);
      else setLoading(false);
    } catch (e) {
      setLoading(false);
      addMessage("assistant", "Có lỗi khi thay đổi lịch trình. Vui lòng thử lại.");
    }
  };

  sendBtn.addEventListener("click", handleSend);
  userInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });

  document.getElementById("regenerate-btn").addEventListener("click", () => handleAction(null));
  document.querySelectorAll(".action-btn[data-style]").forEach(btn => {
    btn.addEventListener("click", () => handleAction(btn.dataset.style));
  });
})();
