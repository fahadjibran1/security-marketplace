export type AppRole = 'company' | 'guard';

export interface AuthUser {
  id: number;
  email: string;
  role: AppRole;
  companyId?: number;
  guardId?: number;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

export interface CompanyProfile {
  id: number;
  name: string;
  companyNumber: string;
  address: string;
  contactDetails: string;
}

export interface GuardProfile {
  id: number;
  fullName: string;
  siaLicenceNumber: string;
  phone: string;
  locationSharingEnabled: boolean;
  status: string;
}

// Job = company requirement
export interface Job {
  id: number;
  companyId: number;
  title: string;
  description?: string;
  guardsRequired: number;
  hourlyRate: number;
  status: string;
}

// JobApplication = guard applying to a job
export interface JobApplication {
  id: number;
  jobId: number;
  guardId: number;
  status: string;
  appliedAt: string;
  hiredAt?: string;
}

// Assignment = hired guard linked to job
export interface Assignment {
  id: number;
  jobId: number;
  companyId: number;
  guardId: number;
  applicationId: number;
  status: string;
  hiredAt: string;
}

// Shift = planned work linked to assignment
export interface Shift {
  id: number;
  assignmentId: number;
  companyId: number;
  guardId: number;
  siteName: string;
  start: string;
  end: string;
  status: string;
}

// Timesheet = payroll record linked to shift
export interface Timesheet {
  id: number;
  shiftId: number;
  guardId: number;
  companyId: number;
  hoursWorked: number;
  approvalStatus: string;
  createdAt: string;
}
