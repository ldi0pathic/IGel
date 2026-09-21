# Privacy policy

*Last updated: 2026-09-21*

IGel is a browser extension for downloading media from Instagram. It has no developer-operated backend, analytics, or tracking. Media resolution and downloads run in the browser and contact Instagram and Instagram's CDN directly, using the browser's normal signed-in session where access is required.

## Data stored by the extension

- **Download history** (`chrome.storage.local`): Filename, media type, timestamp, and Chrome download ID for successful downloads, up to 50 entries. Media URLs are never stored.
- **Download preferences** (`chrome.storage.sync`): Download folder, filename template, notification preference, and quality preference. Chrome may sync these preferences through the signed-in browser account.
- **In-memory media cache**: Recently resolved Instagram CDN URLs may be kept only in the extension service worker's memory to avoid repeat requests. The cache is lost when Chrome stops the service worker and is never written to Chrome storage.

## What IGel does not collect

IGel does not send browsing history, account data, cookies, media URLs, download history, preferences, analytics, or tracking data to a developer-operated service. It does not operate one.

## User control

Uninstalling IGel deletes extension storage. You can also clear browser download records through Chrome's downloads page and change or remove synced preferences through Chrome Sync settings.

## Responsible use

You are responsible for complying with copyright law and Instagram's terms in your jurisdiction. Download only media you are permitted to use.
