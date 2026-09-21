// IGel — Instagram content script (overlay-layer button UI)
// Pattern: globaler Overlay-Layer unter document.body, Buttons pro Media-Element
// Das umgeht Instagram's overflow:hidden, transform, z-index und Stacking Contexts.
console.log('[IGel] content script starting...');

import {
  findPostContainer,
  hostMatches,
  withItemMeta,
} from './common.js';
import { selectByQuality } from './instagram-api.js';

// ============================================================================
//  HELPERS: Media-Erkennung (aus ig-hover-downloader übernommen)
// ============================================================================

function isValidMediaUrl(url) {
  if (!url) return false;
  if (url.match(/\/static\//i)) return false;
  if (url.match(/emoji|pixel|shg|cursor|placeholder/i)) return false;
  if (url.match(/\.gif/i)) return false;

  try {
    const parsed = new URL(url);
    const hasExt = /\.(jpg|jpeg|png|webp|mp4|mov|m4s)(?:$|[?#])/i.test(parsed.pathname);
    const isCdn = /(^|\.)cdninstagram\.com$/i.test(parsed.hostname);
    return hasExt || isCdn;
  } catch {
    return false;
  }
}



// ============================================================================
//  PURE FUNCTIONS (resolver-logik, unverändert)
// ============================================================================

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
  const knownPhoto = /\/(\d+)_(\d{10,})_(\d+)_n\.[a-z0-9]+$/i.test(parsed.pathname);
  return knownPhoto ? `photo:${parsed.origin}${parsed.pathname}` : `url:${url}`;
}

function capturedImageWidth(url) {
  const parsed = new URL(url);
  const pathWidth = parsed.pathname.match(/\/s(\d+)x\d+\//)?.[1];
  const queryWidth = parsed.searchParams.get('stp')?.match(/(?:^|_)[sp](\d+)x\d+(?:_|$)/)?.[1];
  return Number(pathWidth || queryWidth) || Infinity;
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
    .replace(/\\\/\//g, '/')
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
  const domImages = Array.from(document.querySelectorAll('img'));

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
  const username = usernameForTarget(target);
  const url = upgradeImageUrl(srcUrl, target, preference);
  if (url) {
    return [withItemMeta(
      { url, type: 'image', filename: filenameShortcode ? `post_${filenameShortcode}` : null },
      { postId: shortcode, username },
    )];
  }

  const nearest = findNearestMedia(target);
  if (nearest?.tagName === 'IMG') {
    const upgraded = upgradeImageUrl(nearest.src, nearest, preference);
    if (upgraded) {
      return [withItemMeta(
        { url: upgraded, type: 'image', filename: filenameShortcode ? `post_${filenameShortcode}` : null },
        { postId: shortcode, username },
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
        { postId: shortcode, username },
      )];
    }

    const scripts = document.querySelectorAll('script');
    const scriptTexts = Array.from(scripts).map((s) => s.textContent);
    const cdnUrl = extractVideoUrlFromScripts(scriptTexts, preference);
    if (cdnUrl) {
      return [withItemMeta({
        url: cdnUrl,
        type: 'video',
        filename: filenameShortcode ? `reel_${filenameShortcode}` : null,
      }, { postId: shortcode, username })];
    }

    if (shortcode) {
      return [withItemMeta({
        type: 'video',
        filename: filenameShortcode ? `reel_${filenameShortcode}` : null,
        shortcode,
        needsVideoLookup: true,
      }, { postId: shortcode, username })];
    }
  }

  return [];
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

export function collectMediaFromContainer(container, shortcode, preference = 'largest') {
  const images = Array.from(container.querySelectorAll('img'));
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

function findNearestMedia(element) {
  if (!element) return null;

  if (element.tagName === 'IMG') return element;
  if (element.tagName === 'VIDEO') return element;

  const img = element.querySelector('img');
  if (img) return img;
  const video = element.querySelector('video');
  if (video) return video;

  let el = element;
  const body = globalThis.document?.body;
  for (let i = 0; i < 5 && el && el !== body; i++) {
    el = el.parentElement;
    if (!el) break;
    const nearImg = el.querySelector('img');
    if (nearImg && nearImg.src && !nearImg.src.startsWith('data:')) return nearImg;
    const nearVideo = el.querySelector('video');
    if (nearVideo) return nearVideo;
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

const PROFILE_PATH = /^\/([A-Za-z0-9._]+)\/?$/;

/** Find the post owner's profile link in the feed article containing this media. */
export function usernameForTarget(target) {
  const article = target?.closest?.('article');
  const container = article || target?.closest?.('[role="dialog"]');
  console.log('[IGel] usernameForTarget: container=', container ? container.tagName + (container.id ? '#' + container.id : '') : 'none');
  if (!container) {
    console.log('[IGel] usernameForTarget: no container found — returning null');
    return null;
  }

  const hrefs = descendantHrefs(container);
  console.log('[IGel] usernameForTarget: found', hrefs.length, 'hrefs in container');
  for (const href of hrefs) {
    const match = href?.match(PROFILE_PATH);
    if (match) {
      console.log('[IGel] usernameForTarget: MATCH — username=', match[1], 'href=', href);
      return match[1];
    }
  }
  console.log('[IGel] usernameForTarget: no profile href match in container');
  return null;
}

function withUsername(items, username, shortcode = null) {
  if (!username) return items;
  return items.map((item) => withItemMeta(item, {
    postId: item.meta?.postId || shortcode,
    username: item.meta?.username || username,
  }));
}

function shortcodeForTarget(target, pathname) {
  const ownerHrefs = ancestorHrefs(target);
  if (ownerHrefs.length > 0) return shortcodeFromContainer(ownerHrefs);

  // Try closest article
  const article = target?.closest?.('article');
  if (article) {
    const descHrefs = descendantHrefs(article);
    if (descHrefs.length > 0) return shortcodeFromContainer(descHrefs);
  }

  // Fallback: search all post links on the page
  const allPostLinks = document.querySelectorAll('a[href*="/p/"]');
  for (const link of allPostLinks) {
    const href = link.getAttribute('href');
    const match = href && href.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (match) return match[2];
  }

  return extractShortcode(pathname);
}

async function resolveAll(target, pathname, preference = 'largest') {
  const urlShortcode = extractShortcode(pathname);
  const username = usernameForTarget(target);
  console.log('[IGel] resolveAll: shortcode=', urlShortcode, 'usernameFromTarget=', username);

  const jsonItems = extractFromPageJson(pathname, preference);
  if (jsonItems.length > 0) {
    return { items: withUsername(jsonItems, username, urlShortcode), shortcode: urlShortcode };
  }

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
  const { items } = collectMediaFromContainer(
    post,
    shortcode,
    preference,
  );
  return {
    items: withUsername(items, username, shortcode),
    shortcode,
  };
}

// ============================================================================
//  BUTTON UI — Overlay-Layer Pattern (wie ig-hover-downloader)
// ============================================================================

let isExtensionMode = false;
let overlayLayer = null;
let mediaButtons = new Map(); // mediaEl -> button

// --- Globaler Overlay-Layer ---

function getOverlayLayer() {
  if (overlayLayer) return overlayLayer;

  overlayLayer = document.createElement('div');
  overlayLayer.id = 'igel-overlay-layer';
  overlayLayer.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 100%',
    'height: 100%',
    'z-index: 2147483647',
    'pointer-events: none',
    'overflow: visible',
  ].join(';');
  document.body.appendChild(overlayLayer);
  console.log('[IGel] Overlay-Layer created');
  return overlayLayer;
}

// --- Download-Button pro Media ---

function createMediaButton(mediaEl, mediaUrl) {
  if (mediaButtons.has(mediaEl)) return mediaButtons.get(mediaEl);

  const btn = document.createElement('div');
  btn.className = 'igel-overlay';
  btn.innerHTML = '<span class="icon">⬇</span>';
  btn.dataset.igelMediaUrl = mediaUrl;

  // Button-Styles
  btn.style.cssText = [
    'position: fixed',
    'width: 36px',
    'height: 36px',
    'border-radius: 50%',
    'background: rgba(0, 0, 0, 0.7)',
    'color: white',
    'border: 2px solid rgba(255,255,255,0.5)',
    'cursor: pointer',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'font-size: 16px',
    'line-height: 1',
    'z-index: 2147483647',
    'pointer-events: auto',
    'padding: 0',
    'transition: background 0.2s',
    'user-select: none',
    'box-shadow: 0 2px 6px rgba(0,0,0,0.3)',
  ].join(';');

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(0, 0, 0, 0.9)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(0, 0, 0, 0.7)';
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[IGel] Download click: url=' + (mediaUrl || '?').substring(0, 90));
    await handleDownload(mediaUrl, btn);
  });

  btn.addEventListener('mousedown', (e) => e.stopPropagation());

  const layer = getOverlayLayer();
  layer.appendChild(btn);

  btn._igelMediaEl = mediaEl;
  positionButtonOverMedia(btn, mediaEl);
  btn.style.visibility = 'visible';
  btn.style.display = 'flex';
  btn.classList.add('visible');

  mediaButtons.set(mediaEl, btn);
  console.log('[IGel] Button created for', mediaEl.tagName, 'url:', mediaUrl?.substring(0, 60));

  return btn;
}

function positionButtonOverMedia(btn, mediaEl) {
  const rect = mediaEl.getBoundingClientRect();
  const gap = 8;

  btn.style.position = 'fixed';
  btn.style.top = (rect.top + gap) + 'px';
  btn.style.left = (rect.left + gap) + 'px';
  btn.style.right = 'auto';
  btn.style.bottom = 'auto';
  btn.style.transform = 'none';
  btn.style.zIndex = '2147483647';
  btn.style.pointerEvents = 'auto';
}

function removeButtonForMedia(mediaEl) {
  const btn = mediaButtons.get(mediaEl);
  if (btn) {
    btn.remove();
    mediaButtons.delete(mediaEl);
  }
  delete mediaEl.dataset.igelHasButton;
}

function clearMediaButtons() {
  for (const [mediaEl, btn] of mediaButtons) {
    btn.remove();
    delete mediaEl.dataset.igelHasButton;
  }
  mediaButtons.clear();
}

// --- Media hinzufügen (wenn sichtbar) ---

function addButtonToMedia(mediaEl) {
  if (mediaButtons.has(mediaEl)) return;
  // A stale marker can remain after the overlay layer was cleared.
  delete mediaEl.dataset.igelHasButton;

  const url = mediaEl.src ||
    mediaEl.getAttribute('data-src') ||
    mediaEl.getAttribute('data-lazy-src') ||
    mediaEl.getAttribute('data-og-src') ||
    '';

  if (!url || !isValidMediaUrl(url)) return;

  // Profilbilder / Avatare: nur eigenes Profil
  if (mediaEl.tagName === 'IMG' && mediaEl.alt) {
    const altLower = mediaEl.alt.toLowerCase();
    if (altLower.includes('profilbild') || altLower.includes('profile picture') ||
      altLower.includes('avatar')) {
      // Aktuelles Profilbild ignorieren (kein Download-Button)
      return;
    }
  }

  createMediaButton(mediaEl, url);
  mediaEl.dataset.igelHasButton = 'true';
}


// --- Sichtbare Medien finden ---

function getVisibleImages() {
  const allImages = Array.from(document.querySelectorAll('img'));
  return allImages.filter(img => {
    const url = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
    if (!isValidMediaUrl(url)) return false;
    const rect = img.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.top < window.innerHeight && rect.bottom > 0 &&
      rect.left < window.innerWidth && rect.right > 0;
  });
}

function getVisibleVideos() {
  const allVideos = Array.from(document.querySelectorAll('video'));
  return allVideos.filter(video => {
    if (!video.src) return false;
    if (!isValidMediaUrl(video.src)) return false;
    const rect = video.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      rect.top < window.innerHeight && rect.bottom > 0;
  });
}

// --- Repositioning ---

let repositionRAF = null;
function scheduleReposition() {
  if (repositionRAF) return;
  repositionRAF = requestAnimationFrame(() => {
    repositionRAF = null;
    repositionAllButtons();
  });
}

function repositionAllButtons() {
  const layer = getOverlayLayer();
  const buttons = layer.querySelectorAll('.igel-overlay');
  const visH = window.innerHeight;
  const visW = window.innerWidth;

  buttons.forEach(btn => {
    const mediaEl = btn._igelMediaEl;

    if (!mediaEl || !document.body.contains(mediaEl)) {
      btn.style.visibility = 'hidden';
      btn.style.display = 'none';
      btn.classList.remove('visible');
      return;
    }

    const rect = mediaEl.getBoundingClientRect();

    const isVisible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top < visH &&
      rect.bottom > 0 &&
      rect.left < visW &&
      rect.right > 0;

    if (isVisible) {
      btn.style.display = 'flex';
      btn.style.visibility = 'visible';
      btn.classList.add('visible');
      positionButtonOverMedia(btn, mediaEl);
    } else {
      btn.style.visibility = 'hidden';
      btn.style.display = 'none';
      btn.classList.remove('visible');
    }
  });

  // Neue sichtbare Medien erkennen
  getVisibleImages().forEach(img => {
    addButtonToMedia(img);
  });
  getVisibleVideos().forEach(video => {
    addButtonToMedia(video);
  });
}

window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });
window.addEventListener('resize', scheduleReposition);

// --- MutationObserver: neue Medien im DOM ---

const mutationObserver = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    // Entfernte Nodes: Buttons loslassen
    mutation.removedNodes.forEach(node => {
      if (node.nodeType !== 1) return;

      if (node.classList && node.classList.contains('igel-overlay')) {
        return; // Button selbst entfernt
      }

      // Medien-Elemente entfernt?
      const mediaEl = node.matches && node.matches('img, video') ? node : null;
      if (mediaEl) {
        removeButtonForMedia(mediaEl);
      }

      // Kinder nach Medien durchsuchen
      Array.from(node.querySelectorAll('img')).forEach(removeButtonForMedia);
      Array.from(node.querySelectorAll('video')).forEach(removeButtonForMedia);
    });

    // Hinzugefügte Nodes: Buttons erstellen
    mutation.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;

      if (node.tagName === 'IMG' && isValidMediaUrl(node.src)) {
        addButtonToMedia(node);
      }
      if (node.tagName === 'VIDEO' && isValidMediaUrl(node.src)) {
        addButtonToMedia(node);
      }

      Array.from(node.querySelectorAll('img')).forEach(img => {
        if (isValidMediaUrl(img.src)) {
          addButtonToMedia(img);
        }
      });
      Array.from(node.querySelectorAll('video')).forEach(video => {
        if (isValidMediaUrl(video.src)) {
          addButtonToMedia(video);
        }
      });
    });
  });
});

