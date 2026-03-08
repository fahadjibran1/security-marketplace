import {
  Assignment,
  AuthSession,
  CompanyProfile,
  GuardProfile,
  Job,
  JobApplication,
  Shift,
  Timesheet,
} from '../types/models';

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText} - ${body}`);
  }

  return response.json() as Promise<T>;
}

export function login(email: string, password: string) {
  return request<AuthSession>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function listCompanies() {
  return request<CompanyProfile[]>('/companies');
}

export function listGuards() {
  return request<GuardProfile[]>('/guards');
}

export function listJobs() {
  return request<Job[]>('/jobs');
}

export function listJobApplications() {
  return request<JobApplication[]>('/job-applications');
}

export function listAssignments() {
  return request<Assignment[]>('/assignments');
}

export function listShifts() {
  return request<Shift[]>('/shifts');
}

export function listTimesheets() {
  return request<Timesheet[]>('/timesheets');
}
