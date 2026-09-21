'use strict';

function initPopup() {
  document.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`;

  const hint = document.getElementById('hint');
  const tab = chrome.tabs?.query({ active: true, currentWindow: true })?.[0];
  const url = tab?.url || '';

  if (url.includes('instagram.com')) {
    hint.innerHTML = '<div>Bild oder Video auf dieser Seite <strong>rechtsklicken → IGel-Menü</strong></div>';
  } else {
    hint.innerHTML = '<div>Navigiere zu Instagram, um Medien herunterzuladen.</div>';
  }
}

if (typeof document !== 'undefined') {
  initPopup();
}
