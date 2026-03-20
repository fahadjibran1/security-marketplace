# Deployment Guide

## 1. Backend deployment

Use [security-backend-nest](/C:/Users/Admin/security-marketplace/security-backend-nest) as the production API.

### Recommended option: Render
This repo now includes [render.yaml](/C:/Users/Admin/security-marketplace/render.yaml).

Typical Render flow:
1. Push this repo to GitHub.
2. In Render, create a new Blueprint deployment from the repo.
3. Confirm the web service uses `security-backend-nest` as `rootDir`.
4. Set the unsynced env vars in Render:
   - `DATABASE_URL`
   - `CORS_ORIGIN`
5. Deploy and confirm health check:
   - `GET /health`
6. Verify API startup before pointing the mobile app at it.

### Option A: container deploy
Build the image:
```bash
cd security-backend-nest
docker build -t security-marketplace-api .
```

Run it:
```bash
docker run --env-file .env -p 3000:3000 security-marketplace-api
```

### Option B: Node process deploy
```bash
cd security-backend-nest
npm ci
npm run build
npm run start:prod
```

### Production env recommendations
- `NODE_ENV=production`
- `DATABASE_SYNCHRONIZE=false` after the baseline migration has been applied
- `ENABLE_SWAGGER=false` unless you explicitly want public docs
- `CORS_ORIGIN` set to only your app/dev origins
- strong `JWT_SECRET`
- hosted Postgres with SSL if required by provider
- Render health check path: `/health`

### Migrations
This repo now includes a TypeORM data source and migration scripts in
[security-backend-nest/src/database](/C:/Users/Admin/security-marketplace/security-backend-nest/src/database).

Run migrations from [security-backend-nest](/C:/Users/Admin/security-marketplace/security-backend-nest):

```bash
npm ci
npm run migration:run
```

Recommended production sequence:
1. Keep `DATABASE_SYNCHRONIZE=true` only long enough to bootstrap an existing pilot database.
2. Run `npm run migration:run`.
3. Set `DATABASE_SYNCHRONIZE=false`.
4. Restart the backend.

### Basic Postgres backups
Backup scripts live in [ops](/C:/Users/Admin/security-marketplace/ops):
- [backup-postgres.sh](/C:/Users/Admin/security-marketplace/ops/backup-postgres.sh)
- [restore-postgres.sh](/C:/Users/Admin/security-marketplace/ops/restore-postgres.sh)
- [install-backup-cron.sh](/C:/Users/Admin/security-marketplace/ops/install-backup-cron.sh)

Typical Hetzner setup:

```bash
sudo cp ops/backup-postgres.sh /usr/local/bin/backup-postgres.sh
sudo cp ops/restore-postgres.sh /usr/local/bin/restore-postgres.sh
sudo cp ops/install-backup-cron.sh /usr/local/bin/install-backup-cron.sh
sudo chmod +x /usr/local/bin/backup-postgres.sh /usr/local/bin/restore-postgres.sh /usr/local/bin/install-backup-cron.sh
sudo /usr/local/bin/install-backup-cron.sh
```

Backups default to:

```text
/var/backups/security-marketplace
```

### Static download page
A simple pilot download site is included in
[download-site](/C:/Users/Admin/security-marketplace/download-site).

Serve it from:

```text
download.observantsecurity.co.uk
```

and place the latest APK at:

```text
/var/www/download.observantsecurity.co.uk/app/observant-security-pilot.apk
```

## 2. Mobile app deployment

Use [security-mobile-app](/C:/Users/Admin/security-marketplace/security-mobile-app).

### Environment
Set:
```bash
EXPO_PUBLIC_API_URL=https://your-api-domain.example.com
```

### EAS build setup
```bash
cd security-mobile-app
npm install
npx eas login
npx eas build:configure
```

Build internal preview:
```bash
npx eas build --platform android --profile preview
npx eas build --platform ios --profile preview
```

Build production:
```bash
npx eas build --platform android --profile production
npx eas build --platform ios --profile production
```

## 3. Pilot testing flow
- deploy backend first
- point mobile app to deployed API
- set `EXPO_PUBLIC_API_URL` to the deployed Render URL
- test company signup -> guard signup -> apply -> hire -> shift -> check-in/out -> timesheet approval -> incident report
- test on physical devices, not just emulator/simulator

## 4. Before store submission
- final app icon and splash assets
- privacy policy and terms
- support email
- final bundle IDs if branding changes
- store screenshots and descriptions
