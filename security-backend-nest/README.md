# Security Marketplace Backend

NestJS + PostgreSQL backend for the security companies and guards mobile app.

## Current MVP scope
- Auth with company and guard roles
- Company and guard profiles
- Jobs, applications, hiring, assignments, shifts
- Attendance check-in / check-out
- Timesheet generation and company approval
- Incident reporting and company resolution

## Local setup
1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Set either:
   - `DATABASE_URL`
   - or `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME`
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run in development:
   ```bash
   npm run start:dev
   ```
5. Build for production:
   ```bash
   npm run build
   npm run start:prod
   ```

## Important env vars
- `PORT`: API port, default `3000`
- `JWT_SECRET`: required for non-demo deployments
- `CORS_ORIGIN`: comma-separated allowed origins
- `TRUST_PROXY`: set `true` behind Render/Nginx or pass a hop count such as `1`
- `ENABLE_SWAGGER`: `true` or `false`
- `DATABASE_SSL`: `true` for hosted Postgres providers that require SSL
- `DATABASE_SYNCHRONIZE`: keep `true` only for development; set `false` for production

## Production safeguards
- Startup now fails fast in production if `JWT_SECRET` is missing/default, `CORS_ORIGIN` is unset or wildcard, or `DATABASE_SYNCHRONIZE=true`
- `/health` now checks database connectivity and returns `503` when the API is up but the database is unavailable
- The API disables `x-powered-by`, enables proxy awareness, and sends a minimal set of baseline security headers

## API docs
- Swagger: `/api-docs` when `ENABLE_SWAGGER=true`

## Pilot deployment notes
- Use a managed Postgres instance
- Set a strong `JWT_SECRET`
- Turn `DATABASE_SYNCHRONIZE=false` in production
- Restrict `CORS_ORIGIN` to your app/dev hosts
- Review seed/demo accounts before pilot launch

## Docker deploy
This repo now includes [Dockerfile](/C:/Users/Admin/security-marketplace/security-backend-nest/Dockerfile) and [.dockerignore](/C:/Users/Admin/security-marketplace/security-backend-nest/.dockerignore).

Build:
```bash
docker build -t security-marketplace-api .
```

Run:
```bash
docker run --env-file .env -p 3000:3000 security-marketplace-api
```
