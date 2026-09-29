const OPTION_IDS = [
  'includeQc',
  'includeHarbor',
  'includeRawJson',
  'includeDescriptions',
  'includeOther',
  'expandCollapsed',
];
const STORAGE_KEY = 'mercor-result-inspector.options';

const $ = (id) => document.getElementById(id);
const preview = $('preview');
const statusEl = $('status');
const countEl = $('count');
const copyBtn = $('copy');
const refreshBtn = $('refresh');

function setStatus(msg, kind = '') {
  statusEl.textContent = msg;
  statusEl.className = kind;
}

function loadOptions() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    saved = {};
  }
  OPTION_IDS.forEach((id) => {
    if (typeof saved[id] === 'boolean') $(id).checked = saved[id];
  });
}

function readOptions() {
  const opts = {};
  OPTION_IDS.forEach((id) => (opts[id] = $(id).checked));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(opts));
  return opts;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extract() {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('No active tab found.');
  const url = tab.url || '';
  $('page').textContent = url.replace(/^https?:\/\//, '');
  $('page').title = url;
  if (!/^https?:/.test(url)) throw new Error('This page cannot be accessed (e.g. chrome:// pages).');

  const opts = readOptions();
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extractor.js'] });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (o) => window.__mercorExtract(o),
    args: [opts],
  });
  if (!res || typeof res.result !== 'string') throw new Error('Extraction returned no result.');
  return res.result;
}

async function refresh() {
  setStatus('Extracting...');
  copyBtn.disabled = true;
  refreshBtn.disabled = true;
  try {
    const text = await extract();
    preview.value = text;
    countEl.textContent = `${text.length.toLocaleString()} chars`;
    setStatus(/mercor/i.test($('page').textContent) ? 'Ready' : 'This does not look like a Mercor page', '');
    return text;
  } catch (e) {
    preview.value = '';
    countEl.textContent = '';
    setStatus(e && e.message ? e.message : String(e), 'err');
    return '';
  } finally {
    copyBtn.disabled = false;
    refreshBtn.disabled = false;
  }
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback for environments where the async clipboard API is blocked
    preview.focus();
    preview.select();
    const ok = document.execCommand('copy');
    preview.setSelectionRange(0, 0);
    return ok;
  }
}

copyBtn.addEventListener('click', async () => {
  const text = await refresh(); // always copy a fresh snapshot of the page
  if (!text) return;
  const ok = await writeClipboard(text);
  setStatus(ok ? `Copied (${text.length.toLocaleString()} chars)` : 'Failed to copy to clipboard', ok ? 'ok' : 'err');
});

refreshBtn.addEventListener('click', refresh);
OPTION_IDS.forEach((id) => $(id).addEventListener('change', refresh));

loadOptions();
refresh();
