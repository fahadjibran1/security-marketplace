# iOS Build Guide

This project can be built for iPhone using Expo EAS.

## Current setup

- iOS bundle ID: `com.securitymarketplace.mobile`
- API base URL: `https://api.observantsecurity.co.uk`
- EAS project: `security-marketplace`

## Before the first iOS build

1. Create or sign in to an Expo account:
   - [https://expo.dev/signup](https://expo.dev/signup)
2. Join the Apple Developer Program:
   - [https://developer.apple.com/programs/](https://developer.apple.com/programs/)
3. Make sure you can sign in to Apple with the team that will own the app.

## Local config

In:
- [security-mobile-app/.env](C:/Users/Admin/security-marketplace/security-mobile-app/.env)

use:

```env
EXPO_PUBLIC_API_URL=https://api.observantsecurity.co.uk
```

## Login

From:
- [security-mobile-app](C:/Users/Admin/security-marketplace/security-mobile-app)

run:

```powershell
eas login
```

## iOS build options

### 1. Simulator build

Use this if you want to test on an iOS simulator first.

```powershell
eas build --platform ios --profile ios-simulator
```

### 2. Internal / pilot iPhone build

Use this for a limited pilot before App Store release.

```powershell
eas build --platform ios --profile preview
```

### 3. TestFlight / production build

Use this when you're ready to upload to App Store Connect / TestFlight.

```powershell
eas build --platform ios --profile production
```

## First-time prompts

When EAS asks:

- create the iOS app on EAS: `yes`
- let Expo manage Apple credentials: `yes`
- sign in to Apple when prompted

## Submit to TestFlight

After a successful production build:

```powershell
eas submit --platform ios --profile production
```

If prompted, use the same Apple Developer account/team that owns the app.

## Recommended pilot path

1. Run Android pilot first
2. Build iOS with `preview`
3. Test on one real iPhone
4. Move to `production` + TestFlight after the pilot flow is stable

## Notes

- iOS install/distribution is stricter than Android
- TestFlight is the cleanest way to share with company staff using iPhones
- This app currently uses Expo Secure Store and standard platform encryption only; the config is set so non-exempt encryption is declared as `false`
