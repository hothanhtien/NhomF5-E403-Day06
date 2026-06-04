# Workflow Tối Ưu Lịch Trình — AI Travel Planner Agent

Tài liệu này mô tả chi tiết luồng chạy (input → tool → output) của module **tối ưu lịch trình** trong hệ thống, dựa trên các tool đã implement trong backend.

---

## 1. Tổng quan luồng

```text
┌─────────────┐
│  User input │
│ (Vietnamese) │
└──────┬──────┘
       │
       ▼
┌──────────────────┐
│ 1. Intent Agent  │  (OpenAI — parse 5 trường)
└──────┬───────────┘
       │
       ▼  (nếu thiếu → trả clarification question)
       │
┌──────────────────┐
│ 2. Search Pool   │  (Google Places — thu điểm thô)
│    - Places      │
│    - Hotels      │
│    - Restaurants │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 3. Place Details │  (Google Place Details — lat/lng,
│                  │   rating, photo, hours, cost ước lượng)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 4. Scoring &     │  (OpenAI Optimizer + công thức trọng số)
│    Filtering     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 5. Clustering    │  (gom cụm điểm theo ngày + bán kính)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 6. Route Calc    │  (Mapbox Directions — khoảng cách,
│                  │   thời gian, polyline)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 7. Order Optimize│  (TSP heuristic: nearest-neighbor / 2-opt)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 8. Budget Est.   │  (tổng hotel + food + ticket + transport)
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ 9. Validation    │  (vượt budget, quá xa, dày, đóng cửa)
└──────┬───────────┘
       │  (revise nếu fail)
       │
       ▼
┌──────────────────┐
│ 10. Final Output │  (JSON trả về frontend)
└──────────────────┘
```

---

## 2. Chi tiết từng bước

### Bước 1 — Intent Agent (OpenAI)

**Input:**
```json
{ "prompt": "Tôi muốn đi Đà Lạt 3 ngày 2 đêm, ngân sách 5 triệu, đi 2 người, thích cafe, thiên nhiên, ít đi bộ." }
```

**Tool:** OpenAI Chat Completions với structured output (function calling / JSON mode).

**Output:**
```json
{
  "destination": "Đà Lạt",
  "duration": "3 ngày 2 đêm",
  "budget": 5000000,
  "people": 2,
  "preferences": ["cafe", "thiên nhiên", "ít đi bộ"]
}
```

**Nếu thiếu:** Trả `clarificationQuestion` cho frontend, vòng lại khi user trả lời.

---

### Bước 2 — Search Pool (Google Places)

**Input:**
```json
{ "destination": "Đà Lạt", "preferences": ["cafe", "thiên nhiên", "ít đi bộ"] }
```

**Tool gọi song song:**
| Tool | Query mẫu | Mục đích |
|------|-----------|----------|
| `searchPlaces()` | "Đà Lạt nature view cafe" | Điểm tham quan + check-in |
| `searchHotels()` | "Đà Lạt hotel homestay" | Khách sạn làm điểm xuất phát mỗi ngày |
| `searchRestaurants()` | "Đà Lạt restaurant" | Quán ăn theo budget |

**Output:** Mỗi tool trả list `placeId` (raw, chưa có detail).

---

### Bước 3 — Place Details (Google Place Details)

**Input:** List `placeId` từ bước 2.

**Tool:** Google Place Details API (gọi song song theo batch).

**Output mỗi place:**
```json
{
  "name": "Still Cafe",
  "lat": 11.940,
  "lng": 108.430,
  "rating": 4.6,
  "address": "...",
  "photoUrl": "...",
  "category": "cafe",
  "estimatedDuration": 90,
  "estimatedCost": 120000,
  "openingHours": [...]
}
```

---

### Bước 4 — Scoring & Filtering (OpenAI + công thức)

**Input:** Toàn bộ pool đã có detail + intent.

**Công thức chấm điểm:**
```
Final Score =
  0.35 × Preference Match
+ 0.20 × Rating
+ 0.15 × Popularity
+ 0.10 × Time Fit
- 0.10 × Cost Penalty
- 0.10 × Distance Penalty
```

