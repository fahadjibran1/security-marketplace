import * as Location from 'expo-location';

export type AttendanceLocationEvidence = {
  latitude?: number;
  longitude?: number;
  gpsAccuracyMeters?: number;
};

type AttendanceLocationOptions = {
  required: boolean;
  promptIfNeeded?: boolean;
};

export async function getAttendanceLocationEvidence(
  options: AttendanceLocationOptions,
): Promise<AttendanceLocationEvidence> {
  const { required, promptIfNeeded = required } = options;

  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== 'granted' && promptIfNeeded) {
    permission = await Location.requestForegroundPermissionsAsync();
  }

  if (permission.status !== 'granted') {
    if (required) {
      throw new Error(
        'Location permission is required to Book On at this site. Allow location access while using S4 Security and try again.',
      );
    }
    return {};
  }

  const servicesEnabled = await Location.hasServicesEnabledAsync();
  if (!servicesEnabled) {
    if (required) {
      throw new Error('Turn on Location Services to Book On at this site, then try again.');
    }
    return {};
  }

  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: true,
    });

    const accuracy = position.coords.accuracy;
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      ...(typeof accuracy === 'number' && Number.isFinite(accuracy)
        ? { gpsAccuracyMeters: Math.max(0, accuracy) }
        : {}),
    };
  } catch (error) {
    if (!required) {
      return {};
    }

    throw new Error(
      error instanceof Error && error.message
        ? `Unable to obtain your current GPS position. ${error.message}`
        : 'Unable to obtain your current GPS position. Check Location Services and try again.',
    );
  }
}
