import type { PatrolHold, PatrolPolicies, PatrolRoute, PatrolSitePolicy } from '../../types/patrols';
import type { PatrolPermissions } from './patrolAccess';
import type { PatrolLayout } from './patrolPresentation';

/** What every Patrol Management tab shares. All of it belongs to ONE company (companyKey) and is dropped on a change. */
export type PatrolPageContext = {
  companyKey: string;
  companyName: string | null;
  permissions: PatrolPermissions;
  layout: PatrolLayout;
  /** The page's site filter (null: all sites). */
  siteId: number | null;
  /** This company's sites, from GET /patrols/policies (company-scoped by the server), with their time zones. */
  sites: PatrolSitePolicy[];
  policies: PatrolPolicies | null;
  siteName: (siteId: number | null | undefined) => string;
  siteZone: (siteId: number | null | undefined) => string;
  routes: PatrolRoute[];
  /** Active holds — null when this person cannot read holds (patrols.holds), which means "unknown", never "none". */
  holds: PatrolHold[] | null;
  reloadPolicies: () => void;
  reloadRoutes: () => void;
  reloadHolds: () => void;
  openRun: (runId: number) => void;
  openException: (exceptionId: number) => void;
};

/** A one-shot request to open a patrol record (from a Live Operations alert or the dashboard card). */
export type PatrolNavTarget =
  | { requestId: number; kind: 'run'; runId: number }
  | { requestId: number; kind: 'exception'; exceptionId: number }
  | { requestId: number; kind: 'tab'; tab: 'overview' | 'live' };

export const DEFAULT_SITE_ZONE = 'Europe/London';
