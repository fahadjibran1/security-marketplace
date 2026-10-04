import * as React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brand, colors, control, radii, spacing, typography } from '../theme';

const IS_WEB = typeof document !== 'undefined';

export interface AppErrorBoundaryProps {
  children?: React.ReactNode;
  /** Offered only when there is a session to end. */
  onSignOut?: () => void | Promise<void>;
  /**
   * Optional reporting hook (e.g. error monitoring once it is approved). Receives the error only — never
   * the component stack, which can name screens and props. The boundary works identically without it.
   */
  onError?: (error: unknown) => void;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

/**
 * The last line of defence against a blank white screen.
 *
 * Any error thrown while rendering anything beneath this boundary replaces the whole app with a plain S4
 * recovery screen: what happened in one sentence, Try again, Reload (web), and Sign out when signed in.
 * Nothing from the failed screen is echoed — no stack trace, no error message, no incident, Welfare or
 * Log Book content — because the message of an arbitrary render error can contain any of it.
 */
export class AppErrorBoundary extends React.Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    try {
      this.props.onError?.(error);
    } catch {
      // A failing reporter must never take the recovery screen down with it.
    }
  }

  private retry = () => {
    this.setState({ failed: false });
  };

  private reload = () => {
    if (IS_WEB && typeof window !== 'undefined' && window.location) window.location.reload();
    else this.retry();
  };

  private signOut = async () => {
    try {
      await this.props.onSignOut?.();
    } finally {
      this.setState({ failed: false });
    }
  };

  render() {
    if (!this.state.failed) return this.props.children ?? null;

    return (
      <View style={styles.screen} accessibilityRole="alert" testID="app-error-boundary">
        <View style={styles.card}>
          <Text style={styles.brand}>{brand.appName}</Text>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>
            {brand.appName} hit an unexpected problem and could not show this screen. Try again. If it keeps
            happening, reload {brand.appName} or sign out and sign back in.
          </Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={this.retry} style={[styles.button, styles.primary]}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
            {IS_WEB ? (
              <Pressable accessibilityRole="button" onPress={this.reload} style={styles.button}>
                <Text style={styles.secondaryText}>Reload {brand.appName}</Text>
              </Pressable>
            ) : null}
            {this.props.onSignOut ? (
              <Pressable accessibilityRole="button" onPress={this.signOut} style={styles.button}>
                <Text style={styles.secondaryText}>Sign out</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  brand: { ...typography.label, color: colors.accentTealStrong, letterSpacing: 1 },
  title: { ...typography.sectionTitle, color: colors.textPrimary },
  body: { ...typography.caption, color: colors.textSecondary },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  button: {
    minHeight: control.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    paddingHorizontal: spacing.lg,
  },
  primary: { backgroundColor: colors.primaryNavy, borderColor: colors.primaryNavy },
  primaryText: { ...typography.label, color: colors.textOnBrand },
  secondaryText: { ...typography.label, color: colors.textPrimary },
});
