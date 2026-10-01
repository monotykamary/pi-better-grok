# Changelog

## 0.3.8

- Validate Pi 1.0.0 with exact development pins and wildcard host peers.
- Await startup model refresh so it cannot escape the session lifecycle and access a disposed context.
- Clear captured pooling context on shutdown and exercise the real host lifecycle offline.

## 0.3.7

- Validate against Pi 0.99.0, including an offline real-host package-loading probe.
- Declare imported host packages as wildcard peers and pin development dependencies to Pi 0.99.0.
- Preserve native image and classifier catalogs when adding fallback chat models.
