import * as React from 'react';
import { Platform, Text, View } from 'react-native';
import { colors } from '../../theme';
import { Button } from '../ui/Button';
import {
  CAMERA_CONSTRAINTS,
  cameraAvailability,
  cameraEnvironment,
  cameraProblemMessage,
  classifyCameraError,
  stopCameraStream,
  type CameraProblem,
} from './checkpointCamera';
import { isServerLabelPayload } from './patrolQr';
import { Notice, ui } from './patrolUi';

/** The browser's own <video> (web only). */
const HtmlVideo: any = 'video';

type Phase = 'idle' | 'starting' | 'scanning';

/**
 * "Scan with camera" for one checkpoint's test scan (S4 1.3.0 B2), web only. Nothing touches the camera until the button
 * is pressed: the press itself calls getUserMedia (rear camera preferred). While scanning, frames are decoded locally;
 * the first S4 checkpoint label read stops the camera and is handed to `onScanned` (the existing confirm call) — it is
 * never shown or logged. Cancel, success, a problem, unmount and a hidden tab all stop every track. Each problem is said
 * in plain English and leaves the manual input (handheld scanner / paste) in place.
 */
export function PatrolCheckpointCamera({ label, onScanned, disabled }: { label: string; onScanned: (payload: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [problem, setProblem] = React.useState<CameraProblem | null>(null);
  const [notLabel, setNotLabel] = React.useState(false);
  const stream = React.useRef<any>(null);
  const video = React.useRef<any>(null);
  const timers = React.useRef<{ loop: any; deadline: any }>({ loop: null, deadline: null });
  const session = React.useRef(0);
  const onScannedRef = React.useRef(onScanned);
  onScannedRef.current = onScanned;

  const stop = React.useCallback((next: CameraProblem | null = null) => {
    session.current += 1;
    clearTimeout(timers.current.loop);
    clearTimeout(timers.current.deadline);
    timers.current = { loop: null, deadline: null };
    stopCameraStream(stream.current);
    stream.current = null;
    if (video.current) { try { video.current.srcObject = null; } catch { /* detached */ } }
    setPhase('idle');
    setNotLabel(false);
    setProblem(next);
  }, []);

  // Unmount (the row closed, the site changed, the page left): the camera never stays on.
  React.useEffect(() => () => {
    session.current += 1;
    clearTimeout(timers.current.loop);
    clearTimeout(timers.current.deadline);
    stopCameraStream(stream.current);
    stream.current = null;
  }, []);

  // A hidden tab turns the camera off.
  React.useEffect(() => {
    if (phase === 'idle' || typeof document === 'undefined' || typeof (document as any).addEventListener !== 'function') return undefined;
    const onChange = () => { if ((document as any).visibilityState === 'hidden') stop('hidden'); };
    (document as any).addEventListener('visibilitychange', onChange);
    return () => (document as any).removeEventListener('visibilitychange', onChange);
  }, [phase, stop]);

  if (Platform.OS !== 'web' || !cameraEnvironment.createDecoder) return null;

  const start = () => {
    setProblem(null);
    setNotLabel(false);
    const unavailable = cameraAvailability();
    const decoder = unavailable ? null : cameraEnvironment.createDecoder();
    if (unavailable || !decoder) { setProblem(unavailable ?? 'unsupported'); return; }
    const mine = session.current + 1;
    session.current = mine;
    setPhase('starting');
    // getUserMedia is called here, in the press itself (browsers that require a user gesture are satisfied).
    let request: Promise<any>;
    try {
      request = cameraEnvironment.mediaDevices()!.getUserMedia(CAMERA_CONSTRAINTS);
    } catch (error) {
      setPhase('idle');
      setProblem(classifyCameraError(error));
      return;
    }
    request.then(async (media: any) => {
      if (session.current !== mine) { stopCameraStream(media); return; } // cancelled while the prompt was open
      stream.current = media;
      setPhase('scanning');
      const el = video.current;
      if (el) {
        try { el.srcObject = media; el.setAttribute?.('playsinline', 'true'); el.muted = true; await el.play?.(); } catch { /* autoplay may resolve later */ }
      }
      timers.current.deadline = setTimeout(() => { if (session.current === mine) stop('timeout'); }, cameraEnvironment.timeoutMs);
      const attempt = async () => {
        if (session.current !== mine) return;
        let text: string | null = null;
        try { text = await decoder.decode(video.current); } catch { text = null; }
        if (session.current !== mine) return;
        if (text && isServerLabelPayload(text)) {
          stop(null);
          onScannedRef.current(text);
          return;
        }
        if (text) setNotLabel(true);
        timers.current.loop = setTimeout(() => { void attempt(); }, cameraEnvironment.intervalMs);
      };
      void attempt();
    }).catch((error: unknown) => {
      if (session.current !== mine) return;
      stop(classifyCameraError(error));
    });
  };

  return (
    <View style={{ gap: 8 }}>
      {phase === 'idle' ? (
        <View style={ui.actions}>
          <Button label="Scan with camera" size="sm" variant="secondary" accessibilityLabel={`Scan ${label} with camera`} disabled={disabled} onPress={start} />
        </View>
      ) : null}
      {phase !== 'idle' ? (
        <View style={{ gap: 8 }} testID="checkpoint-camera">
          <View style={{ width: '100%', maxWidth: 420, aspectRatio: 4 / 3, backgroundColor: '#0B1F33', borderRadius: 8, overflow: 'hidden' } as any}>
            <HtmlVideo ref={video} muted playsInline autoPlay aria-label={`Camera view for ${label}`}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </View>
          <Text style={ui.rowMeta}>{phase === 'starting' ? 'Opening the camera… allow it if your browser asks.' : `Point the camera at the printed label for ${label}.`}</Text>
          {notLabel ? <Text style={[ui.rowMeta, { color: colors.warning }]}>That QR code is not an S4 checkpoint label. Scan the label printed for this checkpoint.</Text> : null}
          <View style={ui.actions}><Button label="Stop camera" size="sm" variant="tertiary" onPress={() => stop(null)} /></View>
        </View>
      ) : null}
      {problem ? <Notice tone="info" message={cameraProblemMessage(problem)} /> : null}
    </View>
  );
}
