'use strict';

const DEFAULT_DOWNLOAD_PATH = 'IGel/{platform}';
const TEMPLATE_TOKENS = new Set(['platform', 'type', 'postId', 'username', 'index', 'date']);

export function downloadPathError(value) {
  if (!value) return null;
  if (/[<>:"|?*\x00-\x1f]/.test(value)) return 'Der Pfad enthält ungültige Zeichen.';
  if (value.split(/[\\/]+/).some((part) => part === '..')) return '„..“ ist im Download-Pfad nicht erlaubt.';
  const tokens = Array.from(value.matchAll(/\{(\w+)\}/g)).map((match) => match[1]);
  if (/[{}]/.test(value.replace(/\{\w+\}/g, ''))) return 'Platzhalter müssen vollständig in geschweiften Klammern stehen.';
  const unknown = tokens.find((token) => !TEMPLATE_TOKENS.has(token));
  return unknown ? `Unbekannter Platzhalter: {${unknown}}.` : null;
}

async function initPopup() {
  document.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`;
  const hint = document.getElementById('hint');
  const form = document.getElementById('download-path-form');
  const input = document.getElementById('download-path');
  const error = document.getElementById('download-path-error');
  const status = document.getElementById('save-status');
  const [{ url } = {}] = await chrome.tabs.query({ active: true, currentWindow: true });
  let isInstagram = false;
  try {
    const hostname = new URL(url || '').hostname.toLowerCase();
    isInstagram = hostname === 'instagram.com' || hostname.endsWith('.instagram.com');
  } catch { /* Chrome internal pages have no usable URL. */ }
  hint.textContent = isInstagram
    ? 'Bild oder Video auf dieser Seite rechtsklicken → IGel-Menü'
    : 'Navigiere zu Instagram, um Medien herunterzuladen.';

  const { downloadPath = DEFAULT_DOWNLOAD_PATH } = await chrome.storage.sync.get({ downloadPath: DEFAULT_DOWNLOAD_PATH });
  input.value = downloadPath;

  const validate = () => {
    status.textContent = '';
    const value = input.value.trim();
    const message = downloadPathError(value);
    error.textContent = message || '';
    error.hidden = !message;
    return message;
  };

  input.addEventListener('input', validate);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (validate()) return;
    await chrome.storage.sync.set({ downloadPath: input.value.trim() || DEFAULT_DOWNLOAD_PATH });
    status.textContent = 'Gespeichert';
  });
}

if (typeof document !== 'undefined') {
  void initPopup();
}
