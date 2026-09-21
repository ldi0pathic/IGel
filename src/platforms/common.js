// IGel shared utilities.

// Allowlist of CDN domains we trust for downloads
export const ALLOWED_DOMAINS = [
  'cdninstagram.com',
];

// True if url's hostname is exactly `host` or a subdomain of it.
export function hostMatches(url, host) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch (e) {
    return false;
  }
}

export function isAllowedDomain(url) {
  return ALLOWED_DOMAINS.some((d) => hostMatches(url, d));
}

export function isHttps(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch (e) {
    return false;
  }
}

export function sanitizeFilename(name) {
  if (!name) return null;
  return name
    .replace(/\.\.[/\\]/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/** Add resolver metadata without changing the resolver's existing item fields. */
export function withItemMeta(item, identity = {}) {
  const { postId = null, username = null } = identity || {};
  const meta = {};
  if (postId !== null && postId !== undefined && postId !== '') {
    meta.postId = String(postId);
  }
  if (username !== null && username !== undefined && username !== '') {
    meta.username = String(username);
  }
  return Object.keys(meta).length > 0 ? { ...item, meta } : item;
}

// --- Template rendering ---

export const TEMPLATE_TOKENS = [
  'platform',
  'type',
  'postId',
  'username',
  'index',
  'date',
];

export const ALWAYS_PRESENT_TOKENS = ['platform', 'type', 'index', 'date'];

/**
 * Render a template against a field bag.
 * A token whose field is missing renders as nothing and takes the separator run
 * directly after it, so a missing field costs its own segment and nothing more.
 */
export function renderTemplate(template, fields) {
  if (typeof template !== 'string') return '';

  const parts = [];
  let cursor = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match.index > cursor) parts.push({ literal: template.slice(cursor, match.index) });
    const value = fields?.[match[1]];
    const present = value !== undefined && value !== null && value !== '';
    parts.push({ token: true, present, text: present ? String(value) : '' });
    cursor = match.index + match[0].length;
  }
  if (cursor < template.length) parts.push({ literal: template.slice(cursor) });

  const out = [];
  let dropSeparator = false;
  for (const part of parts) {
    if (part.token) {
      if (part.present) out.push(part.text);
      dropSeparator = part.present ? false : true;
      continue;
    }
    const literal = dropSeparator ? part.literal.replace(/^[_\-[\s]+/, '') : part.literal;
    dropSeparator = false;
    out.push(literal);
  }

  return out
    .join('')
    .split('/')
    .map((segment) => segment.replace(/^[_\-[\s]+|[_\-[\s]+$/g, ''))
    .join('/');
}

/**
 * Check a user-supplied template before it is saved.
 */
export function validateTemplate(template, options = {}) {
  const allowedTokens = options.allowedTokens || TEMPLATE_TOKENS;
  if (typeof template !== 'string' || template.trim() === '') {
    return { valid: false, reason: 'Template is empty.' };
  }

  if (/[{}]/.test(template.replace(/\{[^}]*\}/g, ''))) {
    return {
      valid: false,
      reason: 'Unmatched { or }. A token is a name wrapped in both braces, like {postId}.',
    };
  }

  const unknown = [
    ...new Set(
      Array.from(template.matchAll(/\{(\w+)\}/g))
        .map((m) => m[1])
        .filter((name) => !allowedTokens.includes(name)),
    ),
  ];
  if (unknown.length > 0) {
    const wrote = unknown.map((u) => `{${u}}`).join(', ');
    const available = allowedTokens.map((t) => `{${t}}`).join(', ');
    return {
      valid: false,
      reason: `Unknown token ${wrote}. Available: ${available}. Tokens are case-sensitive.`,
    };
  }

  if (!options.allowSlash && /[/\\]/.test(template)) {
    return {
      valid: false,
      reason: 'A filename cannot contain / or \\. Use the folder setting above to sort downloads into subfolders.',
    };
  }

  const survivesWithNoFields = renderTemplate(template, {}) !== '';
  const hasGuaranteedToken = ALWAYS_PRESENT_TOKENS.some((t) => template.includes(`{${t}}`));
  if (!survivesWithNoFields && !hasGuaranteedToken) {
    const guaranteed = ALWAYS_PRESENT_TOKENS.map((t) => `{${t}}`).join(', ');
    return {
      valid: false,
      reason: 'This can render to nothing. Add some fixed text, or a token that is always available (' + guaranteed + ') -- the others depend on the post.',
    };
  }

  return { valid: true };
}

/**
 * Decide whether a user-supplied template field is acceptable to save.
 */
export function templateFieldError(value, options = {}) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const result = validateTemplate(value, options);
  return result.valid ? null : result.reason;
}

export function extractId(url, pattern) {
  const match = url.match(pattern);
  return match ? match[1] : null;
}

/**
 * Walk up from `element` to find the first ancestor matching any of `selectors`.
 */
export function findPostContainer(element, selectors) {
  let el = element;
  const body = globalThis.document?.body;
  while (el && el !== body) {
    for (const selector of selectors) {
      if (el.matches(selector)) return el;
    }
    el = el.parentElement;
  }
  return null;
}

// An <img> is content rather than chrome when it is big enough to be worth saving.
export function isContentSized(img) {
  return img.width > 50 || img.naturalWidth > 50 || !img.width;
}

/**
 * Collect img and video elements from a container.
 */
export function collectMediaInContainer(container) {
  const items = [];
  if (!container) return items;

  container.querySelectorAll('img').forEach((img) => {
    const src = img.src || img.dataset.src || '';
    if (src && !src.startsWith('data:')) {
      items.push({ url: src, type: 'image', element: img });
    }
  });

  container.querySelectorAll('video').forEach((video) => {
    const src = video.src || video.querySelector('source')?.src || '';
    if (src && !src.startsWith('blob:')) {
      items.push({ url: src, type: 'video', element: video });
    }
  });

  return items;
}

/**
 * Find the nearest media element (img or video) to a target element.
 */
export function findNearestMedia(element) {
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

// --- Failure classification ---

const PLATFORM_LABELS = {
  instagram: 'Instagram',
};

const TRANSIENT_REMOTE_INTERRUPTS = new Set([
  'NETWORK_FAILED',
  'NETWORK_TIMEOUT',
  'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN',
  'SERVER_FAILED',
  'SERVER_NO_RANGE',
  'SERVER_UNREACHABLE',
  'SERVER_CONTENT_LENGTH_MISMATCH',
]);

const TRANSIENT_LOCAL_INTERRUPTS = new Set([
  'FILE_TRANSIENT_ERROR',
  'FILE_TOO_SHORT',
  'FILE_HASH_MISMATCH',
]);

const BLOCKED_DOWNLOAD_INTERRUPTS = new Set([
  'FILE_VIRUS_INFECTED',
  'FILE_BLOCKED',
  'FILE_SECURITY_CHECK_FAILED',
]);

const DOWNLOAD_FOLDER_INTERRUPTS = new Set([
  'FILE_FAILED',
  'FILE_ACCESS_DENIED',
]);

const INVALID_REMOTE_INTERRUPTS = new Set([
  'NETWORK_INVALID_REQUEST',
  'SERVER_BAD_CONTENT',
  'SERVER_CERT_PROBLEM',
  'SERVER_CROSS_ORIGIN_REDIRECT',
]);

export function platformLabel(platform) {
  return PLATFORM_LABELS[platform] || 'this site';
}

function classifyDownloadInterruption(label, reason) {
  const terminal = (message) => ({ message, retry: 'terminal' });
  const transient = (message) => ({ message, retry: 'transient' });

  if (reason === 'SERVER_UNAUTHORIZED' || reason === 'SERVER_FORBIDDEN') {
    return terminal('This media link expired. Refresh the page and try again.');
  }
  if (TRANSIENT_REMOTE_INTERRUPTS.has(reason)) {
    return transient(`Network problem reaching ${label}. Try again.`);
  }
  if (TRANSIENT_LOCAL_INTERRUPTS.has(reason)) {
    return transient('Chrome could not save this download. Try again.');
  }
  if (reason === 'CRASH') {
    return transient('Chrome stopped this download. Try again.');
  }
  if (reason === 'FILE_NO_SPACE') {
    return terminal('Not enough space to save this download.');
  }
  if (reason === 'FILE_NAME_TOO_LONG') {
    return terminal('The download name is too long. Shorten the filename template and try again.');
  }
  if (reason === 'FILE_TOO_LARGE') {
    return terminal('This file is too large for Chrome to save.');
  }
  if (BLOCKED_DOWNLOAD_INTERRUPTS.has(reason)) {
    return terminal('Chrome blocked this download for safety.');
  }
  if (DOWNLOAD_FOLDER_INTERRUPTS.has(reason)) {
    return terminal('Chrome could not save this download. Check the download folder and try again.');
  }
  if (reason === 'FILE_SAME_AS_SOURCE') {
    return terminal('Chrome cannot save this download over its source file.');
  }
  if (reason === 'USER_CANCELED') {
    return terminal('Download canceled.');
  }
  if (reason === 'USER_SHUTDOWN') {
    return terminal('Chrome closed before this download finished. Try again.');
  }
  if (INVALID_REMOTE_INTERRUPTS.has(reason)) {
    return terminal(`${label} did not return a downloadable file. Refresh the page and try again.`);
  }
  return terminal(`${label} download failed. Try refreshing the page.`);
}

/**
 * Classify a failed download step into a user-facing message plus a retry verdict.
 */
export function classifyFailure({ platform, phase = 'resolve', outcome } = {}) {
  const label = platformLabel(platform);
  const terminal = (message) => ({ message, retry: 'terminal' });
  const transient = (message) => ({ message, retry: 'transient' });

  if (outcome && outcome.kind === 'reason') {
    if (outcome.reason === 'login-required') {
      return terminal(`Log in to ${label} to download this.`);
    }
    return terminal('Could not find downloadable media on this element.');
  }

  if (outcome && outcome.kind === 'download') {
    return classifyDownloadInterruption(label, outcome.reason);
  }

  const status = outcome && outcome.kind === 'http' ? outcome.status : undefined;

  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return transient(`Network problem reaching ${label}. Try again.`);
  }
  if (status === 429) {
    return transient(`${label} is rate-limiting downloads. Try again in a minute.`);
  }
  if (status === 401 || status === 403) {
    return phase === 'download'
      ? terminal('This media link expired. Refresh the page and try again.')
      : terminal(`Log in to ${label} to download this.`);
  }
  if (status === 404) {
    return terminal(`This ${label} media has expired or was not found.`);
  }
  return terminal(`${label} did not return this media. Try refreshing the page.`);
}
