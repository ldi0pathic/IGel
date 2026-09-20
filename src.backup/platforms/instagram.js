// SocialSnag — Instagram content script (button UI version)
console.log('[IGel] content script starting... (1)');

import {
  findNearestMedia,
  findPostContainer,
  hostMatches,
  withItemMeta,
} from './common.js';
import { selectByQuality } from './instagram-api.js';

// --- Pure functions (exported for testing) ---

export function upgradeImageUrl(url, imgElement, preference = 'largest') {
  if (!hostMatches(url, 'cdninstagram.com')) return null;

  if (imgElement?.srcset) {
    const candidates = imgElement.srcset.split(',').map((s) => {
      const parts = s.trim().split(/\s+/);
      const width = parseInt(parts[1]) || 0;
      return { url: parts[0], width };
    });
    const selected = selectByQuality(candidates, (candidate) => candidate.width, preference);
    if (selected) return selected;
  }

  return url.replace(/\/s\d+x\d+\//, '/');
}

function imageDedupeKey(url) {
  const upgraded = upgradeImageUrl(url, null);
  if (!upgraded) return null;
  const parsed = new URL(upgraded);
  const knownPhoto = /\/\d+_\d{10,}_\d+_n\.[a-z0-9]+$/i.test(parsed.pathname);
  return knownPhoto ? `photo:${parsed.origin}${parsed.pathname}` : `url:${url}`;
}

function capturedImageWidth(url) {
  const parsed = new URL(url);
  const pathWidth = parsed.pathname.match(/\/s(\d+)x\d+\//)?.[1];
  const queryWidth = parsed.searchParams.get('stp')?.match(/(?:^|_)[sp](\d+)x\d+(?:_|$)/)?.[1];
  return Number(pathWidth || queryWidth) || Infinity;
}

function instagramExpiryMs(url) {
  try {
    const oe = new URL(url).searchParams.get('oe');
    if (!oe) return null;
    const unix = parseInt(oe, 16);
    if (!Number.isFinite(unix) || unix < 1_000_000_000) return null;
    return unix * 1000;
  } catch {
    return null;
  }
}

function usableVariants(variants, now = Date.now()) {
  const live = variants.filter((variant) => {
    const expiry = instagramExpiryMs(variant.url);
    return expiry == null || expiry > now;
  });
  return live.length ? live : variants.slice(-1);
}

function selectCapturedUrl(variants, preference) {
  return selectByQuality(
    usableVariants(variants),
    (variant) => variant.width,
    preference,
  );
}

export function buildImageItems(images, shortcode, startIndex = 1, preference = 'largest') {
  const items = [];
  const itemIndexByIdentity = new Map();
  let index = startIndex;
  let considered = 0;

  for (const img of images) {
    const url = upgradeImageUrl(img?.src, img, preference);
    if (!url) continue;
    considered++;
    const key = imageDedupeKey(url);
    if (itemIndexByIdentity.has(key)) {
      const itemIndex = itemIndexByIdentity.get(key);
      const currentUrl = items[itemIndex].url;
      const selectedUrl = selectByQuality([
        { url, width: capturedImageWidth(url) },
        { url: currentUrl, width: capturedImageWidth(currentUrl) },
      ], (candidate) => candidate.width, preference);
      items[itemIndex] = { ...items[itemIndex], url: selectedUrl };
      continue;
    }
    itemIndexByIdentity.set(key, items.length);

    items.push(withItemMeta({
      url,
      type: 'image',
      filename: shortcode ? `post_${shortcode}_${index}` : null,
    }, { postId: shortcode }));
    index++;
  }

  return { items, index, considered };
}

export function extractShortcode(pathname) {
  const match = pathname.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[2] : null;
}

export function shortcodeFromContainer(hrefs) {
  for (const href of hrefs) {
    const match = href && href.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return match[2];
  }
  return null;
}

export function parseMediaFromJson(jsonStrings) {
  const items = [];

  for (const text of jsonStrings) {
    try {
      const data = JSON.parse(text);
      if (data.image) {
        const images = Array.isArray(data.image) ? data.image : [data.image];
        images.forEach((imgUrl, i) => {
          items.push({
            url: imgUrl,
            type: 'image',
            index: i + 1,
          });
        });
      }
    } catch (e) { /* ignore */ }
  }

  return items;
}

function decodeJsonString(str) {
  return str
    .replace(/\\\//g, '/')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function extractVideoUrlFromScripts(scriptTexts, preference = 'largest') {
  for (const text of scriptTexts) {
    if (!text) continue;

    if (text.includes('video_versions')) {
      const arrayMatch = text.match(/"video_versions"\s*:\s*\[([\s\S]*?)\]/);
      const versions = (arrayMatch?.[1].match(/\{[^{}]*\}/g) || []).map((entry) => {
        const url = entry.match(/"url"\s*:\s*"([^"]+)"/)?.[1];
        const width = Number(entry.match(/"width"\s*:\s*(\d+)/)?.[1]) || 0;
        return url ? { url: decodeJsonString(url), width } : null;
      }).filter(Boolean);
      const selected = selectByQuality(versions, (version) => version.width, preference);
      if (selected) return selected;
    }

    if (text.includes('video_url')) {
      const match = text.match(/"video_url":"([^"]+)"/);
      if (match) {
        return decodeJsonString(match[1]);
      }
    }
  }
  return null;
}

// --- DOM helpers ---

export function extractFromPageJson(pathname, preference = 'largest') {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  const jsonStrings = Array.from(scripts).map((s) => s.textContent);
  const parsed = parseMediaFromJson(jsonStrings);
  const shortcode = extractShortcode(pathname);
  const domImages = Array.from(document.querySelectorAll('img[src*="cdninstagram.com"]'));

  return parsed.map((item) => {
    const identity = upgradeImageUrl(item.url, null);
    const matchingImage = identity && domImages.find(
      (image) => upgradeImageUrl(image?.src, null) === identity,
    );
    const url = matchingImage
      ? upgradeImageUrl(item.url, matchingImage, preference)
      : item.url;

    return withItemMeta({
      url,
      type: item.type,
      filename: shortcode ? `post_${shortcode}_${item.index}` : null,
    }, { postId: shortcode });
  });
}

// --- Resolution ---

export function resolveSingle(srcUrl, target, pathname, preference = 'largest') {
  const shortcode = shortcodeForTarget(target, pathname);
  const filenameShortcode = extractShortcode(pathname);
  const url = upgradeImageUrl(srcUrl, target, preference);
  if (url) {
    return [withItemMeta(
      { url, type: 'image', filename: filenameShortcode ? `post_${filenameShortcode}` : null },
      { postId: shortcode },
    )];
  }

  const nearest = findNearestMedia(target);
  if (nearest?.tagName === 'IMG') {
    const upgraded = upgradeImageUrl(nearest.src, nearest, preference);
    if (upgraded) {
      return [withItemMeta(
        { url: upgraded, type: 'image', filename: filenameShortcode ? `post_${filenameShortcode}` : null },
        { postId: shortcode },
      )];
    }
  }

  const video = nearest?.tagName === 'VIDEO' ? nearest
    : target?.closest('video') || (target?.tagName === 'VIDEO' ? target : null);
  if (video) {
    const src = video.src;
    if (src && !src.startsWith('blob:')) {
      return [withItemMeta(
        { url: src, type: 'video', filename: filenameShortcode ? `reel_${filenameShortcode}` : null },
        { postId: shortcode },
      )];
    }

    const scripts = document.querySelectorAll('script');
    const scriptTexts = Array.from(scripts).map((s) => s.textContent);
    const cdnUrl = extractVideoUrlFromScripts(scriptTexts, preference);
    if (cdnUrl) {
      return [{
        url: cdnUrl,
        type: 'video',
        filename: filenameShortcode ? `reel_${filenameShortcode}` : null,
      }];
    }

    if (shortcode) {
      return [withItemMeta({
        type: 'video',
        filename: filenameShortcode ? `reel_${filenameShortcode}` : null,
        shortcode,
        needsVideoLookup: true,
      }, { postId: shortcode })];
    }
  }

  return [];
}

export function collectMediaFromContainer(container, shortcode, preference = 'largest') {
  const images = Array.from(container.querySelectorAll('img[src*="cdninstagram.com"]'));
  const built = buildImageItems(images, shortcode, 1, preference);
  const items = built.items;
  let index = built.index;
  const imageItemCount = built.items.length;

  let _cachedScriptTexts = null;
  function getScriptTexts() {
    if (!_cachedScriptTexts) {
      _cachedScriptTexts = Array.from(document.querySelectorAll('script')).map((s) => s.textContent);
    }
    return _cachedScriptTexts;
  }

  const usedVideoUrls = new Set();
  container.querySelectorAll('video').forEach((video) => {
    const src = video.src;
    if (src && !src.startsWith('blob:')) {
      if (!usedVideoUrls.has(src)) {
        usedVideoUrls.add(src);
        items.push(withItemMeta({
          url: src,
          type: 'video',
          filename: shortcode ? `post_${shortcode}_${index}` : null,
        }, { postId: shortcode }));
        index++;
      }
    } else if (src && src.startsWith('blob:')) {
      const cdnUrl = extractVideoUrlFromScripts(getScriptTexts(), preference);
      if (cdnUrl && !usedVideoUrls.has(cdnUrl)) {
        usedVideoUrls.add(cdnUrl);
        items.push({
          url: cdnUrl,
          type: 'video',
          filename: shortcode ? `post_${shortcode}_${index}` : null,
        });
        index++;
      } else if (shortcode && !usedVideoUrls.has('api:' + shortcode)) {
        usedVideoUrls.add('api:' + shortcode);
        items.push(withItemMeta({
          type: 'video',
          filename: shortcode ? `reel_${shortcode}` : null,
          shortcode,
          needsVideoLookup: true,
        }, { postId: shortcode }));
        index++;
      }
    }
  });

  const domCount = built.considered + (items.length - imageItemCount);

  return { items, index, domCount };
}

function findBroadContainer(target) {
  let el = target;
  const body = globalThis.document?.body;
  while (el && el !== body) {
    el = el.parentElement;
    if (!el) break;
    const mediaCount = el.querySelectorAll('img[src*="cdninstagram.com"]').length
      + el.querySelectorAll('video').length;
    if (mediaCount > 1) {
      return el;
    }
  }
  return null;
}

function ancestorHrefs(el) {
  const hrefs = [];
  const body = globalThis.document?.body;
  let node = el;
  while (node && node !== body) {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (href) hrefs.push(href);
    }
    node = node.parentElement;
  }
  return hrefs;
}

