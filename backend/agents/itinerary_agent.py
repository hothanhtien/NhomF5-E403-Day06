import json
import os
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

SCORING_SYSTEM = """Bạn là travel planning AI. Hãy tạo lịch trình du lịch tối ưu dựa trên danh sách địa điểm được cung cấp.

Thuật toán scoring:
Final Score = 0.35 × Preference Match + 0.20 × Rating + 0.15 × Popularity + 0.10 × Time Fit - 0.10 × Cost Penalty - 0.10 × Distance Penalty

Nhiệm vụ:
1. Chấm điểm từng địa điểm theo sở thích user
2. Ưu tiên địa điểm phù hợp, loại địa điểm không phù hợp
3. Gom cụm địa điểm gần nhau theo địa lý
4. Chia đều theo số ngày
5. Tối ưu thứ tự trong mỗi ngày (tránh đi vòng)
6. Thêm nhà hàng buổi trưa + tối mỗi ngày
7. Thêm cafe phù hợp sở thích
8. Bắt đầu mỗi ngày từ 08:00, kết thúc ~21:00

Mỗi item cần có:
- time: "HH:MM"
- name: tên địa điểm (tiếng Việt)
- placeId: nếu địa điểm có trong available_places/hotels/restaurants thì copy "placeId" gốc, nếu không có thì để null
- type: "attraction" | "cafe" | "restaurant" | "check-in" | "hotel"
- reason: lý do chọn (tiếng Việt, 1 câu)
- estimatedCost: số VND/người
- estimatedDuration: phút
- travelTimeFromPrevious: "X phút"
- lat: tọa độ thực tế của địa điểm
- lng: tọa độ thực tế của địa điểm
- photoUrl: để ""
- rating: điểm đánh giá (0-5)

Trả về JSON duy nhất:
{
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

    return result.get("itinerary", [])