// --- Lightbox-Erkennung ---

function isLightboxOpen() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Nur echte Lightbox-Dialoge: müssen dominant sein (> 80% des Viewports)
  // und Medien als Child haben. Instagram nutzt div[role="dialog"] auch für
  // Loading-Overlays, Story-UI etc. — die haben nicht die Größe einer Lightbox.
  const dialog = document.querySelector('div[role="dialog"]');
  if (dialog) {
    const rect = dialog.getBoundingClientRect();
    if (rect.width > vw * 0.8 && rect.height > vh * 0.8) {
      const hasMedia = dialog.querySelector('img, video');
      if (hasMedia) {
        const style = window.getComputedStyle(dialog);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          console.log('[IGel] Lightbox detected via dominant dialog');
          return true;
        }
      }
    }
  }

  // Alternative: ein einziges riesiges Bild, das den kompletten Viewport überdeckt
  const fullscreenImages = document.querySelectorAll('img[src*="cdninstagram.com"]');
  for (const img of fullscreenImages) {
    const rect = img.getBoundingClientRect();
    if (rect.width > vw * 0.9 && rect.height > vh * 0.9) {
      const style = window.getComputedStyle(img);
      if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
        console.log('[IGel] Lightbox detected via large image (' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ')');
        return true;
      }
    }
  }

  return false;
}

