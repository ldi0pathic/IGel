'use strict';

import {
  ALLOWED_DOMAINS,
  sanitizeFilename,
  renderTemplate,
  withItemMeta,
  classifyFailure,
  platformLabel,
} from './platforms/common.js';
import {
  IG_APP_ID,
  shortcodeToMediaId,
  parsePostMedia,
  extractStoryRef,
  extractHighlightRef,
  parseStoryTray,
  mapIgStatusToMessage,
  mapIgStatusToCode,
  qualityPreferenceFromSetting,
} from './platforms/instagram-api.js';
import { getResolved, setResolved, clearResolveCache } from './platforms/resolve-cache.js';
import { createTracer } from './resolver-debug.js';

const traceResolver = createTracer({ storage: chrome.storage });

// --- Menu constants ---
const MENU_PARENT = 'igel_parent';
const MENU_DOWNLOAD_SINGLE = 'igel_download_single';
const MENU_DOWNLOAD_ALL = 'igel_download_all';
const MENU_DOWNLOAD_ZIP = 'igel_download_zip';

const MENU_CONTEXTS = ['page', 'image', 'video', 'link'];

// --- Menu build ---
async function rebuildContextMenu() {
  await chrome.contextMenus.removeAll();
  const shared = { contexts: MENU_CONTEXTS };
  chrome.contextMenus.create({ id: MENU_PARENT, title: 'IGel', ...shared });
  chrome.contextMenus.create({ id: MENU_DOWNLOAD_SINGLE, parentId: MENU_PARENT, title: 'Download this (HD)', ...shared });
  chrome.contextMenus.create({ id: MENU_DOWNLOAD_ALL, parentId: MENU_PARENT, title: 'Download all from post', ...shared });
  chrome.contextMenus.create({ id: MENU_DOWNLOAD_ZIP, parentId: MENU_PARENT, title: 'Download all as .zip', ...shared });
}

chrome.runtime.onInstalled.addListener(rebuildContextMenu);

// --- Platform detection ---
export function detectPlatform(url) {
  if (!url) return null;
  if (url.includes('instagram.com')) return 'instagram';
  return null;
}

export async function isPlatformEnabled(platform) {
  return true; // Only Instagram — always enabled
}

// --- URL helpers ---
export function guessExtension(url, type) {
  if (type === 'video') return '.mp4';
  try {
    const u = new URL(url);
    const format = u.searchParams.get('format');
    if (format) return `.${format}`;
    const match = u.pathname.match(/\\.(jpg|jpeg|png|webp|gif|mp4|mov)(\\?|$)/i);
    if (match) return `.${match[1].toLowerCase()}`;
  } catch (e) { /* ignore */ }
  return '.jpg';
}

export function validateDownloadUrl(url) {
  if (!url) return { valid: false, reason: 'empty URL' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return { valid: false, reason: 'non-HTTPS URL' };
    const hostname = parsed.hostname.toLowerCase();
    if (!ALLOWED_DOMAINS.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
      return { valid: false, reason: `untrusted domain: ${parsed.hostname}` };
    }
    return { valid: true };
  } catch (e) {
    return { valid: false, reason: 'invalid URL' };
  }
}

// --- Quality preference helpers ---
function qualityCacheId(id, preference) {
  const maxWidth = preference && typeof preference === 'object' && Number.isFinite(preference.maxWidth)
    ? preference.maxWidth : null;
  return JSON.stringify([id, maxWidth]);
}

