
// main.js — QCC Dutchie menu → GraphQL → DOM → OCR+AI (tabs + deals)
// Runs in apify/actor-node-playwright-chrome. ESM syntax.
// Env vars (optional): OPENAI_API_KEY, GCHAT_WEBHOOK_URL

import { Actor, log, Dataset, KeyValueStore } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

// -------------------- Utilities --------------------
const TIMEOUT = 60_000;
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

function* walk(obj) {
  if (!obj || typeof obj !== 'object') return;
  yield obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') yield* walk(v);
  }
}

function dedupeProducts(items) {
  const seen = new Set();
  return items.filter((p) => {
    const key = [
      p.product_id ?? '',
      p.variant_id ?? '',
      p.product_name ?? '',
      p.size ?? '',
      p.price ?? '',
      p.price_sale ?? '',
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Try to recognize product-like nodes in Dutchie GraphQL payloads (shape-tolerant)
function extractProductsFromGraphQL(json) {
  const out = [];
  for (const node of walk(json)) {
    const looksLikeProduct =
      (node?.name || node?.productName) &&
      (node?.brand?.name || node?.brandName || node?.brand) &&
      (node?.variants || node?.options || node?.variantOptions || node?.price || node?.prices);

    if (!looksLikeProduct) continue;

    const variants = node.variants || node.options || node.variantOptions || [node];
    const base = {
      product_id: node.id || node._id || node.productId || null,
      product_name: (node.name || node.productName || '').toString().trim(),
      brand: (node.brand?.name || node.brandName || node.brand || '').toString().trim(),
      category: (node.category || node.categoryName || node.type || '').toString().trim() || null,
      strain_type: (node.strainType || node.strain || '').toString().trim() || null,
      description: (node.description || '').toString().trim() || null,
    };

    for (const v of Array.isArray(variants) ? variants : [variants]) {
      const size = v?.size || v?.unit || v?.weight || v?.option || v?.name || null;
      const price = Number(v?.price ?? v?.unitPrice ?? v?.retailPrice ?? node?.price ?? node?.retailPrice ?? NaN);
      const salePrice = Number(v?.salePrice ?? v?.specialPrice ?? v?.discountPrice ?? NaN);
      const thc = Number(v?.thcPercent ?? v?.potencyThc ?? v?.thc ?? node?.thcPercent ?? node?.potencyThc ?? NaN);
      const cbd = Number(v?.cbdPercent ?? v?.potencyCbd ?? v?.cbd ?? node?.cbdPercent ?? node?.potencyCbd ?? NaN);
      const availability = (v?.availability || v?.inStock || node?.availability || '').toString();
      const variant_id = v?.id || v?._id || v?.variantId || null;

      out.push({
        ...base,
        variant_id,
        size,
        price: Number.isFinite(price) ? price : null,
        price_sale: Number.isFinite(salePrice) ? salePrice : null,
        thc_percent: Number.isFinite(thc) ? thc : null,
        cbd_percent: Number.isFinite(cbd) ? cbd : null,
        stock_status: /true|in[_\s-]?stock/i.test(availability)
          ? 'in_stock'
          : /low/i.test(availability)
          ? 'low_stock'
          : /out/i.test(availability)
          ? 'out_of_stock'
          : availability || null,
      });
    }
  }
  return dedupeProducts(out);
}

// Last-resort DOM scrape (lightweight)
async function domScrapeProducts(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let last = 0;
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, document.body.scrollHeight);
      await sleep(350);
      const cur = document.body.scrollHeight;
      if (cur === last) break;
      last = cur;
    }
  });

  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a[href*="/products/"], [data-test*="product"]'));
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return cards.slice(0, 1000).map((el) => {
      const root = el.closest('[class*="product"], [data-test*="product"]') || el;
      const name =
        clean(root.querySelector('h3, h2, [data-test*="name"], [class*="name"]')?.textContent) ||
        clean(el.textContent);
      const brand = clean(root.querySelector('[data-test*="brand"], [class*="brand"]')?.textContent);
      const priceText = clean(root.querySelector('[data-test*="price"], [class*="price"]')?.textContent) || '';
      const price = Number((priceText.match(/[\d,.]+/) || [])[0]?.replace(/,/g, '')) || null;
      const size =
        clean(root.querySelector('[data-test*="size"], [class*="size"], [class*="weight"]')?.textContent) || null;
      const strain =
        clean(root.querySelector('[data-test*="strain"], [class*="strain"], [class*="type"]')?.textContent) || null;
      const stockText = clean(
        root.querySelector('[data-test*="stock"], [class*="stock"], [class*="availability"]')?.textContent
      );
      const stock_status = /out/i.test(stockText) ? 'out_of_stock' : /low/i.test(stockText) ? 'low_stock' : stockText || null;

      return {
        product_id: null,
        product_name: name || null,
        brand: brand || null,
        category: null,
        strain_type: strain || null,
        description: null,
        variant_id: null,
        size,
        price,
        price_sale: null,
        thc_percent: null,
        cbd_percent: null,
        stock_status,
      };
    });
  });
}

