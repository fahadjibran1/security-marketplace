# Launch Checklist

## Backend
- Create production `.env` from [security-backend-nest/.env.example](/C:/Users/Admin/security-marketplace/security-backend-nest/.env.example)
- Set strong `JWT_SECRET`
- Set `DATABASE_SYNCHRONIZE=false`
- Configure `CORS_ORIGIN` for real app/dev hosts
- Deploy Nest backend and confirm `/api-docs` access policy
- Create pilot seed accounts or onboarding plan

## Mobile
- Replace bundle IDs in [security-mobile-app/app.json](/C:/Users/Admin/security-marketplace/security-mobile-app/app.json)
- Set production API base URL in mobile env
- Add app icon, splash assets, and brand copy
- Test on real Android and iPhone devices
- Verify login, job flow, attendance, timesheets, and incidents against deployed API

## Product / Ops
- Prepare privacy policy and terms
- Define incident response workflow for critical alerts
- Decide support contact email and escalation path
- Confirm retention policy for attendance and incident records
- Decide pilot customer onboarding script and demo accounts

## Store / Pilot Readiness
- Android: Play Console app created
- iOS: App Store Connect app created
- Screenshots and store descriptions prepared
- Internal pilot checklist run end-to-end