let lightboxWasOpen = false;

function checkLightboxChange() {
  const nowOpen = isLightboxOpen();
  console.log('[IGel] Lightbox state: was=' + lightboxWasOpen + ', now=' + nowOpen);
  if (lightboxWasOpen && !nowOpen) {
    console.log('[IGel] Lightbox closed — recreating buttons');
    clearMediaButtons();
    getVisibleImages().forEach(img => addButtonToMedia(img));
    getVisibleVideos().forEach(video => addButtonToMedia(video));
    scheduleReposition();
  } else if (!lightboxWasOpen && nowOpen) {
    console.log('[IGel] Lightbox opened — hiding buttons');
    clearMediaButtons();
  }
  lightboxWasOpen = nowOpen;
}

// --- URL-Änderungs-ERKENNUNG ---

// History-Patch (fallback falls Events nicht feuern)
(function patchHistory() {
  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function() {
    const ret = origPush.apply(this, arguments);
    window.dispatchEvent(new Event('pushstate'));
    return ret;
  };

  history.replaceState = function() {
    const ret = origReplace.apply(this, arguments);
    window.dispatchEvent(new Event('replacestate'));
    return ret;
  };
})();

// --- URL-Änderungs-ERKENNUNG ---

let lastUrl = location.href;

function urlChanged() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    return true;
  }
  return false;
}

