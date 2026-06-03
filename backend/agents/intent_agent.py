import json
import os
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])

INTENT_FIELDS = ["destination", "duration", "budget", "people", "preferences"]

SYSTEM_PROMPT = """Bạn là travel planner AI. Hãy phân tích yêu cầu du lịch của người dùng.

Trích xuất 5 trường sau:
- destination: string (tên địa điểm tiếng Việt)
- duration: string (ví dụ "3 ngày 2 đêm")
- budget: number (VND, số nguyên)
- people: number (số người)
- preferences: array of strings (sở thích, phong cách)

Trả về JSON duy nhất theo format:
{
  "destination": null hoặc string,
  "duration": null hoặc string,
  "budget": null hoặc number,
  "people": null hoặc number,
  "preferences": [] hoặc array,
  "clarification": null hoặc string
}

Nếu thiếu bất kỳ trường nào (null hoặc rỗng), hãy điền "clarification" bằng câu hỏi tự nhiên bằng tiếng Việt để hỏi lại người dùng.
Nếu đủ thông tin, để clarification là null."""


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
