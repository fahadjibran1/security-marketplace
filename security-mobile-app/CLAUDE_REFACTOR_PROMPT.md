We are working on an EXISTING security workforce mobile/frontend codebase.

This task is a CLEANUP / REFACTOR / DEBUG task.
The goal is to improve implementation quality WITHOUT changing the product scope.

IMPORTANT RULES:
- Do NOT redesign the whole app
- Do NOT change stable backend contracts
- Do NOT rewrite unrelated files
- Do NOT introduce unnecessary abstractions
- Preserve current behavior unless the task explicitly includes a bug fix
- Make minimal, targeted improvements
- Output changed files only
- If a file changes, provide the COMPLETE final file

FOCUS AREAS:
- simplify state management
- reduce duplicated logic
- fix modal conflicts
- improve screen/component separation
- fix navigation instability
- fix date/time rendering issues
- improve readability and maintainability
- preserve pilot-ready simplicity

CURRENT PRODUCT CONTEXT:
This is a real security operations app for pilot use.
The app must feel usable, stable, and practical.
It does NOT need fancy architecture or overengineering.

TASK:
[PASTE YOUR CLEANUP / DEBUG TASK HERE]

CONTEXT FILES:
[PASTE CURRENT SCREEN / COMPONENT / HOOK FILES HERE]

REQUIRED APPROACH:
1. identify the actual root cause
2. preserve working behavior
3. simplify the implementation
4. fix only what is necessary
5. keep integration points stable
6. avoid broad rewrites

REQUIRED OUTPUT:
1. Root cause explanation
2. What was simplified/fixed
3. Changed files only
4. COMPLETE final contents of each changed file
5. Short manual verification checklist

SUCCESS CRITERIA:
- less state chaos
- fewer side effects
- easier future maintenance
- same or improved behavior
- stable UI flow
- compile-safe code

If there is a choice between “architecturally impressive” and “easy to maintain”, choose easy to maintain.