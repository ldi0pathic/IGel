# IGel

IGel is a Manifest V3 Chrome extension for downloading Instagram images and videos at the highest available quality. It works directly on Instagram: use the download button shown on media or right-click a post and select an IGel action.

## Features

- Download individual images and videos
- Download all media from Instagram carousel posts, reels, stories, and highlights
- Resolve full-resolution Instagram CDN media through the page and Instagram's own API
- Choose the largest available media or limit downloads to 1080 px or 720 px
- Save files in `IGel/instagram/` by default, or configure a folder template in the toolbar popup
- Strict HTTPS and Instagram CDN allowlist before a download starts

## Install for development

```sh
npm install
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the generated `dist/` directory.

## Commands

```sh
npm run lint
npm test
npm run build
npm run build:zip
```

## Privacy

IGel has no backend, analytics, or tracking. Media resolution and downloads take place in the browser and communicate only with Instagram and its media CDN. See [PRIVACY.md](PRIVACY.md) for details.

## License

MIT. See [LICENSE](LICENSE).
