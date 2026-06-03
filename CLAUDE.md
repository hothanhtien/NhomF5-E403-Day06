Bạn là một Senior Fullstack Engineer.

tôi đnag cần build
 AI Travel Planner Agent là một hệ thống AI Agent hỗ trợ lập kế hoạch du lịch đầu-cuối (end-to-end). Người dùng chỉ cần mô tả nhu cầu bằng ngôn ngữ tự nhiên, agent sẽ tự động thu thập và làm rõ các intent còn thiếu, sau đó sử dụng nhiều công cụ để tìm kiếm địa điểm, tối ưu lịch trình, hiển thị trên bản đồ và gợi ý khách sạn hoặc dịch vụ phù hợp. Thay vì chỉ trả lời câu hỏi, agent có khả năng chủ động lập kế hoạch và hỗ trợ ra quyết định, giúp người dùng xây dựng một chuyến đi hoàn chỉnh trong vài phút.

Nhiệm vụ: sửa source code hiện tại để build một web app hoàn chỉnh tên  **AI Travel Planner Agent** .

## Yêu cầu quan trọng

Giữ nguyên toàn bộ luồng DevOps hiện tại:

* Không phá cấu trúc `docker-compose`
* Không phá nginx config
* Không phá cloudflared setup
* Không đổi port nếu không cần thiết
* Không đổi flow deploy hiện tại
* Sau khi tôi pull code trên server và chạy:

```bash
docker-compose up -d --build
```

thì hệ thống vẫn phải hoạt động bình thường.

Chỉ được sửa phần **Frontend** và **Backend** để triển khai sản phẩm.

---

# Product cần build

**AI Travel Planner Agent** là hệ thống AI Agent hỗ trợ lập kế hoạch du lịch đầu-cuối.

Người dùng chỉ cần nhập nhu cầu bằng ngôn ngữ tự nhiên, ví dụ:

```text
Tôi muốn đi Đà Lạt 3 ngày 2 đêm, ngân sách 5 triệu, đi 2 người, thích cafe, thiên nhiên và ít đi bộ.
```

Agent sẽ:

1. Tự phân tích intent người dùng
2. Hỏi lại nếu thiếu thông tin
3. Khi đủ intent thì tìm địa điểm phù hợp
4. Gợi ý khách sạn / homestay
5. Tối ưu lịch trình theo ngày
6. Tính ngân sách dự kiến
7. Hiển thị lịch trình trên bản đồ
8. Hiển thị ảnh thật của địa điểm
9. Cho phép user regenerate hoặc chỉnh lại ràng buộc

---

# Tech/API được dùng

Chỉ dùng các API/tool sau:

```text
1. OpenAI
2. Google Places
3. Mapbox
```

Database đã được host sẵn trên server:

```text
jdbc:postgresql://100.98.146.87:15432/travel6
```

Nếu backend cần connection string dạng chuẩn Node/Python thì tự chuyển sang format phù hợp, ví dụ:

```text
postgresql://USER:PASSWORD@100.98.146.87:15432/travel6
```

Không hard-code secret trong code. Dùng `.env`.

Cần tạo/cập nhật `.env.example` gồm:

```env
OPENAI_API_KEY=
GOOGLE_MAPS_API_KEY=
MAPBOX_ACCESS_TOKEN=
DATABASE_URL=
```

---

# Workflow chính của hệ thống

## 1. User nhập prompt

Frontend có ô chat/input lớn để user nhập nhu cầu du lịch.

Ví dụ:

```text
Tôi muốn đi Đà Lạt 3 ngày 2 đêm, ngân sách 5 triệu, đi 2 người, thích cafe, thiên nhiên, ít đi bộ.
```

---

## 2. Intent Agent

Backend dùng OpenAI để parse 5 intent chính:

```text
- Địa điểm
- Thời gian
- Ngân sách
- Số người
- Sở thích
```

Output dạng JSON:

