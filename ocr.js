
// ocr.js — full-page OCR helpers
import { log } from 'apify';
import sharp from 'sharp';
import Tesseract from 'tesseract.js';

export async function ocrImageBuffer(buffer) {
  const prepped = await sharp(buffer).grayscale().normalize().sharpen().toBuffer();
  const { data } = await Tesseract.recognize(prepped, 'eng', {});
  const text = data?.text || '';
  log.debug(`OCR chars: ${text.length}`);
  return text;
}

export function heuristicsExtractPromos(rawText) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const promos = [];
  for (const line of lines) {
    if (
      /%\s*off/i.test(line) ||
      /\b(BOGO|bundle|deal|sale|special|happy hour|buy\s+\d+\s+get|flash|vendor day|vendor-night|pop[-\s]?up|event)\b/i.test(line)
    ) {
      promos.push({ type: 'promotion_or_event', text: line });
    }
  }
  return promos;
}
