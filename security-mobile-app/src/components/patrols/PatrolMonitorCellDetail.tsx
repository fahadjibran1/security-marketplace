import * as React from 'react';
import { Text, View } from 'react-native';
import { colors, radii, spacing } from '../../theme';
import type { PatrolMonitorCell, PatrolMonitorHour, PatrolMonitorLane, PatrolMonitorSite, PatrolMonitorWindow } from '../../types/patrols';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import type { PatrolPageContext } from './patrolContext';
import { monitorCellWindows, monitorClock, monitorClockOnDay, monitorHourLabel, monitorLaneTitle, monitorShiftTimes, monitorStateInfo } from './patrolMonitorPresentation';
import { exceptionStatusLabel } from './patrolPresentation';
import { KeyValue, ui } from './patrolUi';
import { MonitorStateMark } from './PatrolMonitorMarks';

export type MonitorCellSelection = { lane: PatrolMonitorLane; cell: PatrolMonitorCell; hour: PatrolMonitorHour };

/**
 * One hour cell opened: each patrol window in it with its time, state, the Guard, QR checkpoint and photo COUNTS, and
 * the exception. Everything comes from the site read already on screen: nothing is fetched here, and no photo, link or
 * evidence record is read. Photos are opened only through the existing audited patrol record (ctx.openRun).
 */
export function PatrolMonitorCellDetail({ ctx, site, selection, onClose }: {
  ctx: PatrolPageContext;
  site: PatrolMonitorSite | null;
  selection: MonitorCellSelection | null;
  onClose: () => void;
}) {
  const zone = site?.timeZone ?? 'Europe/London';
  const day = site?.range.date ?? null;
  const lane = selection?.lane;
  const windows = selection && lane ? monitorCellWindows(lane, selection.cell) : [];
  const laneTitle = lane ? monitorLaneTitle(lane) : '';
  const hourText = selection ? `${monitorHourLabel(selection.hour)}:00 – ${monitorClock(selection.hour.end, zone)}` : '';
  return (
    <Drawer
      visible={Boolean(selection && site)}
      onClose={onClose}
      title={selection ? `${laneTitle} · ${hourText}` : 'Patrol'}
      subtitle={site ? `${site.siteName} · site time (${zone})` : undefined}
      width={ctx.layout.detailFullScreen ? 10_000 : 520}
    >
      <View style={{ gap: spacing.md }} testID="patrol-monitor-cell-detail">
        {lane && lane.kind === 'shift' ? <Text style={ui.muted}>Shift {monitorShiftTimes(lane, zone, day)}{lane.requirement?.summary ? ` · ${lane.requirement.summary}` : ''}</Text> : null}
        {lane && lane.kind === 'site' ? <Text style={ui.muted}>Site-wide patrol: any Guard on duty at the site can complete it.</Text> : null}
        {windows.length > 1 ? <Text style={ui.muted}>{selection!.cell.verified} of {windows.length} patrols in this hour verified.</Text> : null}
        {windows.map((w) => <MonitorWindowDetail key={w.key} ctx={ctx} site={site!} lane={lane!} window={w} onLeave={onClose} />)}
        {!windows.length ? <Text style={ui.muted}>No patrol window in this hour.</Text> : null}
      </View>
    </Drawer>
  );
}

function MonitorWindowDetail({ ctx, site, lane, window: w, onLeave }: { ctx: PatrolPageContext; site: PatrolMonitorSite; lane: PatrolMonitorLane; window: PatrolMonitorWindow; onLeave: () => void; key?: string }) {
  const zone = site.timeZone;
  const day = site.range.date;
  const info = monitorStateInfo(w.state);
  const run = w.runId != null ? site.runs[String(w.runId)] ?? null : null;
  const guard = run?.guardName
    ?? (run ? `Guard #${run.guardId}` : null)
    ?? (lane.kind === 'shift' ? monitorLaneTitle(lane) : null);
  const checkpoints = run?.checkpoints;
  const photos = run?.photos;
  const exception = w.exceptionId != null ? site.exceptions[String(w.exceptionId)] ?? null : null;
  const openLiveOps = w.alertId != null && ctx.openLiveOperationsAlert ? ctx.openLiveOperationsAlert : null;
  return (
    <View style={styles.window} testID={`patrol-monitor-window-${w.key}`}>
      <View style={styles.windowHead}>
        <Text style={ui.rowTitle}>{monitorClockOnDay(w.start, zone, day)} – {monitorClockOnDay(w.end, zone, day)}</Text>
        <MonitorStateMark state={w.state} />
      </View>
      <Text style={ui.rowMeta}>{info.description}</Text>
      <KeyValue label="Guard" value={guard ?? 'No patrol recorded'} />
      {run ? <KeyValue label="Started (received by S4)" value={monitorClockOnDay(run.startedAtServer, zone, day)} /> : null}
      {run ? <KeyValue label="Completed (received by S4)" value={run.completedAtServer ? monitorClockOnDay(run.completedAtServer, zone, day) : 'Not completed'} /> : null}
      {checkpoints ? (
        <KeyValue
          label="QR checkpoints"
          value={checkpoints.required == null
            ? `QR not required · ${checkpoints.scans} scan${checkpoints.scans === 1 ? '' : 's'}`
            : `${checkpoints.verified ?? 0} of ${checkpoints.required} verified · ${checkpoints.scans} scan${checkpoints.scans === 1 ? '' : 's'} · ${checkpoints.repeatScans} repeat · ${checkpoints.flaggedScans} flagged`}
        />
      ) : null}
      {checkpoints?.qrRuleMissing ? <Text style={[ui.rowMeta, { color: colors.warning }]}>QR is required but this site has no checkpoint route.</Text> : null}
      {photos ? <KeyValue label="Photos" value={`${photos.taken} taken · ${photos.verified} verified · ${photos.missing} missing`} /> : null}
      {exception || w.exceptionStatus ? <KeyValue label="Exception" value={exceptionStatusLabel(exception?.status ?? w.exceptionStatus)} /> : null}
      <View style={ui.actions}>
        {w.runId != null ? (
          <Button
            label={ctx.permissions.canViewEvidence ? 'Open patrol record and photos' : 'Open patrol record'}
            variant="secondary"
            size="sm"
            onPress={() => { onLeave(); ctx.openRun(w.runId as number); }}
          />
        ) : null}
        {w.exceptionId != null ? <Button label="Open exception" variant="tertiary" size="sm" onPress={() => { onLeave(); ctx.openException(w.exceptionId as number); }} /> : null}
        {openLiveOps ? <Button label="Open in Live Operations" variant="tertiary" size="sm" onPress={() => { onLeave(); openLiveOps({ alertId: w.alertId as number, shiftId: lane.shiftId }); }} /> : null}
      </View>
    </View>
  );
}

const styles = {
  window: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, padding: spacing.md, gap: spacing.xs, backgroundColor: colors.card },
  windowHead: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: spacing.sm, flexWrap: 'wrap' as const },
};
