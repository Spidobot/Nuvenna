# Nuvenna

**Know. Share. Together.**

Self-hosted team wiki with real-time editing: spaces and page trees, versions, comments, templates, search, export and import, public links — and live ticket and query blocks from Tickvana.

Nuvenna works on its own and pairs with **[Tickvana](https://github.com/spidobot/tickvana)**
(issue tracking and service desk): both sit behind one
address, share one sign-in, and show each other's content with the reader's rights.

## Features

- Spaces with a page tree; every page edited together in real time
- Versions with comparison, comments on the page and on marked text, labels, watching, favourites, blog posts
- Templates, search, export as Markdown, HTML and ZIP, Markdown import, print styles for PDF
- Public links with expiry, space permissions and page restrictions
- Ticket blocks and query blocks from Tickvana, shown with each reader's rights; back-references
- A knowledge base for Tickvana's customer portal; OpenID Connect sign-in, branding, German and English

## Install

Docker, with PostgreSQL or MariaDB:

```bash
cd docker
cp .env.example .env    # set BASE_URL, SECRET_KEY, passwords
docker compose --profile with-db up -d
```

The compose file starts Nuvenna, Tickvana, the database and a Caddy proxy that
puts both apps on one address. Open `BASE_URL`; the first visit creates the
administrator account.

- Image: `ghcr.io/spidobot/nuvenna`
- [Installation, settings, upgrades, backups](docs/install.md)
- [Unraid](docs/unraid.md) — templates in [`unraid/`](unraid)
- [Single sign-on with Microsoft Entra ID](docs/sso-entra.md)
- [SQL query tables](docs/query-tables.md)

## Develop

Node 22+, pnpm through `corepack`, Docker for the test databases.

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm lint
corepack pnpm test   # against real PostgreSQL and MariaDB (Testcontainers)
```

See [CONTRIBUTING.md](CONTRIBUTING.md). `packages/core` and `packages/ui` are shared
with Tickvana and kept in step between both repositories.

## Licence

Copyright © 2026 the Nuvenna contributors.
[GNU Affero General Public License v3.0 only](LICENSE): if you run a changed version
for others over a network, offer them its source.
