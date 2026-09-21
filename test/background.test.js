import { describe, expect, it } from 'vitest';
import {
  applyFallbackUsername,
  detectPlatform,
  sanitizeDownloadPath,
  validateDownloadUrl,
} from '../src/background.js';
import { downloadPathError } from '../src/popup.js';

describe('Instagram security boundaries', () => {
  it('accepts only Instagram hosts', () => {
    expect(detectPlatform('https://www.instagram.com/p/example/')).toBe('instagram');
    expect(detectPlatform('https://instagram.com.evil.example/p/example/')).toBeNull();
    expect(detectPlatform('https://evilinstagram.com/p/example/')).toBeNull();
  });

  it('allows only HTTPS Instagram CDN media', () => {
    expect(validateDownloadUrl('https://scontent.cdninstagram.com/v/t51.1-19/photo.jpg')).toEqual({ valid: true });
    expect(validateDownloadUrl('http://scontent.cdninstagram.com/photo.jpg').valid).toBe(false);
    expect(validateDownloadUrl('https://cdninstagram.com.evil.example/photo.jpg').valid).toBe(false);
  });

  it('removes traversal and Windows-reserved filename characters', () => {
    expect(sanitizeDownloadPath('../unsafe:name', 'instagram', '.jpg', '../IGel/{platform}'))
      .toBe('IGel/instagram/unsafe_name.jpg');
  });
});


describe('download path configuration', () => {
  it('accepts documented placeholders and nested folders', () => {
    expect(downloadPathError('IGel/{username}/{date}')).toBeNull();
  });

  it('rejects traversal and unknown placeholders before saving', () => {
    expect(downloadPathError('IGel/../private')).toContain('nicht erlaubt');
    expect(downloadPathError('IGel/{account}')).toContain('{account}');
  });
});

describe('feed download metadata', () => {
  it('uses the article username only when the API did not provide one', () => {
    expect(applyFallbackUsername([
      { meta: { postId: 'post-id' } },
      { meta: { postId: 'post-id', username: 'api_owner' } },
    ], 'feed_owner')).toEqual([
      { meta: { postId: 'post-id', username: 'feed_owner' } },
      { meta: { postId: 'post-id', username: 'api_owner' } },
    ]);
  });

  it('ignores an invalid username sent by a page', () => {
    const items = [{ meta: { postId: 'post-id' } }];
    expect(applyFallbackUsername(items, '../unsafe')).toBe(items);
  });
});
