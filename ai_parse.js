
// ai_parse.js — AI parsing of OCR text into structured JSON via OpenAI-compatible API
import fetch from 'node-fetch';

const SYS = `You are a precise information extractor.
Given raw OCR text from a cannabis dispensary menu page, return JSON with two arrays:
- products: [{product_name, brand, category, size, price, price_sale, thc_percent, cbd_percent, stock_status}]
- promotions: [{title, details, discount_pct, start_date, end_date, type, raw}]
Rules:
- Parse prices as numbers (no $).
- If a promo states a percent or BOGO, infer discount_pct when explicit.
- category: one of ["flower","pre-roll","vape","edible","concentrate","topical","tincture","accessory","other"].
- stock_status: in_stock | low_stock | out_of_stock | null.
- If multiple variants/sizes exist, output multiple product entries with distinct "size"/"price".
Return ONLY JSON.`;

export async function parseOCRToStructured(rawText, { apiKey, model = 'gpt-4o-mini', baseURL } = {}) {
  if (!apiKey) throw new Error('OPENAI_API_KEY missing for AI parsing.');
  const url = baseURL || 'https://api.openai.com/v1/chat/completions';

  const body = {
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: rawText.slice(0, 180_000) },
    ],
    response_format: { type: 'json_object' },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`AI parse error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}
