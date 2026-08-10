const fs = require('node:fs');
const path = require('node:path');

// Keep shared mobile types aligned with the attendance verification API.
// GPS collection itself is installed once at app startup via attendanceTransport.ts.
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

console.log('Guard Mobile attendance verification types are synchronized.');