function descendantHrefs(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
}

function shortcodeForTarget(target, pathname) {
  const ownerHrefs = ancestorHrefs(target);
  if (ownerHrefs.length > 0) return shortcodeFromContainer(ownerHrefs);
  return shortcodeFromContainer(descendantHrefs(target?.closest?.('article')))
    || extractShortcode(pathname);
}

async function resolveAll(target, pathname, preference = 'largest') {
  const urlShortcode = extractShortcode(pathname);

  const jsonItems = extractFromPageJson(pathname, preference);
  if (jsonItems.length > 0) return { items: jsonItems, shortcode: urlShortcode };

  let post = findPostContainer(target, [
    'article',
    '[role="presentation"]',
    '[role="dialog"]',
    'div._aagv',
    'div._aatk',
    'div._ab8w',
  ]);

  if (!post) {
    post = findBroadContainer(target);
  }

  if (!post) {
    return {
      items: resolveSingle(target?.src || '', target, pathname, preference),
      shortcode: urlShortcode,
    };
  }

  const shortcode = shortcodeForTarget(target, pathname)
    || shortcodeFromContainer(descendantHrefs(post));
  const { items, index: nextIndex, domCount } = collectMediaFromContainer(
    post,
    shortcode,
    preference,
  );
  let index = nextIndex;

  // If the DOM only offered one piece of media, we could try to expand via API
  // But for button usage we rely on what the DOM gives us, with the shortcode
  // being used by background for full API enumeration if needed.

  return {
    items,
    shortcode,
  };
}