**Tool:** OpenAI — đánh giá `Preference Match` và `Time Fit` (dựa trên preferences + giờ mở cửa + loại hình).

**Quy tắc ưu tiên từ CLAUDE.md:**
- Match `cafe + thiên nhiên + ít đi bộ` → + điểm mạnh: cafe view đẹp, hồ, đồi, check-in nhẹ.
- Trừ điểm: trekking, thác phải đi bộ, điểm quá xa, vé cao.

**Output:** List điểm đã sort theo score, kèm flag `kept` / `dropped`.

---

### Bước 5 — Clustering theo ngày

**Input:** Danh sách điểm `kept` + số ngày `N` (từ duration) + hotel anchor (lat/lng).

**Thuật toán:**
1. Chọn `hotel` gần trung tâm cluster nhất làm anchor.
2. Phân cụm bằng k-means / DBSCAN theo (lat, lng) — `eps` ≈ bán kính trung bình 1 ngày đi bộ + xe (~8–12 km).
3. Chia đều số cụm cho `N` ngày (ưu tiên cụm nhiều điểm vào ngày "rộng" hơn).
4. Mỗi cụm trở thành 1 `day` với:
   - `title` (do OpenAI đặt)
   - `color` (frontend dùng để phân biệt marker)

**Output:**
```json
[
  { "day": 1, "title": "Trung tâm Đà Lạt nhẹ nhàng", "color": "blue", "placeIds": [...] },
  { "day": 2, "title": "Hồ Xuân Hương & Cafe view", "color": "green", "placeIds": [...] },
  { "day": 3, "title": "Đồi chè & check-in",        "color": "orange", "placeIds": [...] }
]
```

---

### Bước 6 — Route Calculation (Mapbox Directions)

**Input:** Mỗi `day` có list điểm theo thứ tự tạm thời.

**Tool:** `calculateRoutes()` → Mapbox Directions API.
- `profile`: `driving` (mặc định) hoặc `walking` nếu user chọn "ít di chuyển".
- `geometries`: `geojson` (để frontend vẽ polyline).
- `steps`: `false` (chỉ cần tổng distance + duration).

**Output mỗi cung:**
```json
{
  "distanceKm": 4.2,
  "durationMin": 12,
  "polyline": "..."
}
```

---

### Bước 7 — Order Optimization (TSP heuristic)

**Input:** Ma trận thời gian di chuyển `T[i][j]` từ bước 6.

**Thuật toán:**
1. **Nearest-Neighbor** khởi tạo: từ hotel → điểm gần nhất → tiếp tục.
2. **2-opt** cải thiện: đảo cặp cung nếu giảm tổng `T`.
3. Gắn `time` cho từng item theo:
   ```
   time[i+1] = time[i] + visitDuration[i] + travelTime[i → i+1]
   ```
4. Đảm bảo `time` không rơi vào giờ đóng cửa (dịch sang slot mở cửa gần nhất).

**Output:** Mỗi `day.items` đã có thứ tự + `time` + `travelTimeFromPrevious`.

---

### Bước 8 — Budget Estimation

**Công thức:**
```
Total = hotel + food + transport + tickets + cafe + backup
```

| Hạng mục | Cách tính |
|----------|-----------|
| `hotel` | `nights × hotelPricePerNight` (lấy từ Place Details price_level → quy đổi VND) |
| `food` | `people × days × 3 bữa × avgMealCost` (theo budget tier) |
| `transport` | `totalKm × costPerKm` (Mapbox distance × 1500 VND/km taxi trung bình) |
| `tickets` | `Σ estimatedCost` của item type `attraction` |
| `cafe` | `Σ estimatedCost` của item type `cafe` |
| `backup` | `10% × (hotel + food + transport + tickets + cafe)` |

