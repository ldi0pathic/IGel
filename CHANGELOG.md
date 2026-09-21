# Changelog

## Unreleased

### Changed
- Renamed the extension to IGel and narrowed its scope to Instagram only.
- Removed legacy multi-platform, landing-page, offscreen ZIP, clipboard, optional-permission, and store-publishing code.
- Reintroduced deterministic release-archive creation for `npm run build:zip`.

### Fixed
- The popup now awaits Chrome's asynchronous tab query before checking the current site.
- Instagram detection now validates the parsed hostname instead of accepting lookalike URLs containing `instagram.com`.
