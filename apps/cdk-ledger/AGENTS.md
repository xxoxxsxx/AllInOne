# Repository Guidelines

## Project Structure & Module Organization

This repo uses `Next.js 16`, `TypeScript`, `Tailwind CSS`, and `PostgreSQL`.

- `src/app`: App Router pages, route handlers, and server actions such as `src/app/events`.
- `src/components`: reusable UI components like `event-list.tsx`.
- `src/lib`: shared modules for config, DB access, schema, events, and time helpers.
- `db/migrations` and `db/seeds`: SQL files for schema setup and base data.
- `scripts`: Node-based DB utilities (`db-migrate.mjs`, `db-seed.mjs`, `db-check.mjs`).
- `docs`: product and deployment notes.
- `public`: static assets.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: start local dev server at `http://localhost:3000`.
- `npm run build`: build the production bundle.
- `npm run start`: run the production build.
- `npm run lint`: run ESLint across the repo.
- `npm run db:migrate`: apply SQL migrations using `DATABASE_URL`.
- `npm run db:seed`: load base seed data.
- `npm run db:check`: verify DB structure and connectivity.
- `docker compose up --build`: run the app in Docker with the local compose file.

## Coding Style & Naming Conventions

Follow the existing style:

- 2-space indentation and double quotes.
- React components in `PascalCase`; utility files use short kebab-case or framework defaults.
- Prefer small functions with direct names like `listRecentEvents`.
- Keep business logic in `src/lib` or server actions, not inside presentational components.

Linting is configured in `eslint.config.mjs` with `eslint-config-next` core web vitals and TypeScript rules.

## Testing Guidelines

There is no dedicated automated test suite yet. For now:

- run `npm run lint` before opening a PR;
- run the relevant DB command when changing schema or seed data;
- manually verify affected flows in `src/app/events`, `src/app/config`, and related routes.

If you add tests later, keep them near the feature or under `tests/`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative messages such as `fix server action redirects` and `build app mvp flows`. Keep commits focused and descriptive.

PRs should include:

- a short summary of behavior changes;
- linked issue or requirement when available;
- screenshots for UI changes;
- migration/seed notes when DB behavior changes.

## Security & Configuration Tips

Copy `.env.example` to `.env.local` and keep real credentials out of Git. Treat `DATABASE_URL`, NAS deployment settings, and Tailscale-only access as environment-specific configuration.