function handleUrlChange() {
  if (urlChanged()) {
    console.log('[IGel] URL changed, resetting buttons (wasLightbox=' + lightboxWasOpen + ')');
    clearMediaButtons();
    // Nur neue Buttons erstellen, wenn keine Lightbox offen ist
    if (!isLightboxOpen()) {
      getVisibleImages().forEach(img => addButtonToMedia(img));
      getVisibleVideos().forEach(video => addButtonToMedia(video));
      scheduleReposition();
    }
    // lightboxWasOpen NICHT zurücksetzen — checkLightboxChange() kümmert sich darum
  }
}

window.addEventListener('popstate', handleUrlChange);
window.addEventListener('pushstate', handleUrlChange);
window.addEventListener('replacestate', handleUrlChange);
window.addEventListener('hashchange', handleUrlChange);

// Kombiniertes Intervall: URL-Check + Lightbox-Status-Check
setInterval(() => {
  handleUrlChange();
  checkLightboxChange();
}, 100);

// --- Download-Handler ---

async function handleDownload(url, btnElement) {
  if (!url || url.match(/blob:/i)) {
    console.warn('[IGel] No media URL');
    return;
  }

  if (isExtensionMode && chrome && chrome.runtime && chrome.runtime.id) {
    const pathname = window.location.pathname;
    const match = pathname.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    const urlShortcode = match ? match[2] : null;

    // Versuche Shortcode aus URL oder DOM zu extrahieren
    const mediaEl = btnElement?._igelMediaEl || null;
    const domShortcode = urlShortcode || (mediaEl ? shortcodeForTarget(mediaEl, pathname) : null);
    const shortcode = domShortcode;
    const username = mediaEl ? usernameForTarget(mediaEl) : null;

    console.log('[IGel] Download click context: pathname=', pathname, 'shortcode=', shortcode, 'username=', username, 'hasMediaEl=', !!mediaEl);

    if (shortcode) {
      console.log('[IGel] Shortcode found:', shortcode, '— requesting API download from background');
      chrome.runtime.sendMessage({
        action: 'downloadFromShortcode',
        shortcode: shortcode,
        username,
        preference: 'largest',
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[IGel] Download failed:', chrome.runtime.lastError.message);
          return;
        }
        console.log('[IGel] Download from shortcode sent, response:', response);
      });
    } else {
      console.warn('[IGel] No shortcode found — falling back to DOM resolve');
      console.log('[IGel] DOM resolve context: pathname=', pathname, 'usernameForTarget result=', username);
      try {
        const result = await resolveAll(mediaEl, pathname, 'largest');
        const items = result.items || [];
        if (!items || items.length === 0) {
          console.warn('[IGel] No items found for download');
          return;
        }
        console.log('[IGel] DOM resolve done, items:', items.length);
        chrome.runtime.sendMessage({
          action: 'downloadBatch',
          platform: 'instagram',
          items: items,
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[IGel] Download failed:', chrome.runtime.lastError.message);
            return;
          }
          console.log('[IGel] Download batch sent, response:', response);
        });
      } catch (err) {
        console.error('[IGel] DOM resolve error:', err);
      }
    }
    return;
  }

  // Fallback (ohne Extension)
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const blob = await response.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    console.log('[IGel] Download OK:', url.substring(0, 80));
  } catch (err) {
    console.error('[IGel] Download error:', err);
  }
}

