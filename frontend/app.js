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
  const $ = (id) => document.getElementById(id);

  // ── Mapbox token ───────────────────────────────────────
  const urlToken = new URLSearchParams(location.search).get("mapbox") || "";
  if (urlToken) {
    mapboxgl.accessToken = urlToken;
  } else {
    fetch(`${API_BASE}/api/config`)
      .then(r => r.json())
      .then(cfg => {
        if (cfg.mapboxToken) {
          mapboxgl.accessToken = cfg.mapboxToken;
          if (currentPlan) renderMap(currentPlan.mapData);
        }
      })
      .catch(() => {});
  }

  // ── State ──────────────────────────────────────────────
  let conversation = [];
  let currentPlan = null;
  let map = null;
  let renderedLayerIds = [];
  const markersByDay = [];
  let activeMarkerEl = null;
  let isSending = false;
  let unreadCount = 0;        // messages received while widget is closed
  let widgetMode = "hero";    // "hero" | "float-open" | "float-closed"

  // ── Helpers ────────────────────────────────────────────
  const fmt = (n) => n == null ? "Miễn phí" : n.toLocaleString("vi-VN") + " ₫";
  const TYPE_LABEL = { attraction:"Tham quan", cafe:"Cafe", restaurant:"Nhà hàng", "check-in":"Check-in", hotel:"Khách sạn", food:"Ăn uống" };
  const TYPE_ICON  = { attraction:"🗺", cafe:"☕", restaurant:"🍜", "check-in":"📸", hotel:"🏨", food:"🍽" };

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  // ── Widget mode manager ────────────────────────────────
  // Modes:
  //   hero         — static, full-width below hero heading
  //   float-open   — fixed bottom-right, panel visible + FAB visible (to close)
  //   float-closed — fixed bottom-right, panel hidden, FAB visible (to open)

  const setWidgetMode = (mode) => {
    widgetMode = mode;
    const w = $("chat-widget");
    if (!w) return;
    w.className = `chat-widget--${mode}`;

    const header = $("chat-panel-header");
    const fab    = $("chat-fab");
    const hero   = $("hero-section");
    const prompts = $("quick-prompts");

    if (mode === "hero") {
      if (hero)   hero.classList.remove("hidden");
      if (header) header.classList.add("hidden");
      if (fab)    fab.classList.add("hidden");
      if (prompts) prompts.classList.remove("hidden");
      unreadCount = 0;
      updateFabBadge();
    } else {
      if (hero)   hero.classList.add("hidden");
      if (header) header.classList.remove("hidden");
      if (fab)    fab.classList.remove("hidden");

      if (mode === "float-open") {
        unreadCount = 0;
        updateFabBadge();
        if (prompts) prompts.classList.remove("hidden");
        // scroll messages to bottom
        const msgs = $("messages");
        if (msgs) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
        // resize map if it exists (layout may have shifted)
        if (map) setTimeout(() => map.resize(), 50);
      } else {
        // float-closed: hide quick prompts to save space
        if (prompts) prompts.classList.add("hidden");
      }
    }
  };

  const openWidget = () => setWidgetMode("float-open");
  const closeWidget = () => setWidgetMode("float-closed");

  const updateFabBadge = () => {
    const badge = $("fab-badge");
    if (!badge) return;
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? "9+" : unreadCount;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  };

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

    // Badge bump when widget is closed and AI replies
    if (role === "assistant" && widgetMode === "float-closed") {
      unreadCount++;
      updateFabBadge();
    }
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
    $("inline-loading")?.classList.toggle("hidden", !on);
    const btn = $("send-btn");
    if (btn) btn.disabled = on;
    if (on) {
      let i = 0;
      const t = $("inline-loading-text");
      if (t) t.textContent = loadingStages[0];
      clearInterval(window.__loadingInterval);
      window.__loadingInterval = setInterval(() => {
        i = (i + 1) % loadingStages.length;
        const tt = $("inline-loading-text");
        if (tt) tt.textContent = loadingStages[i];
      }, 1800);
      const msgs = $("messages");
      if (msgs) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
    } else {
      clearInterval(window.__loadingInterval);
      window.__loadingInterval = null;
    }
  };

  // ── API ────────────────────────────────────────────────
  const sendChat = async (style = null) => {
    const resp = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation, regenerate_style: style }),
    });
    if (!resp.ok) { const t = await resp.text(); throw new Error(`HTTP ${resp.status}: ${t}`); }
    return resp.json();
  };

  // ── Render plan ────────────────────────────────────────
  const renderPlan = (plan) => {
    currentPlan = plan;
    renderSummary(plan);
    renderItinerary(plan.itinerary);
    renderBudget(plan.budgetSummary, plan.warnings || []);
    renderHotel(plan.hotel);

    // Show result, update hint
    $("result")?.classList.remove("hidden");
    const hint = $("topbar-hint");
    if (hint) hint.textContent = "Nhấn marker hoặc địa điểm để xem chi tiết";

    // Switch chat to floating bubble (closed by default — unobtrusive)
    setWidgetMode("float-closed");

    setTimeout(() => $("result")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);

    // Init map after container is painted
    requestAnimationFrame(() => requestAnimationFrame(() => renderMap(plan.mapData)));
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
      const dayColor = currentPlan?.mapData?.days?.[dayIdx]?.color || "#3b82f6";
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
        card.innerHTML = `
          <div class="place-img-wrap">${photoHtml}</div>
          <div class="place-info">
            <div class="place-time"><span class="place-time__dot" style="background:${dayColor}"></span>${escapeHtml(item.time||"")} · ${escapeHtml(TYPE_LABEL[item.type]||item.type||"")}</div>
            <div class="place-name">${escapeHtml(item.name||"")}</div>
            <div class="place-meta">
              ${item.rating ? `<span class="badge badge--rating">⭐ ${item.rating}</span>` : ""}
              ${item.estimatedCost!=null ? `<span class="badge badge--cost">${fmt(item.estimatedCost)}/người</span>` : ""}
              ${item.travelTimeFromPrevious&&itemIdx>0 ? `<span class="badge badge--travel">🚗 ${item.travelTimeFromPrevious}</span>` : ""}
              ${item.estimatedDuration ? `<span class="badge badge--duration">⏱ ${item.estimatedDuration}p</span>` : ""}
            </div>
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
    const rows = [["🏨","Khách sạn",budget.hotel],["🍜","Ăn uống",budget.food],["☕","Cafe",budget.cafe],["🎫","Vé tham quan",budget.tickets],["🚗","Di chuyển",budget.transport],["🛡","Dự phòng (10%)",budget.backup]];
    el.innerHTML =
      rows.map(([i,l,v]) => `<div class="budget-row"><span class="budget-row__label">${i} ${l}</span><span>${fmt(v)}</span></div>`).join("") +
      `<div class="budget-row"><span class="budget-row__label"><strong>Tổng</strong></span><span class="budget-total ${budget.withinBudget?"budget-ok":"budget-over"}">${fmt(budget.total)}</span></div>` +
      (budget.withinBudget ? `<div class="budget-status budget-status--ok">✅ Trong ngân sách</div>` : `<div class="budget-status budget-status--over">⚠️ Vượt ${fmt(budget.budgetGap)}</div>`) +
      (warnings||[]).map(w => `<div class="warning-item">⚠️ ${escapeHtml(w)}</div>`).join("");
  };

  // ── Hotel ──────────────────────────────────────────────
  const renderHotel = (hotel) => {
    const panel = $("hotel-panel");
    if (!panel) return;
    if (!hotel?.name) { panel.classList.add("hidden"); return; }
    panel.classList.remove("hidden");
    const photo = hotel.photoUrl ? `<img src="${hotel.photoUrl}" alt="${escapeHtml(hotel.name)}" onerror="this.style.display='none'" />` : `<div style="background:var(--surface-3);width:64px;height:64px;border-radius:6px;display:grid;place-items:center;font-size:1.5rem;">🏨</div>`;
    const c = $("hotel-content");
    if (c) c.innerHTML = `<div class="hotel-card">${photo}<div><div class="hotel-card__name">${escapeHtml(hotel.name)}</div><div class="hotel-card__rating">${hotel.rating?"⭐ "+hotel.rating:""}${hotel.reviewCount?" · "+hotel.reviewCount+" reviews":""}</div><div class="hotel-card__price">${hotel.priceLevel||""}</div></div></div>`;
  };

  // ── Map ────────────────────────────────────────────────
  const renderMap = (mapData) => {
    const mapEl = $("map");
    if (!mapEl) return;
    if (!mapboxgl.accessToken) {
      mapEl.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-muted)">⚠️ Mapbox token chưa được cấu hình.</div>';
      return;
    }
    if (!map) {
      map = new mapboxgl.Map({ container:"map", style:"mapbox://styles/mapbox/dark-v11", zoom:11, center:[108.4,11.9] });
      map.addControl(new mapboxgl.NavigationControl({ showCompass:false }), "top-right");
      map.on("load", () => map.resize());
    } else {
      map.resize();
    }

    const doRender = () => {
      renderedLayerIds.forEach(sid => {
        try { if (map.getLayer(sid)) map.removeLayer(sid); } catch(_){}
        try { if (map.getSource(sid)) map.removeSource(sid); } catch(_){}
      });
      renderedLayerIds = [];
      markersByDay.flat().forEach(m => m.remove());
      markersByDay.length = 0;
      activeMarkerEl?.classList.remove("active-marker"); activeMarkerEl = null;

      const legend = $("map-legend");
      if (legend) legend.innerHTML = "";
      const bounds = new mapboxgl.LngLatBounds();
      let hasValidBounds = false;

      (mapData.days||[]).forEach((day, i) => {
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
              map.addSource(sid, { type:"geojson", data:{type:"Feature",geometry:{type:"LineString",coordinates:coords}} });
              map.addLayer({ id:sid, type:"line", source:sid, paint:{"line-color":color,"line-width":3.5,"line-opacity":0.8} });
              renderedLayerIds.push(sid);
            }
          } catch(e) { console.warn("Route decode error", e); }
        }
        const dayMarkers = [];
        (day.markers||[]).forEach((m, j) => {
          if (m.lat==null||m.lng==null||m.lat===0||m.lng===0) return;
          const lngLat = [m.lng, m.lat];
          bounds.extend(lngLat);
          hasValidBounds = true;
          const el = document.createElement("div");
          el.className = "travel-marker";
          el.style.background = color;
          el.textContent = (i+1)+"."+(j+1);
          const marker = new mapboxgl.Marker({element:el}).setLngLat(lngLat).addTo(map);
          const popupHTML = `<div class="popup-card">${m.photoUrl?`<img src="${m.photoUrl}" alt="${escapeHtml(m.name)}" onerror="this.style.display='none'" />`:""}
            <div class="popup-card__body"><div class="popup-card__name">${escapeHtml(m.name||"")}</div>
            <div class="popup-card__meta">${m.time?m.time+" · ":""}${TYPE_LABEL[m.type]||""}${m.rating?" · ⭐ "+m.rating:""}</div>
            <div class="popup-card__cta">Nhấn để xem chi tiết →</div></div></div>`;
          const hoverPopup = new mapboxgl.Popup({ offset:14, maxWidth:"230px", closeButton:false, closeOnClick:false });
          el.addEventListener("mouseenter", () => { if (!hoverPopup.isOpen()) hoverPopup.setLngLat(lngLat).setHTML(popupHTML).addTo(map); });
          el.addEventListener("mouseleave", () => hoverPopup.remove());
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            hoverPopup.remove();
            setActiveMarker(el);
            const items = currentPlan?.itinerary?.[i]?.items || [];
            if (items[j]) openDetailPanel(items[j], i, j);
          });
          dayMarkers.push(marker);
        });
        markersByDay.push(dayMarkers);
      });
      if (hasValidBounds) map.fitBounds(bounds, { padding:{top:60,bottom:60,left:60,right:60}, maxZoom:14, duration:900 });
    };

    if (map.loaded()) doRender(); else map.once("load", doRender);
  };

  const setActiveMarker = (el) => {
    activeMarkerEl?.classList.remove("active-marker");
    activeMarkerEl = el;
    el?.classList.add("active-marker");
  };

  // ── Detail panel ───────────────────────────────────────
  let detailGallery = [], detailGalleryIdx = 0, currentDetailItem = null;

  const openDetailPanel = (item, dayIdx, itemIdx) => {
    if (!item) return;
    currentDetailItem = { item, dayIdx, itemIdx };
    detailGallery = item.photoUrls?.length ? item.photoUrls : (item.photoUrl ? [item.photoUrl] : []);
    detailGalleryIdx = 0;
    renderDetailGallery();

    const set = (id, val) => { const e=$(id); if(e) e.textContent = val??""};
    set("detail-type",  TYPE_LABEL[item.type]||item.type||"Địa điểm");
    set("detail-title", item.name||"—");
    set("detail-reason", item.reason||"");
    const reasonEl = $("detail-reason");
    if (reasonEl) reasonEl.style.display = item.reason ? "" : "none";

    const dayColor = currentPlan?.mapData?.days?.[dayIdx]?.color||"#38bdf8";
    const badge = $("detail-day-badge");
    if (badge) { badge.textContent=`Ngày ${dayIdx+1}`; badge.style.borderColor=dayColor; badge.style.color=dayColor; }

    const badges = [];
    if (item.rating)            badges.push(`<span class="badge badge--rating">⭐ ${item.rating}</span>`);
    if (item.estimatedCost!=null) badges.push(`<span class="badge badge--cost">${fmt(item.estimatedCost)}/người</span>`);
    if (item.estimatedDuration) badges.push(`<span class="badge badge--duration">⏱ ${item.estimatedDuration} phút</span>`);
    if (item.time)              badges.push(`<span class="badge badge--travel">🕒 ${item.time}</span>`);
    const badgesEl = $("detail-badges");
    if (badgesEl) badgesEl.innerHTML = badges.join("");

    const meta = [];
    if (item.travelTimeFromPrevious&&itemIdx>0) meta.push(["🚗 Di chuyển", item.travelTimeFromPrevious]);
    if (item.type)               meta.push(["📂 Loại", TYPE_LABEL[item.type]||item.type]);
    if (item.estimatedCost!=null) meta.push(["💰 Chi phí", fmt(item.estimatedCost)+"/người"]);
    if (item.estimatedDuration)  meta.push(["⏳ Thời gian", item.estimatedDuration+" phút"]);
    const metaEl = $("detail-meta");
    if (metaEl) metaEl.innerHTML = meta.map(([l,v])=>`<div class="detail-meta__row"><span class="detail-meta__label">${l}</span><span class="detail-meta__val">${v}</span></div>`).join("");

    const addrEl = $("detail-address");
    if (addrEl) { addrEl.textContent=item.address||""; addrEl.style.display=item.address?"":"none"; }

    const dir = $("detail-directions");
    if (dir) { if (item.lat&&item.lng) { dir.href=`https://www.google.com/maps/dir/?api=1&destination=${item.lat},${item.lng}`; dir.style.display=""; } else dir.style.display="none"; }

    document.querySelectorAll(".place-card").forEach(c => c.classList.remove("active"));
    const match = document.querySelector(`.place-card[data-day-idx="${dayIdx}"][data-item-idx="${itemIdx}"]`);
    if (match) { match.classList.add("active"); match.scrollIntoView({behavior:"smooth",block:"nearest"}); }

    if (map&&item.lat&&item.lng) map.flyTo({center:[item.lng,item.lat],zoom:15,duration:900});

    $("plan-content")?.classList.add("hidden");
    const panel = $("place-detail-panel");
    panel?.classList.remove("hidden");
    panel?.scrollIntoView({behavior:"smooth",block:"nearest"});
  };

  const closeDetailPanel = () => {
    $("place-detail-panel")?.classList.add("hidden");
    $("plan-content")?.classList.remove("hidden");
    document.querySelectorAll(".place-card").forEach(c=>c.classList.remove("active"));
    setActiveMarker(null);
    currentDetailItem = null;
  };

  const renderDetailGallery = () => {
    const img = $("detail-main-img"), thumbs = $("detail-thumbs");
    const navs = document.querySelectorAll(".detail-nav");
    if (!detailGallery.length) {
      if (img) img.style.display="none";
      if (thumbs) thumbs.innerHTML="";
      navs.forEach(n=>n.style.display="none");
      return;
    }
    if (img) { img.style.display=""; img.src=detailGallery[detailGalleryIdx]; img.onerror=()=>{img.style.display="none";}; }
    navs.forEach(n=>n.style.display=detailGallery.length>1?"":"none");
    if (thumbs) {
      thumbs.innerHTML = detailGallery.map((src,i)=>`<img class="detail-thumb ${i===detailGalleryIdx?"active":""}" data-idx="${i}" src="${src}" alt="thumb ${i+1}" onerror="this.style.display='none'" />`).join("");
      thumbs.querySelectorAll(".detail-thumb").forEach(t=>t.addEventListener("click",()=>{ detailGalleryIdx=+t.dataset.idx; renderDetailGallery(); }));
    }
  };

  // ── New trip reset ─────────────────────────────────────
  const startNewTrip = () => {
    conversation = []; currentPlan = null; isSending = false; unreadCount = 0;
    const msgs = $("messages"); if (msgs) msgs.innerHTML="";
    const inp = $("user-input"); if (inp) inp.value="";
    $("result")?.classList.add("hidden");
    closeDetailPanel();
    const hint = $("topbar-hint");
    if (hint) hint.textContent="Mô tả chuyến đi của bạn để bắt đầu";
    markersByDay.flat().forEach(m=>m.remove()); markersByDay.length=0;
    updateFabBadge();
    setWidgetMode("hero");
    window.scrollTo({top:0,behavior:"smooth"});
  };

  // ── Send ───────────────────────────────────────────────
  const handleSend = async () => {
    if (isSending) return;
    const inputEl = $("user-input");
    const text = inputEl?.value.trim();
    if (!text) return;
    isSending = true;
    addMessage("user", text);
    if (inputEl) inputEl.value="";
    setLoading(true);
    try {
      const res = await sendChat();
      setLoading(false);
      if (res.type==="clarification") {
        addMessage("assistant", res.clarification);
      } else {
        renderPlan(res.plan);
      }
    } catch(e) {
      setLoading(false);
      addMessage("assistant", "Có lỗi xảy ra: "+e.message);
    } finally {
      isSending = false;
    }
  };

  const handleAction = async (style) => {
    if (!currentPlan||isSending) return;
    isSending = true;
    closeDetailPanel();
    // Open the widget so user sees the action happening
    if (widgetMode==="float-closed") openWidget();
    const labels = { cheaper:"Làm rẻ hơn", relaxed:"Nhẹ nhàng hơn", more_food:"Thêm địa điểm ăn uống" };
    addMessage("user", labels[style]||"Tạo lại lịch trình");
    setLoading(true);
    try {
      const res = await sendChat(style);
      setLoading(false);
      if (res.type==="plan") renderPlan(res.plan);
      else addMessage("assistant", res.clarification||"Không thể tạo lại.");
    } catch(e) {
      setLoading(false);
      addMessage("assistant", "Lỗi: "+e.message);
    } finally {
      isSending = false;
    }
  };

  // ── Event delegation ───────────────────────────────────
  window.addEventListener("resize", () => { if (map) map.resize(); });

  document.addEventListener("click", (e) => {
    const t = e.target;

    // FAB: toggle open/closed
    if (t.closest("#chat-fab")) {
      if (widgetMode==="float-closed") openWidget();
      else if (widgetMode==="float-open") closeWidget();
      return;
    }

    // Minimize button inside panel header
    if (t.closest("#chat-minimize-btn")) { closeWidget(); return; }

    // New trip buttons (both the one in float header and the result action bar)
    if (t.closest("#new-trip-float-btn") || t.closest("#new-trip-btn")) { startNewTrip(); return; }

    // Send
    if (t.closest("#send-btn")) { e.preventDefault(); handleSend(); return; }

    // Regenerate / action buttons
    if (t.closest("#regenerate-btn")) { handleAction(null); return; }
    const styleBtn = t.closest(".action-btn[data-style]");
    if (styleBtn) { handleAction(styleBtn.dataset.style); return; }

    // Quick prompt chips
    if (t.closest(".chip")) {
      const inp = $("user-input");
      if (inp) { inp.value = t.closest(".chip").dataset.prompt||""; inp.focus(); }
      return;
    }

    // Detail panel nav
    if (t.closest("#detail-back-btn")) { closeDetailPanel(); return; }
    if (t.id==="detail-prev") { if (detailGallery.length) { detailGalleryIdx=(detailGalleryIdx-1+detailGallery.length)%detailGallery.length; renderDetailGallery(); } return; }
    if (t.id==="detail-next") { if (detailGallery.length) { detailGalleryIdx=(detailGalleryIdx+1)%detailGallery.length; renderDetailGallery(); } return; }
    if (t.id==="detail-flyto") { if (currentDetailItem?.item && map) { const {item}=currentDetailItem; if (item.lat&&item.lng) map.flyTo({center:[item.lng,item.lat],zoom:16,duration:1000}); } return; }
  });

  document.addEventListener("keydown", (e) => {
    // Send on Enter in textarea
    if (e.target?.id==="user-input" && e.key==="Enter" && !e.shiftKey) {
      e.preventDefault(); handleSend(); return;
    }
    // Esc to close detail panel or minimize widget
    if (e.key==="Escape") {
      if (!$("place-detail-panel")?.classList.contains("hidden")) { closeDetailPanel(); return; }
      if (widgetMode==="float-open") { closeWidget(); return; }
    }
    // Arrow keys for gallery
    if (!$("place-detail-panel")?.classList.contains("hidden") && detailGallery.length) {
      if (e.key==="ArrowLeft")  { detailGalleryIdx=(detailGalleryIdx-1+detailGallery.length)%detailGallery.length; renderDetailGallery(); }
      if (e.key==="ArrowRight") { detailGalleryIdx=(detailGalleryIdx+1)%detailGallery.length; renderDetailGallery(); }
    }
  });
})();