```json
{
  "destination": "Đà Lạt",
  "duration": "3 ngày 2 đêm",
  "budget": 5000000,
  "people": 2,
  "preferences": ["cafe", "thiên nhiên", "ít đi bộ"]
}
```

Nếu thiếu thông tin thì backend trả về câu hỏi clarification.

Ví dụ thiếu số người:

```text
Bạn đi mấy người để mình tính khách sạn và ngân sách chính xác hơn?
```

Frontend hiển thị câu hỏi đó để user trả lời tiếp.

---

# 3. Khi đủ intent thì Planning Agent chạy

Backend bắt đầu gọi tool theo flow:

```text
OpenAI Intent Agent
      ↓
Google Places Search Tool
      ↓
Google Place Details Tool
      ↓
Google Places Hotel / Restaurant Search
      ↓
Mapbox Route Tool
      ↓
OpenAI Itinerary Optimizer
      ↓
Budget Estimator
      ↓
Validation Agent
      ↓
Mapbox Map Renderer
      ↓
Final Output
```

---

# Tool cần implement trong backend

## 1. searchPlaces()

Dùng Google Places API để tìm:

```text
- Địa điểm tham quan
- Cafe
- Nhà hàng
- Điểm check-in
- Hoạt động phù hợp sở thích
```

Input:

```json
{
  "destination": "Đà Lạt",
  "preferences": ["cafe", "thiên nhiên", "ít đi bộ"]
}
```

---

## 2. getPlaceDetails()

Dùng Google Place Details API để lấy:

```text
- Tên địa điểm
- Tọa độ lat/lng
- Rating
- Địa chỉ
- Giờ mở cửa
- Ảnh địa điểm
- Số lượng review nếu có
- Loại địa điểm
```

Mỗi place cần có cấu trúc:

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
  "estimatedCost": 120000
}
```

---

## 3. searchHotels()

Dùng Google Places API để tìm khách sạn/homestay tại destination.

Khách sạn được dùng làm điểm xuất phát mỗi ngày.

---

## 4. searchRestaurants()

Dùng Google Places API để tìm nhà hàng/quán ăn phù hợp ngân sách.

---

## 5. calculateRoutes()

Dùng Mapbox Directions API để tính:

```text
- Khoảng cách giữa các điểm
- Thời gian di chuyển
- Route polyline
```

---

## 6. optimizeItinerary()

Dùng OpenAI để tối ưu lịch trình.

Thuật toán scoring:

```text
Final Score =
0.35 × Preference Match
+ 0.20 × Rating
+ 0.15 × Popularity
+ 0.10 × Time Fit
- 0.10 × Cost Penalty
- 0.10 × Distance Penalty
```

Agent cần:

```text
- Chấm điểm từng địa điểm
- Loại địa điểm không phù hợp
- Gom cụm địa điểm gần nhau
- Chia cụm theo từng ngày
- Tối ưu route trong mỗi ngày
- Tránh đi vòng
- Tránh lịch quá dày
- Ưu tiên đúng sở thích user
```

Ví dụ:

Nếu user thích cafe + thiên nhiên + ít đi bộ:

```text
Ưu tiên:
- Cafe view đẹp
- Hồ
- Đồi
- Điểm check-in nhẹ

