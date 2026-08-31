We are working on an EXISTING Expo React Native mobile app for a security workforce platform.

IMPORTANT:
This is NOT a redesign task.
Do NOT redesign the whole app.
Do NOT invent backend behavior.
Do NOT use fake fields that are not in the API contract.
Do NOT create unnecessary abstractions.
Keep the UI simple, operational, and pilot-ready.

CURRENT APP GOAL:
Deliver a stable guard mobile experience for real pilot use.

FRONTEND PRINCIPLES:
- small focused screens/components
- stable navigation
- no hidden core features
- no giant all-in-one screen files
- loading, empty, error, success states must exist
- mobile-friendly layout first
- keep code readable and maintainable

PREFERRED SCREEN STRUCTURE:
- HomeScreen
- JobsScreen
- ShiftsScreen
- HistoryScreen
- ProfileScreen

PREFERRED FEATURE SPLIT:
JobsScreen:
- Open Jobs
- My Applications

ShiftsScreen:
- Upcoming Shifts
- Active Shift
- Shift History

API CONTRACT:
[PASTE TESTED ENDPOINTS, REQUESTS, RESPONSES, AUTH RULES HERE]

TASK:
[PASTE YOUR FRONTEND TASK HERE]

NON-NEGOTIABLE RULES:
- Use only the tested backend contract
- Never guess fields or endpoint names
- Preserve existing navigation unless this task is specifically about navigation
- Prefer extracting small presentational components over growing one massive screen
- Avoid popup chaos
- Use a single controlled modal state where appropriate
- Keep auth usage consistent with existing API layer
- Handle date/time carefully and consistently

REQUIRED OUTPUT:
1. Short implementation summary
2. Changed files only
3. COMPLETE final contents of each changed file
4. Brief manual test checklist
5. Note any assumptions explicitly

DONE WHEN:
- feature works end-to-end against real backend
- loading state works
- empty state works
- error state works
- navigation remains stable
- code is compile-safe
- no fake data