// --- Button UI ---

let downloadButton = null;
let currentTarget = null;
let currentPathname = '';
let isExtensionMode = false;
let debugInitialized = false;

function createDownloadButton() {
  if (downloadButton) return downloadButton;

  const btn = document.createElement('button');
  btn.id = 'igel-download-btn';
  btn.textContent = '⬇';
  btn.title = 'Download all from post';
  btn.style.cssText = `
    position: absolute;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    border: 2px solid rgba(255,255,255,0.5);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    display: none;
    z-index: 2147483647;
    padding: 0;
    transition: background 0.2s;
    user-select: none;
    pointer-events: auto;
  `;

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(0, 0, 0, 0.9)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(0, 0, 0, 0.7)';
  });

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    btn.style.display = 'none';
    await triggerDownload(currentTarget, currentPathname);
  });

  document.body.appendChild(btn);
  console.log('[IGel] Download button created, id:', btn.id, 'parent:', btn.parentNode?.tagName);
  return btn;
}

async function triggerDownload(target, pathname) {
  try {
    const result = await resolveAll(target, pathname, 'largest');
    
    if (isExtensionMode && chrome && chrome.runtime && chrome.runtime.id) {
      chrome.runtime.sendMessage({
        action: 'resolve',
        type: 'all',
        srcUrl: target?.src || '',
        pageUrl: window.location.href,
        preference: 'largest',
      });
    } else {
      for (const item of result.items) {
        try {
          const response = await fetch(item.url);
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = item.filename || 'download';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        } catch (err) {
          console.warn('[IGel] could not download', item.url, err);
        }
      }
    }
  } catch (err) {
    console.error('[IGel] button error:', err);
  }
}

