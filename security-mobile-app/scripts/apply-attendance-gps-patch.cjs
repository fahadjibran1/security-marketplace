const fs = require('node:fs');
const path = require('node:path');

function patchFile(relativePath, patches) {
  const filePath = path.resolve(__dirname, '..', relativePath);
  let source = fs.readFileSync(filePath, 'utf8');

  for (const patch of patches) {
    if (source.includes(patch.after)) continue;
    if (!source.includes(patch.before)) {
      throw new Error(`Expected source fragment not found in ${relativePath}: ${patch.label}`);
    }
    source = source.replace(patch.before, patch.after);
  }

  fs.writeFileSync(filePath, source);
}

patchFile('src/types/models.ts', [
  {
    label: 'site attendance verification fields',
    before: `  welfareCheckIntervalMinutes: number;\n  specialInstructions?: string | null;\n  company?: CompanyProfile;`,
    after: `  welfareCheckIntervalMinutes: number;\n  specialInstructions?: string | null;\n  latitude?: number | null;\n  longitude?: number | null;\n  geofenceRadiusMeters?: number;\n  requireGpsCheckIn?: boolean;\n  requireNfcCheckIn?: boolean;\n  company?: CompanyProfile;`,
  },
  {
    label: 'attendance event GPS fields',
    before: `  type: 'check-in' | 'check-out';\n  nfcTag?: string | null;\n  notes?: string | null;`,
    after: `  type: 'check-in' | 'check-out';\n  nfcTag?: string | null;\n  nfcVerified?: boolean;\n  latitude?: number | null;\n  longitude?: number | null;\n  gpsAccuracyMeters?: number | null;\n  distanceFromSiteMeters?: number | null;\n  gpsVerified?: boolean;\n  notes?: string | null;`,
  },
  {
    label: 'attendance request GPS fields',
    before: `export interface RecordAttendancePayload {\n  shiftId: number;\n  nfcTag?: string;\n  notes?: string;\n}`,
    after: `export interface RecordAttendancePayload {\n  shiftId: number;\n  nfcTag?: string;\n  latitude?: number;\n  longitude?: number;\n  gpsAccuracyMeters?: number;\n  notes?: string;\n}`,
  },
]);

patchFile('src/screens/GuardDashboardScreen.tsx', [
  {
    label: 'attendance location import',
    before: `import { clearStoredSession } from '../services/session';`,
    after: `import { clearStoredSession } from '../services/session';\nimport { getAttendanceLocationEvidence } from '../services/attendanceLocation';`,
  },
  {
    label: 'GPS-aware check-in',
    before: `      setAttendanceBusyShiftId(shiftId);\n      await checkInShift({ shiftId });`,
    after: `      setAttendanceBusyShiftId(shiftId);\n      const shift = shifts.find((candidate) => candidate.id === shiftId);\n      const gpsRequired = Boolean(shift?.site?.requireGpsCheckIn);\n      const locationEvidence = await getAttendanceLocationEvidence({\n        required: gpsRequired,\n        promptIfNeeded: gpsRequired,\n      });\n      await checkInShift({ shiftId, ...locationEvidence });`,
  },
  {
    label: 'GPS-aware check-out',
    before: `      setAttendanceBusyShiftId(shiftId);\n      await checkOutShift({ shiftId });`,
    after: `      setAttendanceBusyShiftId(shiftId);\n      const locationEvidence = await getAttendanceLocationEvidence({\n        required: false,\n        promptIfNeeded: false,\n      });\n      await checkOutShift({ shiftId, ...locationEvidence });`,
  },
]);

console.log('Guard Mobile attendance GPS source wiring is synchronized.');
