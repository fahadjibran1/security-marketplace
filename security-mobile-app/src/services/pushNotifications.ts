// The phone side of Welfare Check notifications: permission, the Expo push token, the Android channel, the iOS/Android
// action buttons, and taps. The only module that touches expo-notifications. Web does nothing here.
//
// Why the buttons open S4 rather than answering in the background: in an Expo app a notification action that does not
// open the app reaches JavaScript only if the app happens to be alive in the background; when it has been closed or
// suspended the tap is not delivered until S4 next starts, and iOS gives no guaranteed time to finish a request.
// A confirmation that might silently not happen is worse than one that visibly opens S4 for a second, so both buttons
// open S4, which then submits with the Guard's own session (or asks them to sign in first). The phone must be unlocked
// first, so a locked phone in someone else's hand cannot answer.

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { registerPushDevice, unregisterPushDevice } from './api';
import {
  ACTION_IM_SAFE,
  ACTION_NEED_HELP,
  parseWelfareResponse,
  WELFARE_CATEGORY_ID,
  WELFARE_CHANNEL_ID,
  type WelfareIntent,
} from '../components/guard/welfarePush';

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';
let configured = false;
let registeredToken: string | null = null;

export type PushRegistration = 'registered' | 'denied' | 'unavailable' | 'unsupported';

/** Channel, buttons and foreground presentation. Idempotent; safe to call on every start. */
export async function configureWelfareNotifications(): Promise<void> {
  if (!NATIVE || configured) return;
  configured = true;
  try {
    // A reminder that arrives while S4 is open is still shown: the Guard may be on another screen.
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(WELFARE_CHANNEL_ID, {
        name: 'Welfare Checks',
        description: 'Reminders to confirm that you are safe and on duty.',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
        vibrationPattern: [0, 400, 200, 400],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    await Notifications.setNotificationCategoryAsync(WELFARE_CATEGORY_ID, [
      { identifier: ACTION_IM_SAFE, buttonTitle: "I'm Safe", options: { opensAppToForeground: true, isAuthenticationRequired: true } },
      { identifier: ACTION_NEED_HELP, buttonTitle: 'Need Help', options: { opensAppToForeground: true, isAuthenticationRequired: true, isDestructive: true } },
    ]);
  } catch {
    // A device without notification support keeps working; Welfare Checks remain available in S4.
  }
}

/**
 * Ask for permission (once; the operating system remembers a refusal), get this installation's Expo push token, and
 * register it for the signed-in Guard. Never throws.
 */
export async function registerWelfarePush(): Promise<PushRegistration> {
  if (!NATIVE) return 'unsupported';
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    }
    if (!permission.granted) return 'denied';
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await registerPushDevice({ token, platform: Platform.OS as 'ios' | 'android', appVersion: Constants.expoConfig?.version });
    registeredToken = token;
    return 'registered';
  } catch {
    // e.g. no network, or the build has no push credentials yet. Reminders simply do not arrive; nothing else changes.
    return 'unavailable';
  }
}

/** On sign-out, while the session is still valid: stop reminders to this phone for this Guard. Never throws. */
export async function unregisterWelfarePush(): Promise<void> {
  const token = registeredToken;
  registeredToken = null;
  if (!NATIVE || !token) return;
  try {
    await Promise.race([unregisterPushDevice(token), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  } catch {
    // Best effort; the server also revokes tokens the provider reports as no longer registered.
  }
}

/** A token the operating system rotated is registered again, so reminders keep arriving. */
export function subscribeTokenChanges(onChange: () => void): () => void {
  if (!NATIVE) return () => undefined;
  const sub = Notifications.addPushTokenListener(() => onChange());
  return () => sub.remove();
}

/**
 * Taps on Welfare Check notifications, including the one that launched S4 from closed. Each tap is reported once.
 * The notification is cleared from the tray once handled.
 */
export function subscribeWelfareResponses(onIntent: (intent: WelfareIntent) => void): () => void {
  if (!NATIVE) return () => undefined;
  const seen = new Set<string>();
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const request = response.notification.request;
    const intent = parseWelfareResponse({ actionIdentifier: response.actionIdentifier, data: request.content.data, requestId: request.identifier });
    if (!intent || seen.has(intent.key)) return;
    seen.add(intent.key);
    onIntent(intent);
    Notifications.dismissNotificationAsync(request.identifier).catch(() => undefined);
    Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined);
  };
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  Notifications.getLastNotificationResponseAsync().then(handle).catch(() => undefined);
  return () => sub.remove();
}
