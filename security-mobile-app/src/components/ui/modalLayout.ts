// Overlay layout for AppModal. (Phase 2, P0 native live-shift action forms.)
//
// WHAT WENT WRONG
// The Guard live-shift action forms (Add Log, Check Call, Incident, Welfare, Panic) were not modals at
// all. Each was an absolutely-positioned View rendered inside the screen's own view tree:
//
//   modalBackdrop: { position:'absolute', top:0,right:0,bottom:0,left:0, justifyContent:'flex-end',
//                    padding:16, zIndex:20 }
//
// Four separate defects fell out of that one decision, and together they hid Submit:
//
//   1. zIndex WITHOUT elevation. On Android sibling paint order is decided by elevation, not zIndex, and
//      the persistent bottom nav carries elevation:6 against the overlay's 0 — so the nav painted OVER
//      the form, covering exactly the strip where Submit sits.
//   2. A flat 16px bottom padding, so the card's bottom edge sat under the Android system navigation.
//   3. No ScrollView anywhere, so content taller than the screen could not be reached at all.
//   4. No keyboard handling, so opening the keyboard on a 120px-tall multiline input left nothing to do
//      but guess where the button went.
//
// THE FIX IS NOT PADDING
// Adding bottom padding to four forms would have treated the symptom four times. A real Modal renders in
// its own native window ABOVE the host view hierarchy, so the elevation race cannot happen, and its
// footer can live outside the scroll container so the actions are reachable whatever the content does.
// That is what AppModal already is, so the forms move onto it and this module holds the numbers.
//
// This file is deliberately pure: the layout is arithmetic over the viewport, the safe-area insets and
// the keyboard, so it can be executed in tests across screen sizes instead of eyeballed on one device.

/** The two platform behaviours that matter here. `web` behaves like Android for this purpose. */
export type ModalPlatform = 'ios' | 'android' | 'web';

export type SafeAreaInsets = { top: number; bottom: number };

export type ModalViewport = {
  /** Usable height in dp. On Android with softwareKeyboardLayoutMode:'resize' this already excludes the keyboard. */
  height: number;
  width: number;
};

/** Gap kept between the overlay edge and the panel, so the panel never touches the screen edge. */
export const OVERLAY_GUTTER = 24;

/**
 * The smallest panel we will allow the viewport to squeeze us to. Below this the form is unusable and it
 * is better for the panel to keep its height and let its own body scroll.
 */
export const MIN_PANEL_HEIGHT = 200;

/**
 * Proportion of the usable viewport a panel may occupy. Not 100%: leaving the backdrop visible is what
 * tells the user this is a dismissible overlay rather than a new screen.
 */
export const MAX_PANEL_VIEWPORT_RATIO = 0.92;

export type ModalLayout = {
  /** Padding for the overlay, already including the safe-area insets. */
  overlayPaddingTop: number;
  overlayPaddingBottom: number;
  overlayPaddingHorizontal: number;
  /**
   * Hard ceiling on the panel height. THIS is what makes the body actually scroll: a panel that sizes
   * itself to its content cannot shrink, so its ScrollView never has a reason to scroll and the content
   * simply overflows off-screen.
   */
  panelMaxHeight: number;
  /**
   * `padding` for KeyboardAvoidingView on iOS, where the OS overlays the keyboard and the view must give
   * way itself. Android and web resize the window instead, so asking for avoidance there would apply the
   * offset twice and push the footer off the top.
   */
  keyboardBehavior: 'padding' | undefined;
  /** Extra bottom padding under the footer so the action row clears the system navigation. */
  footerSafeAreaPadding: number;
};

/**
 * Resolves the overlay layout for one render.
 *
 * `keyboardVisible` is only consulted on iOS: on Android the viewport height has already shrunk, so
 * reacting to the flag as well would subtract the keyboard twice.
 */
export function resolveModalLayout({
  viewport,
  insets,
  platform,
  keyboardVisible = false,
  keyboardHeight = 0,
}: {
  viewport: ModalViewport;
  insets: SafeAreaInsets;
  platform: ModalPlatform;
  keyboardVisible?: boolean;
  keyboardHeight?: number;
}): ModalLayout {
  const isIos = platform === 'ios';

  const overlayPaddingTop = OVERLAY_GUTTER + Math.max(0, insets.top);
  // The footer sits at the bottom of the panel, so the system navigation inset has to be cleared
  // somewhere. It goes on the overlay rather than inside the footer so a modal with no footer is spaced
  // correctly too.
  const overlayPaddingBottom = OVERLAY_GUTTER + Math.max(0, insets.bottom);
  const overlayPaddingHorizontal = OVERLAY_GUTTER;

  // On iOS the keyboard floats over the window, so the height it covers has to be taken off ourselves.
  const iosKeyboardTakes = isIos && keyboardVisible ? Math.max(0, keyboardHeight) : 0;

  const available =
    viewport.height - overlayPaddingTop - overlayPaddingBottom - iosKeyboardTakes;

  // Never below MIN_PANEL_HEIGHT: on a very short viewport the panel keeps a usable height and its own
  // body scrolls, which is recoverable. A 40px panel is not.
  const panelMaxHeight = Math.max(MIN_PANEL_HEIGHT, Math.floor(available * MAX_PANEL_VIEWPORT_RATIO));

  return {
    overlayPaddingTop,
    overlayPaddingBottom,
    overlayPaddingHorizontal,
    panelMaxHeight,
    keyboardBehavior: isIos ? 'padding' : undefined,
    footerSafeAreaPadding: 0,
  };
}

/**
 * Whether the body needs to scroll for this content — i.e. whether the fix is doing anything.
 *
 * Exported so a test can assert the interesting case (content taller than the panel) rather than only
 * the comfortable one, and so the contract is stated in one place: the FOOTER IS NEVER PART OF THE
 * SCROLLABLE AREA, which is the whole reason Submit stays reachable.
 */
export function bodyMustScroll({
  contentHeight,
  headerHeight,
  footerHeight,
  panelMaxHeight,
}: {
  contentHeight: number;
  headerHeight: number;
  footerHeight: number;
  panelMaxHeight: number;
}): boolean {
  return contentHeight > panelMaxHeight - headerHeight - footerHeight;
}