// Track mouse position over media elements and show/hide download button
function initButtonUI() {
  const btn = createDownloadButton();

  if (!debugInitialized) {
    debugInitialized = true;
    console.log('[IGel] Button UI DEBUG active — hovering over media should trigger logs below');
  }

  document.addEventListener('mouseover', (e) => {
    if (!document.body || document.body === null) return;
    const target = e.target;
    const tagName = target?.tagName ?? 'null';
    const src = target?.src ?? '';
    const srcSnippet = src ? (src.length > 80 ? src.slice(0, 80) + '…' : src) : '(no src)';
    const isMedia = tagName === 'IMG' && src && src.includes('cdninstagram.com');
    const isVideo = tagName === 'VIDEO' && src && src.includes('cdninstagram.com');
    const isImg = tagName === 'IMG';
    const isVideoEl = tagName === 'VIDEO';

    // Debug: log every 50th mouseover to avoid spam, plus all media candidates
    if (isImg || isVideoEl) {
      console.log(`[IGel] mouseover candidate: tag=${tagName}, src=${srcSnippet}, isMedia=${isMedia}, isVideo=${isVideo}`);
    }

    if (isMedia || isVideo) {
      console.log(`[IGel] ✓ Media detected — showing button. target=${tagName}, rect=${target.getBoundingClientRect().toJSON()}`);
      currentTarget = target;
      currentPathname = window.location.pathname;

      const rect = target.getBoundingClientRect();
      const left = rect.right - 40;
      const top = rect.top + 8;
      console.log(`[IGel] Button positioning: left=${left}, top=${top}, rect.right=${rect.right}, rect.top=${rect.top}`);

      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
      btn.style.display = 'block';

      // Verify button is actually in DOM and visible
      const computed = btn.getBoundingClientRect();
      console.log(`[IGel] Button after show: display=${btn.style.display}, computedSize=${computed.width}x${computed.height}, inDOM=${!!btn.parentNode}`);
    } else {
      // Only hide if button is currently visible (avoid log spam)
      if (btn.style.display === 'block') {
        btn.style.display = 'none';
      }
    }
  }, true);

  document.addEventListener('mouseleave', () => {
    if (downloadButton && downloadButton.style.display === 'block') {
      downloadButton.style.display = 'none';
    }
  });

  document.addEventListener('contextmenu', (e) => {
    currentTarget = e.target;
    currentPathname = window.location.pathname;
  }, true);
}

// --- Message handler (background ↔ content script) ---

function initContentScript() {
  isExtensionMode = true;
  let _lastTarget = null;
  let _isPageActive = true;

  // Track if the page is still active (not navigating/unloading)
  document.addEventListener('visibilitychange', () => {
    _isPageActive = document.visibilityState === 'visible';
  });

  // Track right-click target for backward compatibility
  document.addEventListener('contextmenu', (e) => {
    if (!_isPageActive) return;
    _lastTarget = e.target;
  }, true);

  // Listen for resolve requests from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!_isPageActive) {
      console.log('[IGel] page not active, ignoring message');
      return false;
    }
    console.log('[IGel] onMessage received:', message.action);
    if (message.action === 'resolve') {
      console.log('[IGel] resolve target:', _lastTarget?.tagName, 'pathname:', window.location.pathname);
      const target = _lastTarget;
      const pathname = window.location.pathname;

      Promise.resolve()
        .then(() => {
          console.log('[IGel] resolving...');
          return message.type === 'single'
            ? {
                items: resolveSingle(message.srcUrl, target, pathname, message.preference),
                shortcode: null,
              }
            : resolveAll(target, pathname, message.preference);
        })
        .then((result) => {
          console.log('[IGel] resolve done, items:', result.items?.length);
          sendResponse({ urls: result.items || [], platform: 'instagram', shortcode: result.shortcode || null });
        })
        .catch((err) => {
          console.error('[IGel] resolve error:', err);
          sendResponse({ urls: [], platform: 'instagram' });
        });
      return true;
    }
    console.log('[IGel] unknown action:', message.action);
    return false;
  });

  // Init button UI - moved to setTimeout below (needs DOM)
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  console.log('[IGel] Content script starting init...');
  try {
    initContentScript();
    console.log('[IGel] Content script initialized (messages registered).');
  } catch (err) {
    console.error('[IGel] Content script init failed:', err);
  }

  // Button UI must be set up after init (DOM depends on post-load layout)
  // Run after a short delay so React's initial render of the post is complete
  setTimeout(() => {
    console.log('[IGel] Button UI timeout, body:', document.body ? 'present' : 'null');
    try {
      initButtonUI();
      console.log('[IGel] Button UI inited.');
    } catch (err) {
      console.error('[IGel] Button UI init failed:', err);
    }
  }, 500);
}
