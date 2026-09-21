# IGel development guide

## Project

IGel is a Manifest V3 Chrome extension that downloads Instagram images and videos. Source is ESM in `src/`; `build.js` bundles it with esbuild into `dist/`, the directory loaded by Chrome.

## Architecture

- `src/background.js`: context-menu commands, Instagram API resolution, URL validation, download lifecycle, and local history.
- `src/platforms/instagram.js`: Instagram content script, DOM media resolver, and on-image download controls.
- `src/platforms/instagram-api.js`: pure Instagram API parsing and quality selection helpers.
- `src/platforms/common.js`: shared URL, filename, template, and failure helpers.
- `src/platforms/resolve-cache.js`: short-lived in-memory cache for signed Instagram CDN URLs.
- `src/popup.*`: small status popup.

## Security rules

- Download URLs must use HTTPS and match `cdninstagram.com` exactly or as a subdomain.
- Treat content-script messages as untrusted: validate sender identity, tab context, platform, and every URL before downloading.
- Never persist media URLs. The resolver cache must stay in service-worker memory only.
- Do not add remote code or broaden host permissions without a concrete Instagram requirement.

## Commands

```sh
npm install
npm run lint
npm test
npm run build
npm run build:zip
```

Load `dist/` from `chrome://extensions` with Developer mode enabled after building.
