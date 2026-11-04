import * as React from 'react';
import { Image, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { colors, radii, spacing, typography } from '../../theme';
import { Button } from '../ui/Button';

const IS_WEB = typeof document !== 'undefined';

/**
 * One patrol photo — original (a short-lived link) or stamped (made on request) — with Full screen and Fit / 100%
 * (S4 Patrol Monitor usability, owner-approved 4 Nov 2026).
 *
 * NO EXTRA REQUEST. Normal and full-screen are two layouts of ONE modal around ONE image element: entering full screen,
 * switching Fit / 100% or leaving it re-styles that element and never asks the server, the storage or the browser for
 * the photo again. 100% uses the size the image reported when it first loaded. The caller still owns the photo: when a
 * short-lived link expires (or the caller drops the photo for any other reason) `uri` goes and the viewer closes, in
 * full screen too. No download, save or export control is added.
 */
export function PatrolPhotoViewer({ uri, title, subtitle, accessibilityLabel, onClose }: {
  uri: string | null;
  title: string;
  subtitle: string;
  accessibilityLabel: string;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [full, setFull] = React.useState(false);
  const [zoom, setZoom] = React.useState<'fit' | 'actual'>('fit');
  const [natural, setNatural] = React.useState<{ width: number; height: number } | null>(null);
  const visible = Boolean(uri);
  const imageRef = React.useRef<any>(null);
  React.useEffect(() => { if (!visible) { setFull(false); setZoom('fit'); setNatural(null); } }, [visible]);

  // Escape leaves full screen first, then closes the viewer (web).
  const escRef = React.useRef<() => void>(() => undefined);
  escRef.current = () => { if (full) setFull(false); else onClose(); };
  React.useEffect(() => {
    if (!visible || !IS_WEB || typeof (document as any).addEventListener !== 'function') return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault?.(); escRef.current(); } };
    (document as any).addEventListener('keydown', onKey);
    return () => (document as any).removeEventListener('keydown', onKey);
  }, [visible]);

  const phone = width < 768;
  const frame = full
    ? { width, height: Math.max(200, height - 64) }
    : { width: Math.min(phone ? width - 32 : 960, width - 32), height: phone ? 380 : 460 };
  const actual = zoom === 'actual' && natural;
  const imageStyle = actual
    ? { width: natural!.width, height: natural!.height }
    : { width: full ? frame.width : frame.width - 2 * spacing.lg, height: full ? frame.height : frame.height };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => escRef.current()}>
      <View style={[styles.backdrop, full ? { padding: 0 } : null]}>
        <View
          style={[styles.panel, full ? styles.panelFull : { width: frame.width }]}
          accessibilityViewIsModal
          testID={full ? 'patrol-photo-viewer-full' : 'patrol-photo-viewer'}
        >
          <View style={[styles.head, full ? styles.headFull : null]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.title, full ? { color: '#FFFFFF' } : null]} numberOfLines={1}>{title}</Text>
              {full ? null : <Text style={styles.subtitle}>{subtitle}</Text>}
            </View>
            {full ? (
              <View style={styles.zoom} accessibilityLabel="Zoom">
                {(['fit', 'actual'] as const).map((z) => (
                  <Pressable
                    key={z}
                    accessibilityRole="button"
                    accessibilityLabel={z === 'fit' ? 'Fit to screen' : 'Actual size (100%)'}
                    accessibilityState={{ selected: zoom === z, disabled: z === 'actual' && !natural }}
                    disabled={z === 'actual' && !natural}
                    onPress={() => setZoom(z)}
                    style={[styles.zoomChip, zoom === z ? styles.zoomChipOn : null]}
                  >
                    <Text style={[styles.zoomText, zoom === z ? { color: colors.primaryNavy } : null]}>{z === 'fit' ? 'Fit' : '100%'}</Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Button label="Full screen" accessibilityLabel="Full screen" variant="secondary" size="sm" onPress={() => setFull(true)} />
            )}
            <Button
              label={full ? 'Exit full screen' : 'Close'}
              accessibilityLabel={full ? 'Exit full screen' : 'Close photo'}
              variant={full ? 'secondary' : 'tertiary'}
              size="sm"
              onPress={() => (full ? setFull(false) : onClose())}
            />
          </View>
          {/* Scrolls both ways at 100% (pan); at Fit the whole photo shows. The same image element in every layout. */}
          <ScrollView style={{ maxHeight: frame.height }} contentContainerStyle={actual ? null : styles.center} testID="patrol-photo-viewer-scroll">
            <ScrollView horizontal contentContainerStyle={actual ? null : styles.center}>
              {uri ? (
                <Image
                  ref={imageRef}
                  accessibilityLabel={accessibilityLabel}
                  source={{ uri, cache: 'reload' } as any}
                  onLoad={(e: any) => {
                    // The loaded photo's own size, never by loading it again: native reports nativeEvent.source; on the
                    // web react-native-web keeps the loaded photo in a hidden <img> inside the element.
                    const n = e?.nativeEvent ?? {};
                    const hidden = imageRef.current?.querySelector?.('img');
                    const w = Number(n.source?.width ?? n.target?.naturalWidth ?? hidden?.naturalWidth ?? 0);
                    const h = Number(n.source?.height ?? n.target?.naturalHeight ?? hidden?.naturalHeight ?? 0);
                    if (w > 0 && h > 0 && !natural) setNatural({ width: w, height: h });
                  }}
                  style={[imageStyle, { resizeMode: actual ? 'stretch' : 'contain', backgroundColor: '#0B1F33' }] as any}
                  testID="patrol-photo-viewer-image"
                />
              ) : null}
            </ScrollView>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = {
  backdrop: { flex: 1, backgroundColor: 'rgba(11,31,51,0.72)', alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.md },
  panel: { backgroundColor: colors.card, borderRadius: radii.card, overflow: 'hidden' as const, maxHeight: '100%' as any },
  panelFull: { width: '100%' as any, height: '100%' as any, borderRadius: 0, backgroundColor: '#0B1F33' },
  head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.sm, padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, flexWrap: 'wrap' as const },
  headFull: { backgroundColor: '#0B1F33', borderBottomColor: '#1E3A5F', minHeight: 64 },
  title: { ...typography.panelHeading, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary },
  center: { flexGrow: 1, alignItems: 'center' as const, justifyContent: 'center' as const },
  zoom: { flexDirection: 'row' as const, gap: spacing.xs },
  zoomChip: { borderWidth: 1, borderColor: '#9CB3C9', borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 6, minHeight: 36, justifyContent: 'center' as const },
  zoomChipOn: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  zoomText: { ...typography.caption, fontWeight: '700' as const, color: '#FFFFFF' },
};
