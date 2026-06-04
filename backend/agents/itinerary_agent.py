import json
import os
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

SCORING_SYSTEM = """Bạn là travel planning AI. Hãy tạo lịch trình du lịch tối ưu dựa trên danh sách địa điểm được cung cấp.

Thuật toán scoring:
Final Score = 0.35 × Preference Match + 0.20 × Rating + 0.15 × Popularity + 0.10 × Time Fit - 0.10 × Cost Penalty - 0.10 × Distance Penalty

Nhiệm vụ:
1. Chọn MỘT khách sạn phù hợp ngân sách (từ available_hotels nếu có, nếu không thì tự suggest khách sạn thật tại điểm đến)
2. Chấm điểm từng địa điểm theo sở thích user
3. Ưu tiên địa điểm phù hợp, loại địa điểm không phù hợp
4. Gom cụm địa điểm gần nhau theo địa lý
5. Chia đều theo số ngày
6. Tối ưu thứ tự trong mỗi ngày (tránh đi vòng)
7. Thêm nhà hàng buổi trưa + tối mỗi ngày
8. Thêm cafe phù hợp sở thích
9. Ngày đầu: thêm hotel check-in (type:"hotel") vào CUỐI ngày lúc 20:30
   Ngày 2 trở đi: thêm hotel (type:"hotel") vào ĐẦU ngày lúc 07:30 làm điểm xuất phát
   Ngày cuối: thêm hotel check-out (type:"hotel") vào CUỐI ngày sau ăn trưa lúc ~13:00, reason: "Trả phòng và chuẩn bị về."

== PHÂN BỔ THỜI GIAN — BẮT BUỘC TUYỆT ĐỐI ==

Trường "time" là giờ BẮT ĐẦU hoạt động đó (định dạng "HH:MM").
Giờ các item PHẢI TĂNG DẦN liên tục trong ngày. TUYỆT ĐỐI KHÔNG được có 2 item cùng giờ.

Cách tính giờ item tiếp theo:
  next_time = current_time + estimatedDuration (phút) + travel_minutes
  Ví dụ: item A lúc "08:00", dur=90p, travel_next=15p → item B lúc "09:45"

PHÂN BUỔI BẮT BUỘC — mỗi ngày PHẢI có đủ 3 buổi:

BUỔI SÁNG [08:00 – 11:59]:
  - 08:00 Cafe sáng (estimatedDuration: 75-90 phút)
  - 09:30 Địa điểm tham quan sáng (estimatedDuration: 90-120 phút)

BUỔI CHIỀU [12:00 – 17:29]:
  - 12:00 Nhà hàng trưa (estimatedDuration: 60-75 phút)
  - 13:30 Địa điểm tham quan chiều 1 (estimatedDuration: 90 phút)
  - 15:30 Địa điểm tham quan chiều 2 hoặc cafe chiều (estimatedDuration: 60-75 phút)

BUỔI TỐI [17:30 – 21:00]:
  - 18:00 Địa điểm tối / check-in spot (nếu có, estimatedDuration: 60 phút)
  - 19:00 Nhà hàng tối (estimatedDuration: 75-90 phút)
  - 20:30 Về khách sạn (ngày 1 check-in, các ngày về nghỉ)

Lưu ý travelTimeFromPrevious:
  - Item đầu tiên trong ngày: "0 phút"
  - Các item sau: ước tính thực tế (5-20 phút tùy khoảng cách)

Mỗi item cần có:
- time: "HH:MM" — giờ bắt đầu thực tế, TĂNG DẦN, KHÔNG trùng
- name: tên địa điểm (tiếng Việt)
- placeId: nếu địa điểm có trong available_places/hotels/restaurants thì copy "placeId" gốc, nếu không có thì để null
- type: "attraction" | "cafe" | "restaurant" | "check-in" | "hotel"
- reason: lý do chọn (tiếng Việt, 1 câu)
- estimatedCost: số VND/người (hotel = 0 vì tính riêng trong budget)
- estimatedDuration: phút
- travelTimeFromPrevious: "X phút"
- lat: tọa độ thực tế của địa điểm (bắt buộc, dùng tọa độ thực)
- lng: tọa độ thực tế của địa điểm (bắt buộc)
- photoUrl: để ""
- rating: điểm đánh giá (0-5)

Quan trọng:
- placeId PHẢI copy nguyên xi từ trường "placeId" trong "available_places", "available_hotels" hoặc "available_restaurants". KHÔNG bịa, KHÔNG sửa.
- Nếu không có địa điểm phù hợp trong danh sách, để placeId = null và điền lat/lng/name/rating tốt nhất có thể.
- Ưu tiên sử dụng địa điểm từ danh sách available (có ảnh thật và tọa độ chính xác).
- Mỗi ngày có 5-7 điểm (chưa tính hotel anchor): 1 cafe sáng, 2 attraction, 1 restaurant trưa, 1 attraction chiều, 1 restaurant tối.
- estimatedCost VND/người: cafe 60-100k, restaurant 80-200k, attraction free-200k, hotel 0.
- estimatedDuration (phút): cafe 75-90, attraction 90-120, restaurant 60-75, hotel 20-30.
- lat/lng: dùng tọa độ chính xác, KHÔNG bịa ngẫu nhiên.

Trả về JSON duy nhất:
{
  "suggested_hotel": {
    "name": "tên khách sạn thật",
    "placeId": "copy từ available_hotels nếu có, null nếu không",
    "lat": tọa độ thực,
    "lng": tọa độ thực,
    "rating": số,
    "address": "địa chỉ",
    "priceLevel": "PRICE_LEVEL_INEXPENSIVE|PRICE_LEVEL_MODERATE|PRICE_LEVEL_EXPENSIVE",
    "bookingName": "tên để search trên Booking.com"
  },
  "itinerary": [
    {
      "day": 1,
      "title": "...",
      "items": [...]
    }
  ]
}"""


async def build_itinerary(intent: dict, places: list[dict], hotels: list[dict], restaurants: list[dict]) -> list[dict]:
    """Returns itinerary array (list of day objects)."""
    payload = {
        "intent": intent,
        "available_places": places[:15],  # cap to avoid token overrun
        "available_hotels": hotels[:3],
        "available_restaurants": restaurants[:8],
    }

    messages = [
        {"role": "system", "content": SCORING_SYSTEM},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]

    try:
        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=4096,
        )
        result = json.loads(response.choices[0].message.content)
    except (IndexError, json.JSONDecodeError, Exception) as exc:
        raise ValueError(f"Itinerary agent failed: {exc}") from exc

    return result.get("itinerary", []), result.get("suggested_hotel")