// --- Init: Buttons für bereits sichtbare Medien ---

function initExistingMedia() {
  console.log('[IGel] initExistingMedia: scanning visible media...');
  const images = getVisibleImages();
  const videos = getVisibleVideos();

  images.forEach(img => {
    console.log('[IGel] Found image:', img.src?.substring(0, 60));
    addButtonToMedia(img);
  });
  videos.forEach(video => {
    console.log('[IGel] Found video:', video.src?.substring(0, 60));
    addButtonToMedia(video);
  });

  console.log('[IGel] initExistingMedia done. Images:', images.length, 'Videos:', videos.length);
}

// ============================================================================
//  MESSAGE HANDLER (background <-> content script)
// ============================================================================

function initContentScript() {
  isExtensionMode = true;
  let _lastTarget = null;
  let _isPageActive = true;

  document.addEventListener('visibilitychange', () => {
    _isPageActive = document.visibilityState === 'visible';
  });

  // Right-click target für backward compatibility (context menu)
  document.addEventListener('contextmenu', (e) => {
    if (!_isPageActive) return;
    _lastTarget = e.target;
  }, true);

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
}

// ============================================================================
//  INITIALISIERUNG
// ============================================================================

function waitForBodyAndInit() {
  if (document.body) {
    runExtensionInit();
    return;
  }
  const observer = new MutationObserver(() => {
    if (document.body) {
      observer.disconnect();
      runExtensionInit();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function runExtensionInit() {
  console.log('[IGel] Content script starting init...');
  try {
    initContentScript();
    console.log('[IGel] Content script initialized (messages registered).');
  } catch (err) {
    console.error('[IGel] Content script init failed:', err);
  }

  // MutationObserver eerst instellen — BEFORE initExistingMedia()
  // Sonst werden Bilder, die während des initalen Scans landen, übersehen.
  mutationObserver.observe(document.body, { childList: true, subtree: true });

  // Overlay-Layer und Buttons nach DOM-Ready
  try {
    getOverlayLayer();
    // Ein Frame warten, damit das Layout berechnet ist und die
    // sichtbaren Bilder korrekte getBoundingClientRect()-Werte haben.
    requestAnimationFrame(() => {
      // Nochmal 1s warten — Instagram lazy-loadet oft, bis die Bilder
      // mit src/data-src geladen sind. Ohne Wartezeit erhalten wir
      // leere oder ungültige URLs und damit keine Buttons.
      setTimeout(() => {
        initExistingMedia();
        scheduleReposition();
        console.log('[IGel] Overlay-layer UI ready.');
      }, 1000);
    });
  } catch (err) {
    console.error('[IGel] Overlay-layer init failed:', err);
  }
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  waitForBodyAndInit();
}
