// Runs the Guard's patrol outbox on the phone (Patrols P1-E): one engine per signed-in Guard, woken when the app comes
// to the foreground, after every patrol action, and by a timer at the next retry time (the backoff is capped at two
// minutes, so a regained connection is used within that time without a background task or a network listener).
//
// Signing out unmounts the Guard screen, which stops the timers and the foreground trigger; the queue itself stays in
// SQLite untouched (sign-out never clears it) and only the same Guard's next session runs it again — another user gets
// their own engine and never this one's rows. Welfare Checks share nothing with this module (no state, timers or
// completion).

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  completeGuardPatrolEvidence,
  completeGuardPatrolRun,
  recordGuardPatrolVisit,
  requestGuardPatrolEvidenceUpload,
  startGuardPatrolRun,
} from './api';
import { PatrolOutboxEngine, type OutboxItem, type SyncReport } from '../components/guard/patrol/patrolOutbox';
import { evidenceFilesFor, patrolOutboxStore, putEvidenceObject } from './patrolNative';

const engines = new Map<number, PatrolOutboxEngine>();

export function patrolEngineFor(ownerUserId: number): PatrolOutboxEngine {
  let engine = engines.get(ownerUserId);
  if (!engine) {
    // Only one Guard is ever signed in: an engine for anyone else is dropped (their rows stay in SQLite).
    engines.clear();
    engine = new PatrolOutboxEngine({
      ownerUserId,
      store: patrolOutboxStore(),
      files: evidenceFilesFor(ownerUserId),
      transport: {
        startRun: startGuardPatrolRun,
        recordVisit: recordGuardPatrolVisit,
        completeRun: completeGuardPatrolRun,
        requestUpload: requestGuardPatrolEvidenceUpload,
        putObject: putEvidenceObject,
        completeUpload: completeGuardPatrolEvidence,
      },
    });
    engines.set(ownerUserId, engine);
  }
  return engine;
}

export type PatrolOutboxState = {
  engine: PatrolOutboxEngine | null;
  items: OutboxItem[];
  report: SyncReport | null;
  /** Ask for a sync now (after an action, or the Guard's "Send now"). */
  kick: () => void;
};

export function usePatrolOutbox(ownerUserId: number | null | undefined): PatrolOutboxState {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [report, setReport] = useState<SyncReport | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engine = ownerUserId ? patrolEngineFor(ownerUserId) : null;
  const kickRef = useRef<(eager?: boolean) => void>(() => undefined);

  useEffect(() => {
    if (!engine) return;
    // This hook mounts only inside a signed-in Guard session, so a pause for an expired session is over.
    engine.resumeAfterSignIn();
    let live = true;
    const refresh = () => { engine.items().then((rows) => { if (live) setItems(rows); }).catch(() => undefined); };
    const arm = async () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const at = await engine.nextWakeAt();
      if (!live || !at) return;
      timer.current = setTimeout(() => kickRef.current(false), Math.max(1_000, at.getTime() - Date.now()));
    };
    kickRef.current = (eager = true) => {
      engine.sync({ eager })
        .then((r) => { if (live) setReport(r); })
        .catch(() => undefined)
        .finally(() => { refresh(); void arm(); });
    };
    const unsubscribe = engine.subscribe(refresh);
    refresh();
    kickRef.current();
    const sub = AppState.addEventListener('change', (state: string) => { if (state === 'active') kickRef.current(); });
    return () => {
      live = false;
      unsubscribe();
      sub.remove();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [engine]);

  return { engine, items, report, kick: () => kickRef.current() };
}
