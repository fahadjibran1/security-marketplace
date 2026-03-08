const db = {
  users: [
    { id: 1, email: 'admin@sentinel.com', password: 'pass1234', role: 'company', companyId: 1 },
    { id: 2, email: 'guard1@example.com', password: 'pass1234', role: 'guard', guardId: 1 },
  ],
  companies: [
    {
      id: 1,
      name: 'Sentinel Protection Ltd',
      companyNumber: '09876543',
      address: '221B Baker Street, London',
      contactDetails: 'ops@sentinel.com | +44 20 1234 5678',
    },
  ],
  guards: [
    {
      id: 1,
      fullName: 'Alex Guard',
      siaLicenceNumber: 'SIA-1234567',
      phone: '+44 7700 900001',
      locationSharingEnabled: false,
      status: 'active',
    },
  ],

  // Company requirement (can require multiple guards)
  jobs: [
    {
      id: 1,
      companyId: 1,
      title: 'Retail Site Night Guard',
      description: 'Night security coverage for retail park',
      guardsRequired: 2,
      hourlyRate: 15.5,
      status: 'open',
    },
  ],

  // Guard's application to a specific job
  jobApplications: [
    { id: 1, jobId: 1, guardId: 1, status: 'submitted', appliedAt: '2026-03-07T12:00:00Z' },
  ],

  // Hiring outcome per guard (not job-completion)
  assignments: [
    {
      id: 1,
      jobId: 1,
      companyId: 1,
      guardId: 1,
      applicationId: 1,
      status: 'active',
      hiredAt: '2026-03-07T13:00:00Z',
    },
  ],

  // Operational schedule (separate from jobs)
  shifts: [
    {
      id: 1,
      assignmentId: 1,
      companyId: 1,
      guardId: 1,
      siteName: 'Retail Park A',
      start: '2026-03-08T20:00:00Z',
      end: '2026-03-09T06:00:00Z',
      status: 'scheduled',
    },
  ],

  // Payroll artifact (separate from shifts)
  timesheets: [
    {
      id: 1,
      shiftId: 1,
      guardId: 1,
      companyId: 1,
      hoursWorked: 0,
      approvalStatus: 'pending',
      createdAt: '2026-03-07T13:00:00Z',
    },
  ],

  attendance: [],
};

const counters = {
  users: db.users.length,
  companies: db.companies.length,
  guards: db.guards.length,
  jobs: db.jobs.length,
  jobApplications: db.jobApplications.length,
  assignments: db.assignments.length,
  shifts: db.shifts.length,
  timesheets: db.timesheets.length,
  attendance: db.attendance.length,
};

function nextId(key) {
  counters[key] += 1;
  return counters[key];
}

module.exports = { db, nextId };
