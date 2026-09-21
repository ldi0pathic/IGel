import { describe, expect, it } from 'vitest';
import { detectPlatform, sanitizeDownloadPath, validateDownloadUrl } from '../src/background.js';
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
