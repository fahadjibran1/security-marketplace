import * as React from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { colors, radii, spacing, typography } from '../../../theme';
import { cameraAccess } from './patrolCamera';

/**
 * S4's own patrol camera (Patrols P1-E): QR checkpoint scanning (QR codes only) or one patrol photo. There is no way to
 * pick an existing image — no gallery, no photo library, no "scan from image": a patrol photo can only be taken here.
 * The photo is captured without EXIF (exif: false) and is then re-encoded and cleaned by patrolImage.ts.
 */
export function GuardPatrolCamera({
  visible,
  mode,
  title,
  onClose,
  onScanned,
  onCaptured,
}: {
  visible: boolean;
  mode: 'scan' | 'photo';
  title: string;
  onClose: () => void;
  onScanned?: (data: string) => void;
  onCaptured?: (capture: { uri: string; width: number; height: number }) => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const camera = React.useRef<CameraView | null>(null);
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (!visible) return;
    handled.current = false;
    setProblem(null);
    setAvailable(null);
    CameraView.isAvailableAsync().then(setAvailable).catch(() => setAvailable(true));
  }, [visible]);

  const access = cameraAccess(permission ? { granted: permission.granted, canAskAgain: permission.canAskAgain, status: permission.status } : null, available);

  async function takePhoto() {
    if (!camera.current || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 0.9, exif: false, base64: false, skipProcessing: false });
      if (!picture?.uri) throw new Error('no picture');
      onCaptured?.({ uri: picture.uri, width: picture.width, height: picture.height });
    } catch {
      setProblem('The camera could not take a photo. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close camera" onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        {access.kind === 'ready' ? (
          <View style={styles.cameraHost}>
            <CameraView
              ref={camera}
              style={styles.camera}
              facing="back"
              mode="picture"
              animateShutter={false}
              barcodeScannerSettings={mode === 'scan' ? { barcodeTypes: ['qr'] } : undefined}
              onBarcodeScanned={mode === 'scan' ? ({ data }: { data: string }) => {
                if (handled.current) return;
                handled.current = true;
                onScanned?.(data);
              } : undefined}
              onMountError={() => setAvailable(false)}
            />
            <View style={styles.footer}>
              {mode === 'scan' ? (
                <Text style={styles.hint}>Point the camera at the S4 checkpoint label.</Text>
              ) : (
                <Pressable accessibilityRole="button" accessibilityLabel="Take patrol photo" onPress={takePhoto} disabled={busy} style={[styles.shutter, busy ? styles.disabled : null]}>
                  <Text style={styles.shutterText}>{busy ? 'Saving…' : 'Take photo'}</Text>
                </Pressable>
              )}
              {problem ? <Text style={styles.problem}>{problem}</Text> : null}
            </View>
          </View>
        ) : (
          <View style={styles.panel}>
            <Text style={styles.panelTitle}>{access.title}</Text>
            {access.message ? <Text style={styles.panelText}>{access.message}</Text> : null}
            {access.action === 'request' ? (
              <Pressable accessibilityRole="button" onPress={() => { void requestPermission(); }} style={styles.action}>
                <Text style={styles.actionText}>Allow camera</Text>
              </Pressable>
            ) : null}
            {access.action === 'open_settings' ? (
              <Pressable accessibilityRole="button" onPress={() => { void Linking.openSettings(); }} style={styles.action}>
                <Text style={styles.actionText}>Open Settings</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primaryNavyStrong },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingTop: spacing.xxl, paddingBottom: spacing.md },
  title: { color: colors.textOnBrand, ...typography.heading, flex: 1 },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryNavySoft },
  closeText: { color: colors.textOnBrand, ...typography.label },
  cameraHost: { flex: 1 },
  camera: { flex: 1 },
  footer: { padding: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  hint: { color: colors.textOnBrand, ...typography.body, textAlign: 'center' },
  shutter: { minHeight: 56, minWidth: 200, borderRadius: radii.pill, backgroundColor: colors.accentTeal, alignItems: 'center', justifyContent: 'center' },
  shutterText: { color: colors.textOnBrand, ...typography.bodyStrong },
  disabled: { opacity: 0.6 },
  problem: { color: colors.dangerSurface, ...typography.caption, textAlign: 'center' },
  panel: { flex: 1, padding: spacing.xl, gap: spacing.md, justifyContent: 'center' },
  panelTitle: { color: colors.textOnBrand, ...typography.heading },
  panelText: { color: colors.border, ...typography.body },
  action: { alignSelf: 'flex-start', minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radii.md, backgroundColor: colors.accentTeal },
  actionText: { color: colors.textOnBrand, ...typography.label },
});
