import { Job } from '../entities/job.entity';
import { JobApplication } from '../../job-application/entities/job-application.entity';

/**
 * SEC-PUBLIC-01: what a Guard may see of a job when discovering and applying for it.
 *
 * Built field by field from an allow-list, never by copying the entity, so a column or relation added to Job, Company,
 * Site or Client later can never reach a Guard by accident. In particular it never carries:
 *   - the company owner's account (Company.user: email, phone, last login, deletion fields),
 *   - the company's registration number, address or contact details,
 *   - the site's address, coordinates, geofence, check-in settings, special instructions or its client,
 *   - the client's contact name, email or phone,
 *   - the billing rate (what the company charges its client).
 *
 * Kept: what the Guard app reads to list a job and apply (JobsScreen): title, description, guards required, the Guard's
 * pay (hourlyRate), status and times, plus the company and site names it shows as the location line.
 */
export interface GuardJobView {
  id: number;
  title: string;
  description: string | null;
  guardsRequired: number;
  hourlyRate: number;
  status: string;
  startAt: Date | null;
  endAt: Date | null;
  company: { id: number; name: string } | null;
  site: { id: number; name: string } | null;
}

export function toGuardJobView(job: Job): GuardJobView {
  return {
    id: job.id,
    title: job.title,
    description: job.description ?? null,
    guardsRequired: job.guardsRequired,
    hourlyRate: job.hourlyRate,
    status: job.status,
    startAt: job.startAt ?? null,
    endAt: job.endAt ?? null,
    company: job.company ? { id: job.company.id, name: job.company.name } : null,
    site: job.site ? { id: job.site.id, name: job.site.name } : null,
  };
}

/** A Guard's own application, with the job reduced to its Guard view (GET/POST /job-applications as a Guard). */
export interface GuardJobApplicationView {
  id: number;
  jobId: number | null;
  status: string;
  appliedAt: Date;
  hiredAt: Date | null;
  job: GuardJobView | null;
}

export function toGuardJobApplicationView(application: JobApplication): GuardJobApplicationView {
  return {
    id: application.id,
    jobId: application.job?.id ?? null,
    status: application.status,
    appliedAt: application.appliedAt,
    hiredAt: application.hiredAt ?? null,
    job: application.job ? toGuardJobView(application.job) : null,
  };
}
