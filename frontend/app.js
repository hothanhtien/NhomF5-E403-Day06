(() => {
  // ── Polyline6 decoder ─────────────────────────────────
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
      coords.push([lng / factor, lat / factor]);
    }
    return coords;
  }

  const API_BASE = "";

  // ── Always-safe DOM accessor (lazy, never caches null) ─
  const $ = (id) => document.getElementById(id);

  // ── Mapbox token ───────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const tokenFromUrl = params.get("mapbox") || "";

  const _configReady = tokenFromUrl
    ? Promise.resolve(tokenFromUrl)
    : fetch(`${API_BASE}/api/config`)
        .then(r => r.json())
        .then(cfg => cfg.mapboxToken || "")
        .catch(() => "");

  if (tokenFromUrl) {
    mapboxgl.accessToken = tokenFromUrl;
  } else {
    _configReady.then(token => { if (token) mapboxgl.accessToken = token; });
  }

  // ── State ──────────────────────────────────────────────
  let conversation = [];
  let currentPlan = null;
  let map = null;
  let renderedLayerIds = [];
  const markersByDay = [];
  let activeMarkerEl = null;
  let isSending = false;

  // ── Helpers ────────────────────────────────────────────
  const fmt = (n) => (n == null) ? "Miễn phí" : (n.toLocaleString("vi-VN") + " ₫");
  const TYPE_LABEL = {
    attraction: "Tham quan", cafe: "Cafe", restaurant: "Nhà hàng",
    "check-in": "Check-in", hotel: "Khách sạn", food: "Ăn uống",
  };
  const TYPE_ICON = {
    attraction: "🗺", cafe: "☕", restaurant: "🍜",
    "check-in": "📸", hotel: "🏨", food: "🍽",
  };

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ── addMessage ─────────────────────────────────────────
  const addMessage = (role, content) => {
    conversation.push({ role, content });
    const msgs = $("messages");
    if (!msgs) return;
    const el = document.createElement("div");
    el.className = `msg msg--${role}`;
    el.textContent = content;
    msgs.appendChild(el);
    requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  };

  // ── Loading ────────────────────────────────────────────
  const loadingStages = [
    "Phân tích yêu cầu…",
    "Tìm địa điểm phù hợp…",
    "Tính toán tuyến đường…",
    "Tối ưu lịch trình…",
    "Kiểm tra ngân sách…",
    "Sắp xếp ảnh địa điểm…",
  ];

  const setLoading = (on) => {
    // Use lazy $() so we never crash if an element doesn't exist
    $("inline-loading")?.classList.toggle("hidden", !on);
    const btn = $("send-btn");
    if (btn) btn.disabled = on;

    if (on) {
      let i = 0;
      const textEl = $("inline-loading-text");
      if (textEl) textEl.textContent = loadingStages[0];
      if (window.__loadingInterval) clearInterval(window.__loadingInterval);
      window.__loadingInterval = setInterval(() => {
        i = (i + 1) % loadingStages.length;
        const t = $("inline-loading-text");
        if (t) t.textContent = loadingStages[i];
      }, 1800);
      const msgs = $("messages");
      if (msgs) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
    } else {
      if (window.__loadingInterval) { clearInterval(window.__loadingInterval); window.__loadingInterval = null; }
    }
  };

  // ── API ────────────────────────────────────────────────
  const sendChat = async (regenerateStyle = null) => {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation, regenerate_style: regenerateStyle }),
    });
    if (!resp.ok) { const text = await resp.text(); throw new Error(`HTTP ${resp.status}: ${text}`); }
    return resp.json();
  };

  // ── Render plan ────────────────────────────────────────
  const renderPlan = (plan) => {
    currentPlan = plan;
    renderSummary(plan);
    renderItinerary(plan.itinerary);
    renderBudget(plan.budgetSummary, plan.warnings || []);
    renderHotel(plan.hotel);

    // Show result BEFORE map init so the container has real pixel dimensions
    $("chat-section")?.classList.add("compact");
    $("result")?.classList.remove("hidden");
    const hint = $("topbar-hint");
    if (hint) hint.textContent = "Nhấn marker hoặc địa điểm để xem chi tiết";

    setTimeout(() => $("result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);

    // Two rAF passes: first paints the DOM, second measures real container size
    requestAnimationFrame(() => {
      requestAnimationFrame(() => renderMap(plan.mapData));
    });
  };

  // ── Summary ────────────────────────────────────────────
  const renderSummary = (plan) => {
    const it = plan.intent || {};
    const dest = $("summary-dest");
    if (dest) dest.textContent = it.destination || "—";
    const meta = [];
    if (it.duration) meta.push(it.duration);
    if (it.people)   meta.push(`${it.people} người`);
    if (it.budget)   meta.push(`Ngân sách ${fmt(it.budget)}`);
    const metaEl = $("summary-meta");
    if (metaEl) metaEl.textContent = meta.join(" · ");
    const chips = $("summary-chips");
    if (chips) {
      chips.innerHTML = "";
      (it.preferences || []).forEach(p => {
        const c = document.createElement("span");
        c.className = "summary-chip";
        c.textContent = "#" + p;
        chips.appendChild(c);
      });
    }
  };

  // ── Itinerary ──────────────────────────────────────────
  const renderItinerary = (itinerary) => {
    const el = $("itinerary-content");
    if (!el) return;
    el.innerHTML = "";
    itinerary.forEach((day, dayIdx) => {
      const block = document.createElement("div");
      block.className = "day-block";
      const dayColor = (currentPlan?.mapData?.days?.[dayIdx] || {}).color || "#3b82f6";
      block.innerHTML = `<div class="day-title" style="border-left-color:${dayColor}">📅 Ngày ${day.day} — ${escapeHtml(day.title || "")}</div>`;
      (day.items || []).forEach((item, itemIdx) => {
        const card = document.createElement("div");
        card.className = "place-card";
        card.dataset.dayIdx = dayIdx;
        card.dataset.itemIdx = itemIdx;

        const icon = TYPE_ICON[item.type] || "📍";
        const photoHtml = item.photoUrl
          ? `<img class="place-img" loading="lazy" src="${item.photoUrl}" alt="${escapeHtml(item.name)}" onerror="this.parentNode.innerHTML='<div class=place-img-fallback>${icon}</div>'" />`
          : `<div class="place-img-fallback">${icon}</div>`;

        const costBadge     = item.estimatedCost != null ? `<span class="badge badge--cost">${fmt(item.estimatedCost)}/người</span>` : "";
        const ratingBadge   = item.rating         ? `<span class="badge badge--rating">⭐ ${item.rating}</span>` : "";
        const travelBadge   = item.travelTimeFromPrevious && itemIdx > 0 ? `<span class="badge badge--travel">🚗 ${item.travelTimeFromPrevious}</span>` : "";
        const durationBadge = item.estimatedDuration ? `<span class="badge badge--duration">⏱ ${item.estimatedDuration}p</span>` : "";

        card.innerHTML = `
          <div class="place-img-wrap">${photoHtml}</div>
          <div class="place-info">
            <div class="place-time">
              <span class="place-time__dot" style="background:${dayColor}"></span>
              ${escapeHtml(item.time || "")} · ${escapeHtml(TYPE_LABEL[item.type] || item.type || "")}
            </div>
            <div class="place-name">${escapeHtml(item.name || "")}</div>
            <div class="place-meta">${ratingBadge}${costBadge}${travelBadge}${durationBadge}</div>
            ${item.reason ? `<div class="place-reason">${escapeHtml(item.reason)}</div>` : ""}
          </div>`;

        card.addEventListener("click", () => openDetailPanel(item, dayIdx, itemIdx));
        block.appendChild(card);
      });
      el.appendChild(block);
    });
  };

  // ── Budget ─────────────────────────────────────────────
  const renderBudget = (budget, warnings) => {
    const el = $("budget-content");
    if (!el) return;
    const rows = [
      ["🏨", "Khách sạn", budget.hotel],
      ["🍜", "Ăn uống",   budget.food],
      ["☕", "Cafe",       budget.cafe],
      ["🎫", "Vé tham quan", budget.tickets],
      ["🚗", "Di chuyển", budget.transport],
      ["🛡", "Dự phòng (10%)", budget.backup],
    ];
    el.innerHTML =
      rows.map(([icon, label, val]) =>
        `<div class="budget-row"><span class="budget-row__label">${icon} ${label}</span><span>${fmt(val)}</span></div>`
      ).join("") +
      `<div class="budget-row"><span class="budget-row__label"><strong>Tổng</strong></span>` +
      `<span class="budget-total ${budget.withinBudget ? "budget-ok" : "budget-over"}">${fmt(budget.total)}</span></div>` +
      (budget.withinBudget
        ? `<div class="budget-status budget-status--ok">✅ Trong ngân sách</div>`
        : `<div class="budget-status budget-status--over">⚠️ Vượt ${fmt(budget.budgetGap)}</div>`) +
      (warnings || []).map(w => `<div class="warning-item">⚠️ ${escapeHtml(w)}</div>`).join("");
  };

  // ── Hotel ──────────────────────────────────────────────
  const PRICE_LEVEL_LABEL = {
    PRICE_LEVEL_FREE: "Miễn phí",
    PRICE_LEVEL_INEXPENSIVE: "Bình dân (< 400k/đêm)",
    PRICE_LEVEL_MODERATE: "Trung bình (~800k/đêm)",
    PRICE_LEVEL_EXPENSIVE: "Cao cấp (~1.5tr/đêm)",
    PRICE_LEVEL_VERY_EXPENSIVE: "Sang trọng (> 3tr/đêm)",
  };

  const renderHotel = (hotel) => {
    const panel = $("hotel-panel");
    if (!panel) return;
    if (!hotel?.name) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    const photo = hotel.photoUrl
      ? `<img src="${hotel.photoUrl}" alt="${escapeHtml(hotel.name)}" onerror="this.style.display='none'" />`
      : `<div style="background:var(--surface-3);width:64px;height:64px;border-radius:6px;display:grid;place-items:center;font-size:1.5rem;">🏨</div>`;

    const bookingUrl = `https://www.booking.com/search.html?ss=${encodeURIComponent(hotel.name)}`;
    const mapsUrl = hotel.placeId
      ? `https://www.google.com/maps/place/?q=place_id:${hotel.placeId}`
      : (hotel.lat && hotel.lng ? `https://www.google.com/maps?q=${hotel.lat},${hotel.lng}` : "");

    const priceLabel = PRICE_LEVEL_LABEL[hotel.priceLevel] || "";

    const content = $("hotel-content");
    if (content) content.innerHTML = `
      <div class="hotel-card">
        ${photo}
        <div class="hotel-card__info">
          <div class="hotel-card__name">${escapeHtml(hotel.name)}</div>
          <div class="hotel-card__rating">${hotel.rating ? "⭐ " + hotel.rating : ""}${hotel.reviewCount ? " · " + hotel.reviewCount + " reviews" : ""}</div>
          ${priceLabel ? `<div class="hotel-card__price">${escapeHtml(priceLabel)}</div>` : ""}
          ${hotel.address ? `<div class="hotel-card__address">📍 ${escapeHtml(hotel.address)}</div>` : ""}
        </div>
      </div>
      <div class="hotel-card__actions">
        <a class="hotel-btn hotel-btn--primary" href="${bookingUrl}" target="_blank" rel="noopener">🛏 Đặt phòng Booking.com</a>
        ${mapsUrl ? `<a class="hotel-btn" href="${mapsUrl}" target="_blank" rel="noopener">🗺 Xem Google Maps</a>` : ""}
      </div>`;
  };

  // ── Map ────────────────────────────────────────────────
  const renderMap = async (mapData) => {
    const mapEl = $("map");
    if (!mapEl) return;

    if (!mapboxgl.accessToken) {
      const token = await _configReady;
      if (token) mapboxgl.accessToken = token;
    }

    if (!mapboxgl.accessToken) {
      mapEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted)">⚠️ Mapbox token chưa được cấu hình.</div>';
      return;
    }

    if (!map) {
      map = new mapboxgl.Map({
        container: "map",
        style: "mapbox://styles/mapbox/dark-v11",
        zoom: 11,
        center: [108.4, 11.9],
      });
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => map.resize());
    } else {
      map.resize();
    }

    const doRender = () => {
      renderedLayerIds.forEach(sid => {
        try { if (map.getLayer(sid)) map.removeLayer(sid); } catch (_) {}
        try { if (map.getSource(sid)) map.removeSource(sid); } catch (_) {}
      });
      renderedLayerIds = [];
      markersByDay.flat().forEach(m => m.remove());
      markersByDay.length = 0;
      if (activeMarkerEl) { activeMarkerEl.classList.remove("active-marker"); activeMarkerEl = null; }

      const legend = $("map-legend");
      if (legend) legend.innerHTML = "";
      const bounds = new mapboxgl.LngLatBounds();
      let hasValidBounds = false;

      (mapData.days || []).forEach((day, i) => {
        const color = day.color || "#38bdf8";

        if (legend) {
          const row = document.createElement("div");
          row.className = "map-legend__row";
          row.innerHTML = `<span class="map-legend__dot" style="background:${color}"></span>Ngày ${day.day}`;
          legend.appendChild(row);
        }

        if (day.routePolyline) {
          try {
            const coords = decodePolyline(day.routePolyline, 6);
            if (coords.length >= 2) {
              const sid = `route-${i}`;
              map.addSource(sid, { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } } });
              map.addLayer({ id: sid, type: "line", source: sid, paint: { "line-color": color, "line-width": 3.5, "line-opacity": 0.8 } });
              renderedLayerIds.push(sid);
            }
          } catch (e) { console.warn("Route decode error day", i, e); }
        }

        const dayMarkers = [];
        (day.markers || []).forEach((m, j) => {
          if (m.lat == null || m.lng == null || m.lat === 0 || m.lng === 0) return;
          const lngLat = [m.lng, m.lat];
          bounds.extend(lngLat);
          hasValidBounds = true;

          const el = document.createElement("div");
          el.className = "travel-marker";
          el.style.background = color;
          el.textContent = (i + 1) + "." + (j + 1);

          const marker = new mapboxgl.Marker({ element: el }).setLngLat(lngLat).addTo(map);

          // Hover = popup, click = detail panel (no conflict)
          const popupHTML = `
            <div class="popup-card">
              ${m.photoUrl ? `<img src="${m.photoUrl}" alt="${escapeHtml(m.name)}" onerror="this.style.display='none'" />` : ""}
              <div class="popup-card__body">
                <div class="popup-card__name">${escapeHtml(m.name || "")}</div>
                <div class="popup-card__meta">${m.time ? m.time + " · " : ""}${TYPE_LABEL[m.type] || ""}${m.rating ? " · ⭐ " + m.rating : ""}</div>
                <div class="popup-card__cta">Nhấn để xem chi tiết →</div>
              </div>
            </div>`;

          const hoverPopup = new mapboxgl.Popup({ offset: 14, maxWidth: "230px", closeButton: false, closeOnClick: false });

          el.addEventListener("mouseenter", () => {
            if (!hoverPopup.isOpen()) hoverPopup.setLngLat(lngLat).setHTML(popupHTML).addTo(map);
          });
          el.addEventListener("mouseleave", () => hoverPopup.remove());
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            hoverPopup.remove();
            setActiveMarker(el);
            const allItems = (currentPlan?.itinerary?.[i] || {}).items || [];
            if (allItems[j]) openDetailPanel(allItems[j], i, j);
          });

          dayMarkers.push(marker);
        });
        markersByDay.push(dayMarkers);
      });

      if (hasValidBounds) {
        map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: 14, duration: 900 });
      }
    };

    if (map.loaded()) doRender();
    else map.once("load", doRender);
  };

  const setActiveMarker = (el) => {
    activeMarkerEl?.classList.remove("active-marker");
    activeMarkerEl = el;
    el?.classList.add("active-marker");
  };

  // ── Detail panel ───────────────────────────────────────
  let detailGallery = [];
  let detailGalleryIdx = 0;
  let currentDetailItem = null;

  const openDetailPanel = (item, dayIdx, itemIdx) => {
    if (!item) return;
    currentDetailItem = { item, dayIdx, itemIdx };

    detailGallery = item.photoUrls?.length ? item.photoUrls : (item.photoUrl ? [item.photoUrl] : []);
    detailGalleryIdx = 0;
    renderDetailGallery();

    const setTxt = (id, val) => { const e = $(id); if (e) e.textContent = val ?? ""; };
    setTxt("detail-type",   TYPE_LABEL[item.type] || item.type || "Địa điểm");
    setTxt("detail-title",  item.name || "—");
    setTxt("detail-reason", item.reason || "");
    $("detail-reason")?.style && ($("detail-reason").style.display = item.reason ? "" : "none");

    const dayColor = currentPlan?.mapData?.days?.[dayIdx]?.color || "#38bdf8";
    const badge = $("detail-day-badge");
    if (badge) {
      badge.textContent = `Ngày ${dayIdx + 1}`;
      badge.style.borderColor = dayColor;
      badge.style.color = dayColor;
    }

    const badges = [];
    if (item.rating)           badges.push(`<span class="badge badge--rating">⭐ ${item.rating}</span>`);
    if (item.estimatedCost != null) badges.push(`<span class="badge badge--cost">${fmt(item.estimatedCost)}/người</span>`);
    if (item.estimatedDuration)badges.push(`<span class="badge badge--duration">⏱ ${item.estimatedDuration} phút</span>`);
    if (item.time)             badges.push(`<span class="badge badge--travel">🕒 ${item.time}</span>`);
    const badgesEl = $("detail-badges");
    if (badgesEl) badgesEl.innerHTML = badges.join("");

    const meta = [];
    if (item.travelTimeFromPrevious && itemIdx > 0) meta.push(["🚗 Di chuyển", item.travelTimeFromPrevious]);
    if (item.type)              meta.push(["📂 Loại",    TYPE_LABEL[item.type] || item.type]);
    if (item.estimatedCost != null) meta.push(["💰 Chi phí", fmt(item.estimatedCost) + "/người"]);
    if (item.estimatedDuration) meta.push(["⏳ Thời gian", item.estimatedDuration + " phút"]);
    const metaEl = $("detail-meta");
    if (metaEl) metaEl.innerHTML = meta.map(([l, v]) =>
      `<div class="detail-meta__row"><span class="detail-meta__label">${l}</span><span class="detail-meta__val">${v}</span></div>`
    ).join("");

    const addrEl = $("detail-address");
    if (addrEl) { addrEl.textContent = item.address || ""; addrEl.style.display = item.address ? "" : "none"; }

    const dirEl = $("detail-directions");
    if (dirEl) {
      if (item.lat && item.lng) {
        dirEl.href = `https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}`;
        dirEl.style.display = "";
      } else {
        dirEl.style.display = "none";
      }
    }

    // Booking button — only for hotel items
    let bookingEl = $("detail-booking");
    if (item.type === "hotel") {
      const hotelName = item.bookingName || item.name || "";
      const bookingUrl = `https://www.booking.com/search.html?ss=${encodeURIComponent(hotelName)}`;
      if (!bookingEl) {
        bookingEl = document.createElement("a");
        bookingEl.id = "detail-booking";
        bookingEl.className = "modal__btn modal__btn--booking";
        bookingEl.target = "_blank";
        bookingEl.rel = "noopener";
        const actionsEl = document.querySelector(".detail-panel__actions");
        if (actionsEl) actionsEl.appendChild(bookingEl);
      }
      bookingEl.href = bookingUrl;
      bookingEl.textContent = "🛏 Đặt phòng";
      bookingEl.style.display = "";
    } else if (bookingEl) {
      bookingEl.style.display = "none";
    }

    // Highlight card in itinerary list
    document.querySelectorAll(".place-card").forEach(c => c.classList.remove("active"));
    const matchCard = document.querySelector(`.place-card[data-day-idx="${dayIdx}"][data-item-idx="${itemIdx}"]`);
    if (matchCard) { matchCard.classList.add("active"); matchCard.scrollIntoView({ behavior: "smooth", block: "nearest" }); }

    // Fly map to location
    if (map && item.lat && item.lng) map.flyTo({ center: [item.lng, item.lat], zoom: 15, duration: 900 });

    $("plan-content")?.classList.add("hidden");
    const panel = $("place-detail-panel");
    panel?.classList.remove("hidden");
    panel?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const closeDetailPanel = () => {
    $("place-detail-panel")?.classList.add("hidden");
    $("plan-content")?.classList.remove("hidden");
    document.querySelectorAll(".place-card").forEach(c => c.classList.remove("active"));
    setActiveMarker(null);
    currentDetailItem = null;
  };

  const renderDetailGallery = () => {
    const img    = $("detail-main-img");
    const thumbs = $("detail-thumbs");
    const navs   = document.querySelectorAll(".detail-nav");

    if (!detailGallery.length) {
      if (img) img.style.display = "none";
      if (thumbs) thumbs.innerHTML = "";
      navs.forEach(n => { n.style.display = "none"; });
      return;
    }
    if (img) { img.style.display = ""; img.src = detailGallery[detailGalleryIdx]; img.onerror = () => { img.style.display = "none"; }; }
    navs.forEach(n => { n.style.display = detailGallery.length > 1 ? "" : "none"; });
    if (thumbs) {
      thumbs.innerHTML = detailGallery.map((src, i) =>
        `<img class="detail-thumb ${i === detailGalleryIdx ? "active" : ""}" data-idx="${i}" src="${src}" alt="thumb ${i + 1}" onerror="this.style.display='none'" />`
      ).join("");
      thumbs.querySelectorAll(".detail-thumb").forEach(t => {
        t.addEventListener("click", () => { detailGalleryIdx = +t.dataset.idx; renderDetailGallery(); });
      });
    }
  };

  // ── Detail panel events ────────────────────────────────
  document.addEventListener("click", (e) => {
    if (e.target.id === "detail-back-btn" || e.target.closest("#detail-back-btn")) closeDetailPanel();
    if (e.target.id === "detail-prev") {
      if (!detailGallery.length) return;
      detailGalleryIdx = (detailGalleryIdx - 1 + detailGallery.length) % detailGallery.length;
      renderDetailGallery();
    }
    if (e.target.id === "detail-next") {
      if (!detailGallery.length) return;
      detailGalleryIdx = (detailGalleryIdx + 1) % detailGallery.length;
      renderDetailGallery();
    }
    if (e.target.id === "detail-flyto") {
      if (currentDetailItem && map) {
        const { item } = currentDetailItem;
        if (item.lat && item.lng) map.flyTo({ center: [item.lng, item.lat], zoom: 16, duration: 1000 });
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    if ($("place-detail-panel")?.classList.contains("hidden")) return;
    if (e.key === "Escape")     closeDetailPanel();
    if (e.key === "ArrowLeft")  { if (detailGallery.length) { detailGalleryIdx = (detailGalleryIdx - 1 + detailGallery.length) % detailGallery.length; renderDetailGallery(); } }
    if (e.key === "ArrowRight") { if (detailGallery.length) { detailGalleryIdx = (detailGalleryIdx + 1) % detailGallery.length; renderDetailGallery(); } }
  });

  window.addEventListener("resize", () => { if (map) map.resize(); });

  // ── Send / Actions ─────────────────────────────────────
  const handleSend = async () => {
    if (isSending) return;
    const inputEl = $("user-input");
    const text = inputEl?.value.trim();
    if (!text) return;
    isSending = true;
    addMessage("user", text);
    if (inputEl) inputEl.value = "";
    setLoading(true);
    try {
      const res = await sendChat();
      setLoading(false);
      if (res.type === "clarification") {
        addMessage("assistant", res.clarification);
      } else {
        renderPlan(res.plan);
      }
    } catch (e) {
      setLoading(false);
      addMessage("assistant", "Có lỗi xảy ra: " + e.message);
    } finally {
      isSending = false;
    }
  };

  const handleAction = async (style) => {
    if (!currentPlan || isSending) return;
    isSending = true;
    closeDetailPanel();
    const labels = { cheaper: "Làm rẻ hơn", relaxed: "Nhẹ nhàng hơn", more_food: "Thêm địa điểm ăn uống" };
    addMessage("user", labels[style] || "Tạo lại lịch trình");
    setLoading(true);
    try {
      const res = await sendChat(style);
      setLoading(false);
      if (res.type === "plan") renderPlan(res.plan);
      else addMessage("assistant", res.clarification || "Không thể tạo lại lịch trình.");
    } catch (e) {
      setLoading(false);
      addMessage("assistant", "Có lỗi khi thay đổi lịch trình: " + e.message);
    } finally {
      isSending = false;
    }
  };

  const startNewTrip = () => {
    conversation = [];
    currentPlan = null;
    isSending = false;
    const msgs = $("messages");
    if (msgs) msgs.innerHTML = "";
    const inp = $("user-input");
    if (inp) inp.value = "";
    $("chat-section")?.classList.remove("compact");
    $("result")?.classList.add("hidden");
    closeDetailPanel();
    const hint = $("topbar-hint");
    if (hint) hint.textContent = "Mô tả chuyến đi của bạn để bắt đầu";
    markersByDay.flat().forEach(m => m.remove());
    markersByDay.length = 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // ── Wire up static buttons ─────────────────────────────
  // Use event delegation so it works even if buttons aren't in DOM at init time
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button, a[id]");
    if (!btn) return;
    if (btn.id === "send-btn")       { e.preventDefault(); handleSend(); return; }
    if (btn.id === "regenerate-btn") { handleAction(null); return; }
    if (btn.id === "new-trip-btn")   { startNewTrip(); return; }
    const style = btn.dataset?.style;
    if (style)                       { handleAction(style); return; }
    if (btn.classList.contains("chip")) {
      const inp = $("user-input");
      if (inp) { inp.value = btn.dataset.prompt || ""; inp.focus(); }
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.target?.id === "user-input" && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
})();
