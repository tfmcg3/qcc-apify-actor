
// Apps Script — Import latest OCR dataset to Google Sheets
// Set Script property: APIFY_TOKEN
const APIFY_TOKEN = PropertiesService.getScriptProperties().getProperty('APIFY_TOKEN');

function importApifyDataset(datasetName, sheetName) {
  if (!APIFY_TOKEN) throw new Error('Set APIFY_TOKEN in Script properties.');
  const url = `https://api.apify.com/v2/datasets?token=${encodeURIComponent(APIFY_TOKEN)}&limit=1&desc=true&search=${encodeURIComponent(datasetName)}`;
  const dsList = JSON.parse(UrlFetchApp.fetch(url).getContentText());
  const ds = dsList?.data?.items?.[0];
  if (!ds) throw new Error('Dataset not found: ' + datasetName);

  const itemsUrl = `https://api.apify.com/v2/datasets/${ds.id}/items?token=${encodeURIComponent(APIFY_TOKEN)}&clean=true&format=json`;
  const items = JSON.parse(UrlFetchApp.fetch(itemsUrl).getContentText());

  const sheet = SpreadsheetApp.getActive().getSheetByName(sheetName) || SpreadsheetApp.getActive().insertSheet(sheetName);
  const header = [
    'timestamp_iso','competitor','menu_url','page_label','source',
    'type','title','details','discount_pct','start_date','end_date',
    'product_name','brand','category','size','price','price_sale','thc_percent','cbd_percent','stock_status','raw'
  ];
  if (sheet.getLastRow() === 0) sheet.appendRow(header);

  const rows = items.map(it => header.map(h => it[h] ?? ''));
  if (rows.length) sheet.getRange(sheet.getLastRow()+1, 1, rows.length, header.length).setValues(rows);
}

function pullToday() {
  const today = new Date();
  const tag = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyyMMdd');
  importApifyDataset(`QCC_Menu_OCR_${tag}`, 'QCC_OCR_Import');
}
