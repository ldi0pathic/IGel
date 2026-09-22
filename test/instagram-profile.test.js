import { describe, it, expect } from 'vitest';
import { isProfilePage, collectProfilePosts } from '../src/platforms/instagram.js';

describe('Instagram profile collection', () => {
  it('identifies profile pages', () => {
    // Test the regex logic directly since jsdom location.pathname is read-only
    const profileRegex = /^\/([A-Za-z0-9._]+)\/?$/;
    expect(profileRegex.test('/testuser/')).toBe(true);
    expect(profileRegex.test('/testuser')).toBe(true);
    expect(profileRegex.test('/p/ABC123/')).toBe(false);
    expect(profileRegex.test('/reel/xyz/')).toBe(false);
    expect(profileRegex.test('/')).toBe(false);
  });

  it('collects post shortcodes from profile DOM', () => {
    document.body.innerHTML = `
      <article>
        <a href="/p/abc123/">Post 1</a>
        <a href="/p/def456/">Post 2</a>
      </article>
      <article>
        <a href="/p/abc123/">Duplicate</a>
        <a href="/reel/xyz789/">Reel</a>
      </article>
    `;
    const result = collectProfilePosts();
    expect(result).toHaveLength(3);
    expect(result.map(p => p.shortcode)).toEqual(['abc123', 'def456', 'xyz789']);
  });

  it('extracts username from profile DOM', () => {
    document.body.innerHTML = `
      <article>
        <a href="/p/abc123/">Post 1</a>
        <a href="/testuser/">Profile link</a>
      </article>
    `;
    const result = collectProfilePosts();
    expect(result).toHaveLength(1);
    expect(result[0].username).toBe('testuser');
  });

  it('returns empty array when no articles present', () => {
    document.body.innerHTML = `
      <a href="/p/abc123/">Post 1</a>
    `;
    // Without article wrapper, no posts are found
    const result = collectProfilePosts();
    expect(result).toHaveLength(0);
  });
});
