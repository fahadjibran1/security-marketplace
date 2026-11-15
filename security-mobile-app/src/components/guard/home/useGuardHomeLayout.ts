import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { guardHomeLayout, type GuardHomeLayout } from './guardHomeLayout';

/** The Guard Home layout for the current window and system text scale; re-evaluated on rotation or a text-size change. */
export function useGuardHomeLayout(): GuardHomeLayout {
  const { width, height, fontScale } = useWindowDimensions();
  return useMemo(() => guardHomeLayout({ width, height, fontScale }), [width, height, fontScale]);
}
