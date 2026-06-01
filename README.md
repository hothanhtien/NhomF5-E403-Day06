# Counter — Frontend + FastAPI

Press the button. Count things. FE và BE tách hẳn.

## Cấu trúc
```
.
├── backend/             # FastAPI — API only
│   ├── Dockerfile
│   ├── main.py
│   └── requirements.txt
├── frontend/            # Static — HTML/CSS/JS, serve tĩnh
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── package.json
├── cloudflared/         # Tunnel credentials (của bạn, không sửa)
└── docker-compose.yml   # Chỉ chạy backend
```

## Chạy

**Backend (FastAPI):**
```bash
docker compose up -d --build
# API ở http://localhost:8001
```

**Frontend (cần Node để chạy `serve`):**
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