async function tryDismissGates(page) {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'button:has-text("I am 21+")',
    'button:has-text("Enter")',
    'text="Accept all"',
    'text="Accept"',
  ];
  for (const sel of candidates) {
    try {
      const btn = await page.waitForSelector(sel, { timeout: 1500 });
      if (btn) await btn.click().catch(() => {});
    } catch {}
  }
}

async function setHiResViewport(page) {
  try {
    await page.setViewportSize({ width: 1440, height: 2000 });
  } catch {}
}

async function findCategoryTabs(page) {
  const selectors = [
    '[data-test*="category"] a',
    '[role="tab"] a',
    'nav a[href*="category"]',
    'a:has-text("Flower")',
    'a:has-text("Pre")',
    'a:has-text("Vape")',
    'a:has-text("Edible")',
    'a:has-text("Concentrate")',
    'a:has-text("Topical")',
    'a:has-text("Tincture")',
  ].join(',');
  return await page.$$eval(selectors, (els) => {
    const seen = new Set();
    return els
      .map((a) => ({ text: (a.textContent || '').trim(), href: a.href }))
      .filter((x) => x.href && !seen.has(x.href) && seen.add(x.href));
  });
}

async function discoverDealsLinks(page) {
  const sel =
    'a:has-text("Deal"), a:has-text("Special"), a:has-text("Sale"), a:has-text("Event"), a:has-text("Vendor"), a:has-text("Happy Hour")';
  const links = await page.$$eval(sel, (as) => as.map((a) => a.href).filter(Boolean));
  return [...new Set(links)];
}

async function chatPing(webhookUrl, text) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) log.warning(`Chat ping non-200: ${res.status}`);
  } catch (e) {
    log.warning(`Chat ping failed: ${e.message}`);
  }
}