**Output:**
```json
{
  "hotel": 1300000, "food": 1200000, "transport": 800000,
  "tickets": 500000, "cafe": 400000, "backup": 500000,
  "total": 4700000, "withinBudget": true
}
```

---

### Bước 9 — Validation (OpenAI + rule check)

**Check list:**
- [ ] Tổng budget ≤ user budget (nếu không → revise).
- [ ] Mỗi ngày không quá X km di chuyển (rule: ≤ 40 km/ngày).
- [ ] Mỗi ngày không quá N điểm (rule: 4–6 điểm/ngày).
- [ ] Không item nào rơi vào giờ đóng cửa.
- [ ] Ít nhất 1 item / 1 preference trong cả trip.
- [ ] Có gap nghỉ trưa ≥ 60 phút.

**Nếu fail → revise loop:**
- Bỏ item `estimatedCost` cao nhất.
- Chuyển sang `optionalPlaces` (gợi ý phụ).
- Chọn hotel rẻ hơn (-20%).
- Ưu tiên điểm miễn phí.

Tối đa 3 vòng revise. Nếu vẫn fail → trả `warnings` cho user.

---

### Bước 10 — Final Output (JSON cho Frontend)

**Shape cuối:**
```json
{
  "intent": { "destination": "Đà Lạt", "duration": "3 ngày 2 đêm", "budget": 5000000, "people": 2, "preferences": ["cafe", "thiên nhiên", "ít đi bộ"] },
  "itinerary": [
    {
      "day": 1,
      "title": "Trung tâm Đà Lạt nhẹ nhàng",
      "items": [
        {
          "time": "09:00",
          "name": "Quảng trường Lâm Viên",
          "type": "check-in",
          "reason": "Gần trung tâm, dễ đi, phù hợp chụp ảnh nhẹ nhàng.",
          "estimatedCost": 0,
          "estimatedDuration": 60,
          "travelTimeFromPrevious": "10 phút",
          "lat": 11.940, "lng": 108.437,
          "photoUrl": "...",
          "rating": 4.5
        }
      ]
    }
  ],
  "budgetSummary": { "hotel": 1300000, "food": 1200000, "transport": 800000, "tickets": 500000, "cafe": 400000, "backup": 500000, "total": 4700000, "withinBudget": true },
  "mapData": {
    "days": [
      { "day": 1, "color": "blue", "markers": [], "routePolyline": "..." }
    ]
  },
  "warnings": [],
  "optionalPlaces": []
}
```

---

## 3. Bảng tóm tắt tool

| # | Tool | API | Vai trò |
|---|------|-----|---------|
| 1 | `parseIntent()` | OpenAI | Trích 5 trường intent |
| 2 | `searchPlaces()` | Google Places | Điểm tham quan + check-in |
| 3 | `searchHotels()` | Google Places | Khách sạn anchor |
| 4 | `searchRestaurants()` | Google Places | Quán ăn theo budget |
| 5 | `getPlaceDetails()` | Google Place Details | lat/lng, rating, photo, cost |
| 6 | `scoreAndFilter()` | OpenAI + rule | Tính điểm + lọc |
| 7 | `clusterByDay()` | Local (k-means/DBSCAN) | Chia cụm theo ngày |
| 8 | `calculateRoutes()` | Mapbox Directions | distance, duration, polyline |
| 9 | `optimizeOrder()` | Local (NN + 2-opt) | Sắp thứ tự trong ngày |
| 10 | `estimateBudget()` | Local rule | Tổng chi phí |
| 11 | `validateItinerary()` | OpenAI + rule | Checklist + revise |

---

## 4. Action buttons (Regenerate flow)

Khi user bấm **Regenerate / Cheaper / More relaxed / More food**, luồng phụ:

```
User action
   → load plan cũ từ PostgreSQL
   → giữ intent, đổi constraint (budget cap, pace, food_count)
   → chạy lại từ bước 4 (Scoring) trở đi, KHÔNG gọi lại Search Pool
   → validate + trả về
```

Nhờ vậy response nhanh (~3–5s) và tiết kiệm quota Google Places.