// --- Instagram post resolver (via private web API) ---
export async function resolveInstagramPost(
  shortcode,
  { fetchImpl = globalThis.fetch, signal, preference = 'largest' } = {},
) {
  const cacheId = qualityCacheId(shortcode, preference);
  const cached = getResolved('instagram_post', cacheId);
  if (cached) return { items: cached };
  try {
    const mediaId = shortcodeToMediaId(shortcode);
    if (!mediaId) return { error: null };

    const resp = await fetchImpl(
      `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
      {
        headers: { 'x-ig-app-id': IG_APP_ID },
        credentials: 'include',
        signal,
      },
    );
    if (!resp.ok) {
      console.warn('IGel: Instagram API returned', resp.status);
      await traceResolver({ platform: 'instagram', path: 'post-api', outcome: 'http-error', status: resp.status });
      return { error: mapIgStatusToMessage(resp.status), code: mapIgStatusToCode(resp.status) };
    }

    const data = await resp.json();
    const items = parsePostMedia(data, shortcode, preference);
    if (items.length === 0) {
      await traceResolver({ platform: 'instagram', path: 'post-api', outcome: 'empty', status: resp.status, itemCount: 0 });
      return { error: mapIgStatusToMessage(0), code: mapIgStatusToCode(0) };
    }

    await traceResolver({ platform: 'instagram', path: 'post-api', outcome: 'ok', status: resp.status, itemCount: items.length });
    setResolved('instagram_post', cacheId, items);
    return { items };
  } catch (e) {
    console.error('IGel: Instagram post API failed:', e);
    await traceResolver({ platform: 'instagram', path: 'post-api', outcome: 'threw' });
    return { error: null };
  }
}

// --- Instagram story/highlight resolvers ---
async function fetchInstagramUserId(username, { fetchImpl = globalThis.fetch, signal } = {}) {
  try {
    const resp = await fetchImpl(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      { headers: { 'x-ig-app-id': IG_APP_ID }, credentials: 'include', signal },
    );
    if (!resp.ok) return { error: mapIgStatusToMessage(resp.status), code: mapIgStatusToCode(resp.status) };
    const data = await resp.json();
    const userId = data?.data?.user?.id || null;
    return userId ? { userId } : { error: null };
  } catch (e) {
    console.error('IGel: IG user lookup failed:', e);
    return { error: null };
  }
}

async function resolveReelsMedia(reelId, { storyId, username = null, detail, fetchImpl = globalThis.fetch, signal, preference = 'largest' } = {}) {
  try {
    const resp = await fetchImpl(
      `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${reelId}`,
      { headers: { 'x-ig-app-id': IG_APP_ID }, credentials: 'include', signal },
    );
    if (!resp.ok) {
      await traceResolver({ platform: 'instagram', path: 'story-api', outcome: 'http-error', status: resp.status });
      return { error: mapIgStatusToMessage(resp.status), code: mapIgStatusToCode(resp.status) };
    }
    const data = await resp.json();
    const items = parseStoryTray(data, { storyId, username, preference });
    if (items.length === 0) {
      await traceResolver({ platform: 'instagram', path: 'story-api', outcome: 'empty', status: resp.status, itemCount: 0, detail: detail ?? (storyId ? 'single story' : 'full tray') });
      return { error: mapIgStatusToMessage(0), code: mapIgStatusToCode(0) };
    }
    await traceResolver({ platform: 'instagram', path: 'story-api', outcome: 'ok', status: resp.status, itemCount: items.length });
    return { items };
  } catch (e) {
    console.error('IGel: IG reels_media API failed:', e);
    await traceResolver({ platform: 'instagram', path: 'story-api', outcome: 'threw' });
    return { error: null };
  }
}

export async function resolveInstagramStories({ username, storyId }, { fetchImpl = globalThis.fetch, signal, preference = 'largest' } = {}) {
  const storyKey = qualityCacheId(`${username}_${storyId ?? 'tray'}`, preference);
  const cached = getResolved('instagram_story', storyKey);
  if (cached) return { items: cached };
  const lookup = await fetchInstagramUserId(username, { fetchImpl, signal });
  if (!lookup.userId) return { error: lookup.error, code: lookup.code };
  const result = await resolveReelsMedia(lookup.userId, { storyId, username, fetchImpl, signal, preference });
  if (result.items) setResolved('instagram_story', storyKey, result.items);
  return result;
}

export async function resolveInstagramHighlights({ highlightId, itemId = null }, { fetchImpl = globalThis.fetch, signal, preference = 'largest' } = {}) {
  const highlightKey = qualityCacheId(`highlight_${highlightId}_${itemId ?? 'all'}`, preference);
  const cached = getResolved('instagram_highlight', highlightKey);
  if (cached) return { items: cached };
  const result = await resolveReelsMedia(`highlight:${highlightId}`, { storyId: itemId, detail: itemId ? 'single highlight item' : 'full highlight', fetchImpl, signal, preference });
  if (result.items) setResolved('instagram_highlight', highlightKey, result.items);
  return result;
}

// --- Resolve via API (background-only, no content script) ---
export async function resolveViaApi(platform, pageUrl, options = {}) {
  if (platform === 'instagram') {
    const match = pageUrl.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (match) {
      const shortcode = match[2];
      const video = await resolveInstagramVideo(shortcode, options);
      if (video.url) {
        await traceResolver({ platform, path: 'api-dispatch', outcome: 'ok', itemCount: 1 });
        return {
          item: withItemMeta(
            { url: video.url, type: 'video', filename: `reel_${shortcode}`, needsVideoLookup: false },
            video.meta || { postId: shortcode },
          ),
        };
      }
      return { item: null, error: video.error };
    }
    // Stories / highlights
    const pathname = new URL(pageUrl).pathname;
    const storyRef = extractStoryRef(pathname);
    if (storyRef) {
      const stories = await resolveInstagramStories(storyRef, options);
      if (stories.items?.length) {
        await traceResolver({ platform, path: 'api-dispatch', outcome: 'ok', itemCount: stories.items.length });
        return { item: stories.items[0] };
      }
      return { item: null, error: stories.error };
    }
    const highlightRef = extractHighlightRef(pathname);
    if (highlightRef) {
      const highlights = await resolveInstagramHighlights(highlightRef, options);
      if (highlights.items?.length) {
        await traceResolver({ platform, path: 'api-dispatch', outcome: 'ok', itemCount: highlights.items.length });
        return { item: highlights.items[0] };
      }
      return { item: null, error: highlights.error };
    }
  }
  return { item: null, error: null };
}

async function resolveInstagramVideo(shortcode, options = {}) {
  const post = await resolveInstagramPost(shortcode, options);
  if (!post.items) return { error: post.error, code: post.code };
  const video = post.items.find((it) => it.type === 'video');
  return video ? { url: video.url, meta: video.meta } : { error: null };
}

// --- Resolve helper: turns items with needsVideoLookup into concrete URLs ---
async function resolveItem(item, options = {}) {
  if (!item.needsVideoLookup) return item;
  if (item.shortcode) {
    const resolved = await resolveInstagramVideo(item.shortcode, options);
    if (!resolved?.url) return null;
    return withItemMeta(
      { ...item, url: resolved.url, needsVideoLookup: false },
      { ...(item.meta || {}), ...(resolved.meta || {}) },
    );
  }
  return null;
}

export async function resolveItemUrl(item, options = {}) {
  return (await resolveItem(item, options))?.url ?? null;
}

// --- Filename and path helpers ---
export function formatLocalDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function buildTemplateFields(item, platform, index = 1, date = formatLocalDate(new Date())) {
  return {
    platform,
    type: item.type || 'file',
    postId: item.meta?.postId,
    username: item.meta?.username,
    index,
    date,
  };
}

export function resolveBaseFilename(item, platform, template, index = 1, fields = buildTemplateFields(item, platform, index)) {
  if (!template) return item.filename || `${platform}_${index}`;
  const rendered = renderTemplate(template, fields);
  if (!rendered) return item.filename || `${platform}_${index}`;
  return rendered;
}

export function sanitizeDownloadPath(rawFilename, platform, ext, downloadPath, fields = {}) {
  const filename = rawFilename
    .replace(/^[A-Za-z]:/, '')
    .replace(/\.\.[/\\]/g, '')
    .replace(/(^|[/\\])\.\.[/\\]?/g, '$1')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const template = downloadPath || 'IGel/{platform}';
  const rendered = renderTemplate(template, { ...fields, platform })
    .replace(/^[A-Za-z]:/, '')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_');
  const normalizedFolder = rendered
    .split(/[/\\]+/)
    .filter((seg) => {
      const winForm = seg.replace(/[ .]+$/, '');
      return winForm !== '' && winForm !== '.' && winForm !== '..';
    })
    .join('/') || platform;
  return normalizedFolder + '/' + filename + ext;
}

// --- Download ---
async function downloadMedia(item, platform, index = 1, resolveOptions = {}) {
  if (item.needsVideoLookup) {
    const resolvedItem = await resolveItem(item, resolveOptions);
    if (!resolvedItem) {
      console.warn('IGel: video API lookup returned no URL');
      return null;
    }
    item = resolvedItem;
  }

  const validation = validateDownloadUrl(item.url);
  if (!validation.valid) {
    console.warn(`IGel: rejected ${validation.reason}`);
    return null;
  }

  const { downloadPath, filenameTemplate } = await chrome.storage.sync.get({
    downloadPath: 'IGel/{platform}',
    filenameTemplate: '',
  });
  const ext = guessExtension(item.url, item.type);
  const fields = buildTemplateFields(item, platform, index);
  const rawFilename = resolveBaseFilename(item, platform, filenameTemplate, index, fields);
  const path = sanitizeDownloadPath(rawFilename, platform, ext, downloadPath, fields);

  try {
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: path,
      conflictAction: 'uniquify',
    });
    return { downloadId, filename: await savedBasename(downloadId, path) };
  } catch (e) {
    console.error('IGel: download failed:', e);
    return null;
  }
}

// --- Filename waiting helper ---
const FILENAME_ASSIGN_TIMEOUT_MS = 2000;

function awaitFilenameDelta(downloadId, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve) => {
    const finish = (value) => { cancel(); resolve(value); };
    const listener = (delta) => {
      if (delta.id === downloadId && delta.filename?.current) finish(delta.filename.current);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    cancel = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
    };
    chrome.downloads.onChanged.addListener(listener);
  });
  return { promise, cancel };
}

async function savedBasename(downloadId, requestedPath) {
  const fallback = requestedPath.slice(requestedPath.lastIndexOf('/') + 1);
  const waiter = awaitFilenameDelta(downloadId, FILENAME_ASSIGN_TIMEOUT_MS);
  try {
    const [saved] = await chrome.downloads.search({ id: downloadId });
    const stillNaming = saved?.state === 'in_progress';
    const p = saved?.filename || (stillNaming ? await waiter.promise : null);
    if (!p) return fallback;
    return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  } catch (e) {
    return fallback;
  } finally {
    waiter.cancel();
  }
}

// --- Download batch tracking ---
const PENDING_DOWNLOADS_KEY = 'pendingDownloadStates';
const PENDING_DOWNLOAD_BATCHES_KEY = 'pendingDownloadBatches';
let pendingDownloadWrites = Promise.resolve();
let terminalLifecycleWrites = Promise.resolve();
const settlingDownloads = new Set();

function queueTerminalLifecycle(run) {
  const next = terminalLifecycleWrites.then(run);
  terminalLifecycleWrites = next.catch(() => {});
  return next;
}

function updatePendingDownloads(mutate) {
  const next = pendingDownloadWrites.then(async () => {
    const stored = await chrome.storage.local.get({ [PENDING_DOWNLOADS_KEY]: {}, [PENDING_DOWNLOAD_BATCHES_KEY]: {} });
    const pending = stored[PENDING_DOWNLOADS_KEY] || {};
    const batches = stored[PENDING_DOWNLOAD_BATCHES_KEY] || {};
    const result = mutate(pending, batches);
    await chrome.storage.local.set({ [PENDING_DOWNLOADS_KEY]: pending, [PENDING_DOWNLOAD_BATCHES_KEY]: batches });
    return result;
  });
  pendingDownloadWrites = next.catch(() => {});
  return next;
}

function newDownloadBatchId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function createDownloadBatch({ platform, total, notify, successLabel }) {
  const batchId = newDownloadBatchId();
  try {
    await updatePendingDownloads((_pending, batches) => {
      batches[batchId] = {
        platform, expectedTotal: total, total: 0, completed: 0, failed: 0,
        registrationComplete: false, notify: Boolean(notify), successLabel,
      };
    });
    return batchId;
  } catch (error) {
    console.warn('IGel: could not initialize download tracking:', error);
    return null;
  }
}

function notifyDownloadBatch(batch) {
  if (!batch?.notify) return;
  const label = platformLabel(batch.platform);
  if (batch.failed === 0) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: `Downloaded ${batch.successLabel} from ${label}.` });
  } else if (batch.completed === 0) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: `IGel: download failed for ${label}.` });
  } else {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: `${batch.completed} downloads completed; ${batch.failed} failed from ${label}.` });
  }
}

function applyDownloadBatchOutcome(batches, batchId, outcome, failure = null) {
  const batch = batches[batchId];
  if (!batch) return null;
  batch[outcome === 'complete' || outcome === 'history_failed' ? 'completed' : 'failed'] += 1;
  if (outcome === 'failed' && failure?.message && !batch.failureMessage) batch.failureMessage = failure.message;
  if (!batch.registrationComplete || batch.completed + batch.failed < batch.total) return null;
  delete batches[batchId];
  return { ...batch };
}

export async function markDownloadStartFailed(batchId) {
  if (!batchId) return;
  try {
    const settledBatch = await updatePendingDownloads((_pending, batches) => {
      const batch = batches[batchId];
      if (!batch) return null;
      batch.total += 1;
      return applyDownloadBatchOutcome(batches, batchId, 'failed');
    });
    notifyDownloadBatch(settledBatch);
  } catch (error) {
    console.warn('IGel: could not update download tracking:', error);
  }
}

function finishBatchRegistration(batches, batchId) {
  const batch = batches[batchId];
  if (!batch) return null;
  const missing = Math.max(0, batch.expectedTotal - batch.total);
  batch.total += missing;
  batch.failed += missing;
  batch.registrationComplete = true;
  if (batch.completed + batch.failed < batch.total) return null;
  delete batches[batchId];
  return { ...batch };
}

export async function finishDownloadBatchRegistration(batchId) {
  if (!batchId) return;
  try {
    const settledBatch = await updatePendingDownloads((_pending, batches) => finishBatchRegistration(batches, batchId));
    notifyDownloadBatch(settledBatch);
  } catch (error) {
    console.warn('IGel: could not finish download tracking:', error);
  }
}

async function pendingDownload(downloadId) {
  await pendingDownloadWrites;
  const { [PENDING_DOWNLOADS_KEY]: pending = {} } = await chrome.storage.local.get({ [PENDING_DOWNLOADS_KEY]: {} });
  return pending[String(downloadId)] || null;
}

async function performTerminalSettlement(downloadId, outcome, interruptReason) {
  const key = String(downloadId);
  const tracked = await pendingDownload(downloadId);
  if (!tracked) return null;

  const failure = outcome === 'failed' && interruptReason
    ? classifyFailure({ platform: tracked.platform, phase: 'download', outcome: { kind: 'download', reason: interruptReason } })
    : null;

  let finalOutcome = outcome;
  if (outcome === 'complete') {
    try {
      await recordDownload(tracked.item, tracked.platform, downloadId);
    } catch (error) {
      console.warn('IGel: could not record completed download:', error);
      finalOutcome = 'history_failed';
    }
  }

  const settledBatch = await updatePendingDownloads((pending, batches) => {
    const current = pending[key];
    if (!current) return null;
    delete pending[key];
    return applyDownloadBatchOutcome(batches, current.batchId, finalOutcome, failure);
  });
  notifyDownloadBatch(settledBatch);
  return finalOutcome;
}

async function settleTerminalDownload(downloadId, outcome, interruptReason = null) {
  const key = String(downloadId);
  if (settlingDownloads.has(key)) return null;
  settlingDownloads.add(key);
  try {
    return await queueTerminalLifecycle(() => performTerminalSettlement(downloadId, outcome, interruptReason));
  } catch (error) {
    console.warn('IGel: could not settle terminal download:', error);
    return 'history_failed';
  } finally {
    settlingDownloads.delete(key);
  }
}

export async function trackTerminalDownload({ batchId, downloadId, item, platform }) {
  const trackedItem = { filename: item.filename, type: item.type || 'image' };
  if (!batchId) return 'history_failed';
  try {
    await updatePendingDownloads((pending, batches) => {
      const key = String(downloadId);
      if (pending[key]) return;
      const batch = batches[batchId];
      if (!batch) throw new Error('Download batch is missing');
      pending[key] = { batchId, item: trackedItem, platform };
      batch.total += 1;
    });
  } catch (error) {
    console.warn('IGel: could not persist download tracking:', error);
    return 'history_failed';
  }

  const current = await findDownload(downloadId);
  if (current?.state === 'complete') return settleTerminalDownload(downloadId, 'complete');
  if (current?.state === 'interrupted' && !current.canResume) return settleTerminalDownload(downloadId, 'failed', current.error);
  return 'pending';
}

export async function reconcilePendingDownloads() {
  await pendingDownloadWrites;
  const { [PENDING_DOWNLOADS_KEY]: pending = {}, [PENDING_DOWNLOAD_BATCHES_KEY]: batchesAtStart = {} } = await chrome.storage.local.get({
    [PENDING_DOWNLOADS_KEY]: {}, [PENDING_DOWNLOAD_BATCHES_KEY]: {},
  });
  const interruptedBatchIds = Object.entries(batchesAtStart)
    .filter(([, batch]) => !batch.registrationComplete)
    .map(([batchId]) => batchId);
  for (const downloadId of Object.keys(pending)) {
    const current = await findDownload(Number(downloadId));
    if (current?.state === 'complete') await settleTerminalDownload(downloadId, 'complete');
    else if (isTerminalDownload(current)) await settleTerminalDownload(downloadId, 'failed', current?.error);
  }
  const settledBatches = await updatePendingDownloads((_pending, batches) => {
    const settled = [];
    for (const batchId of interruptedBatchIds) {
      const batch = batches[batchId];
      if (!batch || batch.registrationComplete) continue;
      const result = finishBatchRegistration(batches, batchId);
      if (result) settled.push(result);
    }
    return settled;
  });
  settledBatches.forEach(notifyDownloadBatch);
}

async function findDownload(downloadId) {
  try {
    const results = await chrome.downloads.search({ id: downloadId });
    return results.length > 0 ? results[0] : null;
  } catch (e) {
    console.warn('IGel: could not query download state:', e);
    return undefined;
  }
}

function isTerminalDownload(item) {
  return item === null || item?.state === 'complete' || (item?.state === 'interrupted' && !item.canResume);
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state === 'complete') {
    await Promise.all([settleTerminalDownload(delta.id, 'complete')]);
    return;
  }
  const stoppedBeingResumable = delta.canResume && delta.canResume.current !== true;
  if (state !== 'interrupted' && !stoppedBeingResumable) return;
  clearResolveCache();
  const item = await findDownload(delta.id);
  if (isTerminalDownload(item)) {
    await settleTerminalDownload(delta.id, 'failed', item?.error || delta.error?.current);
  }
});

chrome.downloads.onErased.addListener(async (downloadId) => {
  await settleTerminalDownload(downloadId, 'failed');
});

// --- Download history ---
let downloadHistoryWrites = Promise.resolve();

export function clearDownloadHistory() {
  return queueTerminalLifecycle(() => {
    const next = downloadHistoryWrites.then(() => chrome.storage.local.set({ downloadHistory: [] }));
    downloadHistoryWrites = next.catch(() => {});
    return next;
  });
}

async function recordDownload(item, platform, downloadId) {
  const rawFilename = item.filename || `${Date.now()}`;
  const filename = rawFilename.replace(/\.\.[/\\]/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const entry = { filename, platform, type: item.type || 'image', timestamp: Date.now(), downloadId };

  const next = downloadHistoryWrites.then(async () => {
    const { downloadHistory } = await chrome.storage.local.get({ downloadHistory: [] });
    if (downloadHistory.some((existing) => existing.downloadId === downloadId)) return;
    downloadHistory.push(entry);
    if (downloadHistory.length > 50) downloadHistory.splice(0, downloadHistory.length - 50);
    await chrome.storage.local.set({ downloadHistory });
  });
  downloadHistoryWrites = next.catch(() => {});
  return next;
}

// --- Context menu handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const isZipMenu = info.menuItemId === MENU_DOWNLOAD_ZIP;
  const type = (info.menuItemId === MENU_DOWNLOAD_ALL || isZipMenu) ? 'all' : 'single';

  const platform = detectPlatform(tab.url);
  if (!platform) {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: 'IGel does not support this site.' });
    return;
  }

  const platformSettings = await chrome.storage.sync.get({
    showNotifications: true,
    zipMultiPosts: false,
    downloadQuality: 'largest',
  });
  const resolveOptions = { preference: qualityPreferenceFromSetting(platformSettings.downloadQuality) };

  try {
    let response;
    let igError = null;
    const pageUrl = info.pageUrl || tab.url;
    let triedIgPostApi = false;

    // Instagram: "download all" → API enumeration first
    if (platform === 'instagram' && type === 'all') {
      const shortcode = pageUrl.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[2];
      if (shortcode) {
        triedIgPostApi = true;
        const post = await resolveInstagramPost(shortcode, resolveOptions);
        if (post.items) {
          response = { urls: post.items, platform };
        } else if (post.error) {
          igError = post.error;
        }
      }
    }

    // Instagram stories / highlights
    if (platform === 'instagram' && !response) {
      const pathname = new URL(pageUrl).pathname;
      const storyRef = extractStoryRef(pathname);
      const highlightRef = storyRef ? null : extractHighlightRef(pathname);
      if (storyRef) {
        const ref = type === 'all' ? { ...storyRef, storyId: null } : storyRef;
        const stories = await resolveInstagramStories(ref, resolveOptions);
        if (stories.items) response = { urls: stories.items, platform };
        else if (stories.error) igError = stories.error;
      } else if (highlightRef) {
        const ref = type === 'all' ? { ...highlightRef, itemId: null } : highlightRef;
        const highlights = await resolveInstagramHighlights(ref, resolveOptions);
        if (highlights.items) response = { urls: highlights.items, platform };
        else if (highlights.error) igError = highlights.error;
      }
    }

    // Fallback: try API video resolution, then content-script DOM
    if (!response) {
      const apiResult = await resolveViaApi(platform, pageUrl, resolveOptions);
      if (apiResult?.error) igError = apiResult.error;
      if (apiResult?.item) {
        response = { urls: [apiResult.item], platform };
      } else {
        try {
          response = await chrome.tabs.sendMessage(tab.id, {
            action: 'resolve',
            type,
            srcUrl: info.srcUrl || '',
            pageUrl,
            preference: resolveOptions.preference,
          });
          await traceResolver({
            platform, path: 'dom',
            outcome: response?.urls?.length ? 'ok' : 'empty',
            itemCount: response?.urls?.length || 0,
          });
        } catch (sendErr) {
          console.warn('IGel: content script unavailable:', sendErr.message);
          await traceResolver({ platform, path: 'dom', outcome: 'unavailable', detail: 'content script not loaded' });
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['platforms/instagram.js'],
            });
            await new Promise((r) => setTimeout(r, 150));
            response = await chrome.tabs.sendMessage(tab.id, {
              action: 'resolve',
              type,
              srcUrl: info.srcUrl || '',
              pageUrl,
              preference: resolveOptions.preference,
            });
            await traceResolver({
              platform, path: 'dom-injected',
              outcome: response?.urls?.length ? 'ok' : 'empty',
              itemCount: response?.urls?.length || 0,
            });
          } catch (injectErr) {
            await traceResolver({ platform, path: 'dom-injected', outcome: 'threw' });
            chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: 'IGel: could not connect to page. Try refreshing.' });
            return;
          }
        }
      }
    }

    // Feed/grid carousels: if DOM returned only ~2 slides and a shortcode exists, enumerate full post via API
    if (platform === 'instagram' && type === 'all' && !triedIgPostApi && response && response.shortcode) {
      const post = await resolveInstagramPost(response.shortcode, resolveOptions);
      if (post.items) {
        response = { urls: post.items, platform };
      } else if (post.error) {
        igError = post.error;
      }
    }

    if (!response || !response.urls || response.urls.length === 0) {
      const msg = (platform === 'instagram' && igError) ? igError : 'Could not find downloadable media on this element.';
      chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: msg });
      return;
    }

    const successLabel = response.urls.length === 1 ? '1 file' : `${response.urls.length} files`;
    const batchId = await createDownloadBatch({
      platform: response.platform,
      total: response.urls.length,
      notify: platformSettings.showNotifications,
      successLabel,
    });
    let count = 0;

    for (const [position, item] of response.urls.entries()) {
      let saved = null;
      try {
        saved = await downloadMedia(item, response.platform, position + 1, resolveOptions);
      } catch {
        console.warn('IGel: a download item failed before it could start.');
      }
      if (saved) {
        try {
          await trackTerminalDownload({ batchId, downloadId: saved.downloadId, item: { ...item, filename: saved.filename }, platform: response.platform });
          count++;
        } catch {
          await markDownloadStartFailed(batchId);
          console.warn('IGel: could not track a started download.');
        }
      } else {
        await markDownloadStartFailed(batchId);
      }
    }
    await finishDownloadBatchRegistration(batchId);

    if (count === 0) {
      console.warn(
        `IGel: all ${response.urls.length} download attempt(s) failed for ${response.platform}`,
        response.urls.map((item) => ({ type: item.type, filename: item.filename })),
      );
    }
  } catch (error) {
    console.error('IGel error:', error);
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'IGel', message: 'IGel: something went wrong. Try refreshing the page.' });
  }
});

// --- Content script ↔ background messaging ---

/**
 * Verarbeitet ein Download-Batch von mehreren Items (vom Content Script Button-Klick).
 */
async function handleDownloadBatch(items, platform) {
  if (!items || items.length === 0) {
    console.warn('IGel: downloadBatch called with no items');
    return;
  }

  const platformSettings = await chrome.storage.sync.get({
    showNotifications: true,
    downloadQuality: 'largest',
  });
  const resolveOptions = { preference: qualityPreferenceFromSetting(platformSettings.downloadQuality) };

  const successLabel = items.length === 1 ? '1 file' : `${items.length} files`;
  const batchId = await createDownloadBatch({
    platform,
    total: items.length,
    notify: platformSettings.showNotifications,
    successLabel,
  });

  let count = 0;

  for (const [position, item] of items.entries()) {
    let saved = null;
    try {
      saved = await downloadMedia(item, platform, position + 1, resolveOptions);
    } catch {
      console.warn('IGel: a download item failed before it could start.');
    }

    if (saved) {
      try {
        await trackTerminalDownload({ batchId, downloadId: saved.downloadId, item: { ...item, filename: saved.filename }, platform });
        count++;
      } catch {
        await markDownloadStartFailed(batchId);
        console.warn('IGel: could not track a started download.');
      }
    } else {
      await markDownloadStartFailed(batchId);
    }
  }

  await finishDownloadBatchRegistration(batchId);

  if (count === 0) {
    console.warn(
      `IGel: all ${items.length} download attempt(s) failed for ${platform}`,
      items.map((item) => ({ type: item.type, filename: item.filename })),
    );
  }
}

/**
 * Lädt alle Medien eines Instagram-Posts über die API (wie Context Menu "Download all").
 * Wird vom Content Script Button-Klick auf Carousel-Posts aufgerufen.
 */
async function handleDownloadFromShortcode(shortcode, preference, tabId) {
  const resolveOptions = { preference };

  // API-Resolve wie beim Context Menu
  const post = await resolveInstagramPost(shortcode, resolveOptions);
  if (!post.items || post.items.length === 0) {
    console.warn('IGel: no items for shortcode', shortcode);
    return;
  }

  const platformSettings = await chrome.storage.sync.get({
    showNotifications: true,
    downloadQuality: 'largest',
  });

  const successLabel = post.items.length === 1 ? '1 file' : `${post.items.length} files`;
  const batchId = await createDownloadBatch({
    platform: 'instagram',
    total: post.items.length,
    notify: platformSettings.showNotifications,
    successLabel,
  });

  let count = 0;

  for (const [position, item] of post.items.entries()) {
    let saved = null;
    try {
      saved = await downloadMedia(item, 'instagram', position + 1, resolveOptions);
    } catch {
      console.warn('IGel: a download item failed before it could start.');
    }

    if (saved) {
      try {
        await trackTerminalDownload({ batchId, downloadId: saved.downloadId, item: { ...item, filename: saved.filename }, platform: 'instagram' });
        count++;
      } catch {
        await markDownloadStartFailed(batchId);
        console.warn('IGel: could not track a started download.');
      }
    } else {
      await markDownloadStartFailed(batchId);
    }
  }

  await finishDownloadBatchRegistration(batchId);

  if (count === 0) {
    console.warn(
      `IGel: all ${post.items.length} download attempt(s) failed for Instagram`,
      post.items.map((item) => ({ type: item.type, filename: item.filename })),
    );
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (message.action === 'getCapturedMedia' && sender.tab) {
    sendResponse({ urls: [] });
    return true;
  }

  if (message.action === 'clearDownloadHistory') {
    clearDownloadHistory().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
    return true;
  }

  // Download-Batch vom Content Script (Button-Klick)
  if (message.action === 'downloadBatch' && message.items && sender.tab) {
    handleDownloadBatch(message.items, message.platform || 'instagram').then(
      () => sendResponse({ ok: true }),
      (err) => {
        console.error('IGel: downloadBatch error:', err);
        sendResponse({ ok: false, error: err.message });
      },
    );
    return true;
  }

  // Download über Shortcode (Button-Klick auf Carousel-Post)
  if (message.action === 'downloadFromShortcode' && message.shortcode && sender.tab) {
    handleDownloadFromShortcode(message.shortcode, message.preference || 'largest', sender.tab.id).then(
      () => sendResponse({ ok: true }),
      (err) => {
        console.error('IGel: downloadFromShortcode error:', err);
        sendResponse({ ok: false, error: err.message });
      },
    );
    return true;
  }
});

// --- Startup reconciliation ---
void reconcilePendingDownloads().catch((error) => {
  console.warn('IGel: could not reconcile pending downloads:', error);
});