// -------------------- MAIN --------------------
await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};
  const {
    startUrls = [
      { url: 'https://dutchie.com/dispensary/quincy-cannabis-quincy-retail-rec' },
    ],
    proxyCountry = 'US',
    proxyGroups,
    datasetName,
    // OCR/AI inputs
    useOCRBackup = true,
    useAIParser = true,
    ocrDatasetName,
    promoHeuristicsEnabled = true,
    openaiModel = 'gpt-4o-mini',
    waitForNetworkIdleMs = 2000,
  } = input;

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.openai_api_key || null;
  const GCHAT_WEBHOOK_URL = process.env.GCHAT_WEBHOOK_URL || input.gchatWebhook || null;

  const proxyConfiguration = await Actor.createProxyConfiguration({
    countryCode: proxyCountry || undefined,
    groups: proxyGroups || undefined,
  });

  const primaryDataset = datasetName ? await Dataset.open(datasetName) : await Dataset.open();
  const kv = await KeyValueStore.open();

  const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ocrDatasetNameFinal = ocrDatasetName || `QCC_Menu_OCR_${todayTag}`;
  const ocrDataset = await Dataset.open(ocrDatasetNameFinal);

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    headless: true,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    launchContext: { launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] } },

    async requestHandler({ request, page, log }) {
      log.info(`→ ${request.url}`);
      await setHiResViewport(page);

      // Capture GraphQL
      let graphQLItems = [];
      page.on('response', async (res) => {
        const url = res.url();
        const type = res.request().resourceType();
        if (!/xhr|fetch/i.test(type)) return;
        if (!/graphql|customer-api|gateway|api/i.test(url)) return;

        try {
          const json = await res.json().catch(() => null);
          if (!json) return;
          const found = extractProductsFromGraphQL(json);
          if (found.length) graphQLItems.push(...found);
        } catch (e) {
          log.debug(`GraphQL parse skip: ${e.message}`);
        }
      });

      // Navigate base page
      await page.goto(request.url, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
      await tryDismissGates(page);
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT }).catch(() => {});
      if (waitForNetworkIdleMs) await page.waitForTimeout(waitForNetworkIdleMs);

      // Lazy load products
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        let last = 0;
        for (let i = 0; i < 10; i++) {
          window.scrollBy(0, document.body.scrollHeight);
          await sleep(300);
          const cur = document.body.scrollHeight;
          if (cur === last) break;
          last = cur;
        }
      });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(600);

      // Primary result set
      let items = graphQLItems;
      if (!items.length) {
        log.warning('GraphQL yielded 0 items. Falling back to DOM scrape.');
        items = await domScrapeProducts(page);
      }

      // Normalize + push to primary dataset
      const ts = new Date().toISOString();
      const competitor = new URL(request.url).pathname.split('/')[2] || 'unknown';
      const menu_url = request.url;

      for (const p of items) {
        await primaryDataset.pushData({
          timestamp_iso: ts,
          competitor,
          menu_url,
          source: items === graphQLItems ? 'graphql' : 'dom',
          product_id: p.product_id ?? null,
          variant_id: p.variant_id ?? null,
          product_name: p.product_name ?? null,
          brand: p.brand ?? null,
          category: p.category ?? null,
          strain_type: p.strain_type ?? null,
          size: p.size ?? null,
          price: p.price ?? null,
          price_sale: p.price_sale ?? null,
          thc_percent: p.thc_percent ?? null,
          cbd_percent: p.cbd_percent ?? null,
          stock_status: p.stock_status ?? null,
          description: p.description ?? null,
        });
      }

      // -------------------- Plan C: OCR + AI (tabs + deals) --------------------
      const categoryShots = [];

      // discover category tabs + deals/specials/event pages
      const tabs = await findCategoryTabs(page);
      const dealsLinks = await discoverDealsLinks(page);

      // Include current page as "All"
      const catTargets = [{ label: 'all', url: request.url }, ...tabs.map((t) => ({ label: t.text || 'category', url: t.href }))];
      for (const url of dealsLinks) catTargets.push({ label: 'deals', url });

      // De-dupe
      const seenCat = new Set();
      const targets = catTargets.filter((t) => {
        if (seenCat.has(t.url)) return false;
        seenCat.add(t.url);
        return true;
      });

      // Capture screenshots per target
      for (const target of targets) {
        try {
          if (target.url !== page.url()) {
            await page.goto(target.url, { timeout: TIMEOUT, waitUntil: 'domcontentloaded' });
            await tryDismissGates(page);
            await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
            await SLEEP(600);
          }
          // trigger lazy content
          await page.evaluate(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            let last = 0;
            for (let i = 0; i < 12; i++) {
              window.scrollBy(0, document.body.scrollHeight);
              await sleep(300);
              const cur = document.body.scrollHeight;
              if (cur === last) break;
              last = cur;
            }
          });
          await page.waitForTimeout(600);

          const buf = await page.screenshot({ fullPage: true, type: 'png' });
          const label = (target.label || 'section').replace(/[^\w-]+/g, '_').toLowerCase();
          categoryShots.push({ buffer: buf, label, url: target.url });
        } catch (e) {
          log.warning(`Category/deals capture failed for ${target.url}: ${e.message}`);
        }
      }

      // If OCR backup disabled, stop here
      if (!useOCRBackup) return;

      // Lazy import OCR + AI helpers
      const { ocrImageBuffer, heuristicsExtractPromos } = await import('./ocr.js');
      const { parseOCRToStructured } = await import('./ai_parse.js');

      let ocrProducts = [];
      let ocrPromos = [];

      // If nothing captured, at least OCR current page
      if (!categoryShots.length) {
        const buf = await page.screenshot({ fullPage: true, type: 'png' });
        categoryShots.push({ buffer: buf, label: 'menu', url: page.url() });
      }

      for (const shot of categoryShots) {
        const key = `screenshot_${shot.label}.png`;
        await KeyValueStore.getDefault().setValue(key, shot.buffer);

        const rawText = await ocrImageBuffer(shot.buffer);
        await KeyValueStore.getDefault().setValue(`ocr_raw_${shot.label}.txt`, rawText);

        if (promoHeuristicsEnabled) {
          const heur = heuristicsExtractPromos(rawText).map((p) => ({ ...p, page_label: shot.label }));
          ocrPromos.push(...heur);
        }

        if (useAIParser && OPENAI_API_KEY) {
          try {
            const parsed = await parseOCRToStructured(rawText, { apiKey: OPENAI_API_KEY, model: openaiModel });
            const prods = Array.isArray(parsed?.products) ? parsed.products : [];
            const promos = Array.isArray(parsed?.promotions) ? parsed.promotions : [];
            for (const p of prods) p.page_label = shot.label;
            for (const pr of promos) pr.page_label = shot.label;
            ocrProducts.push(...prods);
            ocrPromos.push(...promos);
            await KeyValueStore.getDefault().setValue(`ocr_ai_${shot.label}.json`, parsed, { contentType: 'application/json; charset=utf-8' });
          } catch (e) {
            log.warning(`AI parse (${shot.label}) failed: ${e.message}`);
          }
        }
      }

      // Push OCR rows
      if (ocrProducts.length || ocrPromos.length) {
        const ts2 = new Date().toISOString();
        const competitor2 = new URL(request.url).pathname.split('/')[2] || 'unknown';
        const menu_url2 = request.url;

        for (const p of ocrProducts) {
          await ocrDataset.pushData({
            timestamp_iso: ts2,
            competitor: competitor2,
            menu_url: menu_url2,
            page_label: p.page_label || null,
            source: 'ocr+ai',
            product_name: p.product_name ?? null,
            brand: p.brand ?? null,
            category: p.category ?? null,
            size: p.size ?? null,
            price: Number.isFinite(p.price) ? Number(p.price) : null,
            price_sale: Number.isFinite(p.price_sale) ? Number(p.price_sale) : null,
            thc_percent: Number.isFinite(p.thc_percent) ? Number(p.thc_percent) : null,
            cbd_percent: Number.isFinite(p.cbd_percent) ? Number(p.cbd_percent) : null,
            stock_status: p.stock_status ?? null,
          });
        }

        for (const promo of ocrPromos) {
          await ocrDataset.pushData({
            timestamp_iso: ts2,
            competitor: competitor2,
            menu_url: menu_url2,
            page_label: promo.page_label || null,
            source: 'ocr+ai',
            type: 'promotion',
            title: promo.title ?? null,
            details: promo.details ?? promo.text ?? null,
            discount_pct: Number.isFinite(promo.discount_pct) ? Number(promo.discount_pct) : null,
            start_date: promo.start_date ?? null,
            end_date: promo.end_date ?? null,
            raw: promo.raw ?? promo.text ?? null,
          });
        }

        log.info(
          `Plan C ✓ OCR products: ${ocrProducts.length}, promos/events: ${ocrPromos.length}, dataset: ${ocrDatasetNameFinal}`
        );
      }
    },

    failedRequestHandler({ request }) {
      log.error(`✗ Failed ${request.url}`);
    },
  });

  const startRequests = startUrls.map((u) => (typeof u === 'string' ? { url: u } : u));
  await crawler.run(startRequests);

  // Optional: Google Chat summary
  try {
    const info = await ocrDataset.getInfo();
    const count = info?.itemCount ?? 0;
    await chatPing(GCHAT_WEBHOOK_URL, `QCC scrape ✓  OCR rows today: ${count}  • ${new Date().toLocaleString()}`);
  } catch (e) {
    log.debug(`Chat summary skipped: ${e.message}`);
  }

  log.info('Run complete.');
});