Giảm điểm:
- Trekking
- Thác phải đi bộ nhiều
- Điểm quá xa
- Điểm vé cao
```

---

## 7. estimateBudget()

Tính ngân sách dự kiến:

```text
Tổng chi phí =
Khách sạn
+ Ăn uống
+ Cafe
+ Vé tham quan
+ Di chuyển
+ Dự phòng
```

Nếu vượt ngân sách thì agent phải tự revise:

```text
- Bỏ điểm có phí cao
- Chuyển điểm đắt thành optional
- Chọn khách sạn rẻ hơn
- Ưu tiên điểm miễn phí
```

---

## 8. validateItinerary()

Kiểm tra trước khi trả kết quả:

```text
- Có vượt ngân sách không?
- Có đi quá xa không?
- Có quá nhiều điểm trong 1 ngày không?
- Có trùng giờ đóng cửa không?
- Có phù hợp sở thích không?
- Có đủ thời gian nghỉ không?
```

Nếu invalid thì revise lại itinerary.

---

# Output backend cần trả về

Final response dạng JSON:

```json
{
  "intent": {
    "destination": "Đà Lạt",
    "duration": "3 ngày 2 đêm",
    "budget": 5000000,
    "people": 2,
    "preferences": ["cafe", "thiên nhiên", "ít đi bộ"]
  },
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
          "lat": 11.940,
          "lng": 108.437,
          "photoUrl": "...",
          "rating": 4.5
        }
      ]
    }
  ],
  "budgetSummary": {
    "hotel": 1300000,
    "food": 1200000,
    "transport": 800000,
    "tickets": 500000,
    "cafe": 400000,
    "backup": 500000,
    "total": 4700000,
    "withinBudget": true
  },
  "mapData": {
    "days": [
      {
        "day": 1,
        "color": "blue",
        "markers": [],
        "routePolyline": "..."
      }
    ]
  },
  "warnings": [],
  "optionalPlaces": []
}
```

---

# Frontend cần build

Giao diện web hiện đại, sạch, demo tốt.

Các phần chính:

## 1. Hero/Input Section

* Tiêu đề: AI Travel Planner Agent
* Mô tả ngắn
* Textarea cho user nhập prompt
* Button: Generate Trip

## 2. Clarification Chat

Nếu thiếu intent, hiển thị câu hỏi của agent.

User trả lời tiếp, hệ thống nối context và parse lại.

## 3. Itinerary View

Hiển thị:

```text
Day 1
- Time
- Place name
- Image
- Rating
- Reason selected
- Estimated cost
- Travel time
```

## 4. Budget Panel

Hiển thị:

```text
Hotel
Food
Transport
Tickets
Cafe
Backup
Total
```

Có cảnh báo nếu vượt ngân sách.

## 5. Map View

Dùng Mapbox GL JS để hiển thị:

```text
- Marker từng địa điểm
- Route từng ngày
- Polyline
- Popup ảnh địa điểm
- Rating
- Cost
```

Marker của mỗi ngày nên có màu khác nhau.

## 6. Action Buttons

Thêm các nút:

```text
Regenerate itinerary
Make it cheaper
Make it more relaxed
Add more food places
```

---

# Backend API cần có gen sao cho phù hợp

---

# Database

dùng typeorm

---

# DevOps constraints

Tuyệt đối không làm hỏng:

```text
- docker-compose.yml
- nginx
- cloudflared
- Dockerfile hiện tại
- Port mapping hiện tại
```

Chỉ chỉnh nếu thật sự cần và phải đảm bảo:

```bash
docker-compose up -d --build
```

chạy thành công.

Sau khi sửa xong cần kiểm tra:

```bash
docker-compose config
docker-compose up -d --build
docker-compose ps
```

---

# Acceptance Criteria

Web app hoàn chỉnh cần đạt:

```text
1. User nhập prompt du lịch tự nhiên
2. Agent hỏi lại nếu thiếu 1 trong 5 intent
3. Khi đủ intent, agent tạo lịch trình theo ngày
4. Lịch trình có ảnh thật địa điểm từ Google Places
5. Có rating, lý do chọn, chi phí dự kiến
6. Có budget summary
7. Có map Mapbox với marker và route
8. Có regenerate / chỉnh style lịch trình
9. Backend lưu plan vào PostgreSQL
10. Deploy bằng docker-compose up -d --build không lỗi
```

Hãy đọc source code hiện tại trước, xác định framework FE/BE đang dùng, sau đó sửa trực tiếp vào cấu trúc hiện tại thay vì rewrite toàn bộ nếu không cần thiết.
