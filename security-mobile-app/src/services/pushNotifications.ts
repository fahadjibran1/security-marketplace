// The phone side of Welfare Check notifications: permission, the Expo push token, the Android channel, the iOS/Android
// action buttons, and taps. The only module that touches expo-notifications. Web does nothing here.
//
// It also carries the Guard's other notifications (kind 'guard_notification': shift offers, extension requests and the
// like). Those use their own Android channel ('shift-updates', default importance), have no buttons, and a tap opens
// the Guard's inbox in S4. They never pass through the Welfare handling, and Welfare pushes never pass through theirs.
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
import {
  isGuardNotificationData,
  parseGuardNotificationResponse,
  SHIFT_UPDATES_CHANNEL_ID,
  SHIFT_UPDATES_CHANNEL_NAME,
  type GuardNotificationIntent,
} from '../components/guard/guardInbox';

const NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';
let configured = false;
let registeredToken: string | null = null;
// The device (FCM/APNs) token last obtained. Fetching the device token makes expo-notifications report it to every push
// token listener as if it had changed, so a listener that registered again on every report would loop forever (one
// Android phone sent POST /push-devices four times a second). A report of the token already obtained is that echo.
let deviceToken: string | null = null;
// One registration at a time: callers that arrive while one is running share its result.
let inFlight: Promise<PushRegistration> | null = null;
// Bumped on sign-out, so a registration still running for the previous Guard records nothing.
let generation = 0;

export type PushRegistration = 'registered' | 'denied' | 'unavailable' | 'unsupported';
export type DevicePushToken = Notifications.DevicePushToken;

/** Channel, buttons and foreground presentation. Idempotent; safe to call on every start. */
export async function configureWelfareNotifications(): Promise<void> {
  if (!NATIVE || configured) return;
  configured = true;
  try {
    // A reminder that arrives while S4 is open is still shown: the Guard may be on another screen. The same applies to
    // Guard notifications (shift offers, extension requests): every S4 push shows as a normal banner in the foreground.
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
  // Separate from the Welfare setup above so a failure here can never stop Welfare Checks being configured.
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(SHIFT_UPDATES_CHANNEL_ID, {
        name: SHIFT_UPDATES_CHANNEL_NAME,
        description: 'Shift offers, changes and extension requests.',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    } catch {
      // Without the channel Android shows these on its default channel; the inbox in S4 still lists them.
    }
  }
}

const tokenText = (token: Notifications.DevicePushToken) => (typeof token.data === 'string' ? token.data : JSON.stringify(token.data));

/**
 * Ask for permission (once; the operating system remembers a refusal), get this installation's Expo push token, and
 * register it for the signed-in Guard. Never throws. `rotated` is a device token the operating system reported as new;
 * it is used as is rather than fetched, because fetching would report it to the listeners once more.
 */
export function registerWelfarePush(rotated?: Notifications.DevicePushToken): Promise<PushRegistration> {
  if (!NATIVE) return Promise.resolve('unsupported');
  if (inFlight) {
    if (!rotated) return inFlight;
    // A report that arrives mid-registration is usually the echo of the fetch in progress: once that finishes, it is
    // the token already obtained and nothing more is sent. A genuinely different token is registered after it.
    return inFlight.then((state) => (tokenText(rotated) === deviceToken ? state : registerWelfarePush(rotated)));
  }
  const mine = attemptRegistration(rotated, generation).finally(() => { if (inFlight === mine) inFlight = null; });
  inFlight = mine;
  return mine;
}

async function attemptRegistration(rotated: Notifications.DevicePushToken | undefined, startedIn: number): Promise<PushRegistration> {
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      permission = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } });
    }
    if (!permission.granted) return 'denied';
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    // The device token is fetched here, and remembered before anything else is awaited, so its echo is recognised.
    const devicePushToken = rotated ?? (await Notifications.getDevicePushTokenAsync());
    if (startedIn === generation) deviceToken = tokenText(devicePushToken);
    const { data: token } = await Notifications.getExpoPushTokenAsync({ ...(projectId ? { projectId } : {}), devicePushToken });
    await registerPushDevice({ token, platform: Platform.OS as 'ios' | 'android', appVersion: Constants.expoConfig?.version });
    if (startedIn === generation) registeredToken = token;
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
  // The next Guard to sign in on this phone registers afresh, without sharing anything still running for this one.
  deviceToken = null;
  inFlight = null;
  generation += 1;
  if (!NATIVE || !token) return;
  try {
    await Promise.race([unregisterPushDevice(token), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  } catch {
    // Best effort; the server also revokes tokens the provider reports as no longer registered.
  }
}

/**
 * A token the operating system rotated is registered again, so reminders keep arriving. The echo of S4's own fetch
 * (the token already obtained) is ignored; registerWelfarePush checks again for an echo that overtakes the fetch.
 */
export function subscribeTokenChanges(onChange: (token: Notifications.DevicePushToken) => void): () => void {
  if (!NATIVE) return () => undefined;
  const sub = Notifications.addPushTokenListener((token: Notifications.DevicePushToken) => {
    if (tokenText(token) !== deviceToken) onChange(token);
  });
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

/**
 * Taps on Guard notifications (kind 'guard_notification'), including the one that launched S4 from closed. Each tap is
 * reported once and the notification cleared from the tray. Welfare Check taps are left to subscribeWelfareResponses.
 */
export function subscribeGuardNotificationResponses(onIntent: (intent: GuardNotificationIntent) => void): () => void {
  if (!NATIVE) return () => undefined;
  const seen = new Set<string>();
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!response) return;
    const request = response.notification.request;
    const intent = parseGuardNotificationResponse({ actionIdentifier: response.actionIdentifier, data: request.content.data, requestId: request.identifier });
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

/** A Guard notification that arrived while S4 is open, so the inbox can refresh. Reads nothing from the payload. */
export function subscribeGuardNotificationsReceived(onReceived: () => void): () => void {
  if (!NATIVE) return () => undefined;
  const sub = Notifications.addNotificationReceivedListener((notification: Notifications.Notification) => {
    if (isGuardNotificationData(notification.request.content.data)) onReceived();
  });
  return () => sub.remove();
}
