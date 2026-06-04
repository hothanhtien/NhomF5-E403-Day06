import json
import os
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

# preferences is optional — empty list is valid (plan a general trip)
INTENT_FIELDS = ["destination", "duration", "budget", "people"]

SYSTEM_PROMPT = """Bạn là travel planner AI. Hãy phân tích yêu cầu du lịch của người dùng.

Trích xuất 5 trường sau:
- destination: string (tên địa điểm tiếng Việt)
- duration: string (ví dụ "3 ngày 2 đêm")
- budget: number (VND, số nguyên)
- people: number (số người)
- preferences: array of strings (sở thích, phong cách)

QUAN TRỌNG — Xử lý trường hợp người dùng CHƯA có điểm đến:
Nếu người dùng nói họ chưa biết muốn đi đâu nhưng mô tả phong cách (yên tĩnh, mát mẻ, biển, núi, v.v.),
hãy TỰ GỢI Ý một điểm đến phù hợp tại Việt Nam dựa trên sở thích đó và điền vào "destination".
Ví dụ: "yên tĩnh, mát mẻ, cảnh đẹp" → gợi ý "Đà Lạt" hoặc "Mộc Châu" hoặc "Sapa".
KHÔNG hỏi lại về destination nếu user đã nói rõ họ không có điểm đến cụ thể.

Trả về JSON duy nhất theo format:
{
  "destination": null hoặc string,
  "duration": null hoặc string,
  "budget": null hoặc number,
  "people": null hoặc number,
  "preferences": [] hoặc array,
  "clarification": null hoặc string,
  "destinationSuggested": true/false
}

Quy tắc clarification:
- Nếu destination vẫn null sau khi đã cố gợi ý, MỚI hỏi về destination.
- Nếu thiếu các trường khác (duration, budget, people), hỏi ngắn gọn về trường đó.
- Nếu đủ thông tin, để clarification là null."""


async def parse_intent(conversation: list[dict]) -> dict:
    """
    conversation: list of {"role": "user"|"assistant", "content": str}
    Returns intent dict with optional clarification key.
    Raises RuntimeError on OpenAI failure.
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}] + conversation

    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=512,
        )
        intent = json.loads(response.choices[0].message.content)
    except Exception as exc:
        raise RuntimeError(f"Intent parsing failed: {exc}") from exc

    return intent


def is_intent_complete(intent: dict) -> bool:
    """Returns True only if all 5 required fields are present and non-null."""
    return all(
        intent.get(f) not in (None, "", [])
        for f in INTENT_FIELDS
    )
