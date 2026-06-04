# AI Travel Planner Agent

AI Agent hỗ trợ lập kế hoạch du lịch đầu-cuối: parse intent → tìm địa điểm (Google Places) → tối ưu lịch trình → render map (Mapbox) → lưu PostgreSQL.

## 🌐 URL Deploy

| Môi trường | URL | Ghi chú |
|---|---|---|
| **Production (Cloudflare Tunnel)** | https://tienop.khoav4.com | Domain chính, đi qua cloudflared |
| **Local (qua nginx)** | http://localhost:8080 | Truy cập trực tiếp container nginx |
| **Local (FE dev mode)** | http://localhost:5173 | Chạy `npm run dev` trong `frontend/` |
| **Backend API (internal)** | http://localhost:8001 | FastAPI, chỉ nginx proxy, không public trực tiếp |

> ⚠️ Sau khi deploy, đợi ~30s cho cloudflared khởi tạo tunnel rồi mới truy cập `https://tienop.khoav4.com`.

## Cấu trúc
```
.
├── backend/             # FastAPI — API only
│   ├── agents/          # Intent + Itinerary agents
│   ├── routers/         # /chat, /plans
│   ├── tools/           # Places, Routes, Budget, Optimizer
│   ├── main.py
│   └── requirements.txt
├── frontend/            # Static — HTML/CSS/JS, serve tĩnh
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── package.json
├── nginx/               # Reverse proxy config
├── cloudflared/         # Tunnel credentials (của bạn, không sửa)
└── docker-compose.yml   # Orchestration: backend + nginx + cloudflared
```

## Chạy

**Toàn bộ stack (backend + nginx + cloudflared):**
```bash
docker compose up -d --build
# Web: http://localhost:8080
# Sau ~30s: https://tienop.khoav4.com
```

**Chỉ Backend (FastAPI, dev):**
```bash
docker compose up -d --build backend
# API ở http://localhost:8001 (chỉ nginx proxy, không public)
```

**Frontend dev mode (cần Node):**
```bash
cd frontend
npm run dev
# Mở http://localhost:5173
```

Mặc định FE gọi `http://localhost:8001`. Đổi nhanh bằng query string:
```
http://localhost:5173/?api=http://192.168.1.10:8001
```

## Chạy FE không cần npm
Mở `frontend/index.html` thẳng trong browser cũng được, nhưng phải truyền
`?api=...` vì `file://` không có origin để gọi CORS.

```
file:///path/to/frontend/index.html?api=http://localhost:8001
```

## API
| Method | Endpoint           | Description    |
| ------ | ------------------ | -------------- |
| GET    | `/api/count`       | Read counter   |
| POST   | `/api/increment`   | `count + 1`    |
| POST   | `/api/decrement`   | `count - 1`    |
| POST   | `/api/reset`       | `count = 0`    |

## Phím tắt (UI)
- `Space` / `↑` — increment
- `↓` — decrement
- `R` — reset

## CORS
`backend/main.py` đã `allow_origins=["*"]` nên FE ở domain/port nào cũng gọi
được. Khi lên prod, đổi thành origin cụ thể.
