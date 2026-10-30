// The device side of the stale temporary-file sweep (S4 1.2.0, Patrols P1-E hardening). Kept apart from patrolNative.ts,
// which never touches the cache (evidence is never stored there); this module only lists and deletes stale temporaries
// the camera and the image manipulator leave in the cache. patrolTempCleanup.ts decides what may go.

import { Directory, File, Paths } from 'expo-file-system';
import type { PatrolTempCleanupPorts, PatrolTempFile } from '../components/guard/patrol/patrolTempCleanup';
import { patrolOutboxStore } from './patrolNative';

// The cache folders the camera and the image manipulator write their temporary output to (expo-camera
// `<cache>/Camera`, expo-image-manipulator `<cache>/ImageManipulator`). Nothing else is ever swept.
const TEMP_FOLDERS = ['Camera', 'ImageManipulator'];

/** The device side of the stale temporary-file sweep (patrolTempCleanup.ts decides what may go). */
export function patrolTempCleanupPorts(): PatrolTempCleanupPorts {
  const folders = TEMP_FOLDERS.map((name) => new Directory(Paths.cache, name));
  const prefixes = folders.map((folder) => folder.uri.replace(/\/?$/, '/'));
  return {
    listTempFiles: async () => {
      const out: PatrolTempFile[] = [];
      for (const folder of folders) {
        if (!folder.exists) continue;
        for (const entry of folder.list()) {
          if (entry instanceof File) out.push({ uri: entry.uri, modifiedAtMs: entry.modificationTime ?? null });
        }
      }
      return out;
    },
    referencedPaths: () => patrolOutboxStore().referencedFilePaths(),
    isTempLocation: (uri) => prefixes.some((prefix) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes('/')),
    deleteFile: async (uri) => {
      const file = new File(uri);
      if (file.exists) file.delete();
    },
  };
}
