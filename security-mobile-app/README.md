# Security Marketplace Mobile App

Expo React Native mobile app for security companies and guards.

## Current MVP scope
- Persistent auth and role-based dashboards
- Company and guard onboarding/profile editing
- Job posting, applying, hiring, and shift creation
- Guard attendance check-in / check-out
- Company timesheet approval
- Guard incident reporting and company review

## Local setup
1. Copy env:
   ```bash
   cp .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start Expo:
   ```bash
   npm run start:mobile
   ```
4. Point the app at the Nest backend:
   - default local API: `http://localhost:3000`
   - override with `EXPO_PUBLIC_API_URL`

## Build check
```bash
npm run build
```

## Release notes
- Replace bundle identifiers before store submission if you want final brand-specific IDs
- Add app icon, splash, privacy policy URL, and support email before publishing
- Test API connectivity on physical devices because `localhost` will not work off-emulator

## EAS builds
This repo now includes [eas.json](/C:/Users/Admin/security-marketplace/security-mobile-app/eas.json) with `development`, `preview`, and `production` profiles.

Typical flow:
```bash
npx eas login
npx eas build --platform android --profile preview
npx eas build --platform ios --profile production
```
