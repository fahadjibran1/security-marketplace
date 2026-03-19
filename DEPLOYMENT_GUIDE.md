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
- `DATABASE_SYNCHRONIZE=false`
- `ENABLE_SWAGGER=false` unless you explicitly want public docs
- `CORS_ORIGIN` set to only your app/dev origins
- strong `JWT_SECRET`
- hosted Postgres with SSL if required by provider
- Render health check path: `/health`

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
