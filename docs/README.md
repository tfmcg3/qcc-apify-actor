
# QCC Apify Actor — Dutchie Menu Intelligence

GraphQL → DOM → OCR+AI pipeline for Quincy Cannabis Co. and nearby competitors.

## Quick Start
1) Install Apify CLI.
2) `apify create qcc-apify-actor --template empty` and copy this repo in.
3) Set env vars in Apify or locally: OPENAI_API_KEY, optional GCHAT_WEBHOOK_URL.
4) `apify run -p` and choose `INPUT.example.json`.
5) Check the run's Datasets: primary (graphql/dom) and `QCC_Menu_OCR_YYYYMMDD`.

## Inputs
- startUrls: Dutchie menu URLs (QCC first, then competitors within ~10 miles).
- useOCRBackup: enable screenshot+OCR safety net.
- useAIParser: parse OCR text into structured rows.
- openaiModel: e.g. gpt-4o-mini.
- promoHeuristicsEnabled: regex-based promo/event scan.

## Outputs
- Primary Dataset: product rows from GraphQL/DOM (source field shows origin).
- OCR Dataset: `QCC_Menu_OCR_YYYYMMDD` with `products` and `promotion` rows.
- KV Artifacts: full-page screenshots and OCR text/JSON per tab/deals page.

## Scheduling
- 02:00 ET full scrape, 13:00 ET quick refresh.

## Secrets
- Never hardcode keys. Use Apify Environment variables.
- OPENAI_API_KEY, optional GCHAT_WEBHOOK_URL.
