const http = require('http');
const { db, nextId } = require('./data/store');
const { json, notFound, preflight, readJson } = require('./modules/http');
const { login, register } = require('./modules/auth');

function list(collection) {
  return (_req, res) => json(res, 200, db[collection]);
}

function create(collection, requiredFields = []) {
  return async (req, res) => {
    const payload = await readJson(req);
    if (!payload) return json(res, 400, { error: 'Invalid JSON body' });

    const missing = requiredFields.filter((f) => payload[f] === undefined || payload[f] === '');
    if (missing.length) return json(res, 400, { error: `Missing fields: ${missing.join(', ')}` });

    const item = { id: nextId(collection), ...payload };
    db[collection].push(item);
    return json(res, 201, item);
  };
}

function parsePath(req) {
  return (req.url || '/').split('?')[0];
}

function getJobById(jobId) {
  return db.jobs.find((j) => j.id === Number(jobId));
}

function getGuardById(guardId) {
  return db.guards.find((g) => g.id === Number(guardId));
}

async function createJobApplication(req, res) {
  const payload = await readJson(req);
  if (!payload) return json(res, 400, { error: 'Invalid JSON body' });
  if (!payload.jobId || !payload.guardId) return json(res, 400, { error: 'jobId and guardId are required' });

  const job = getJobById(payload.jobId);
  if (!job) return json(res, 404, { error: 'Job not found' });
  const guard = getGuardById(payload.guardId);
  if (!guard) return json(res, 404, { error: 'Guard not found' });

  const existing = db.jobApplications.find(
    (a) => a.jobId === Number(payload.jobId) && a.guardId === Number(payload.guardId) && a.status !== 'withdrawn',
  );
  if (existing) return json(res, 409, { error: 'Application already exists for this guard and job' });

  const application = {
    id: nextId('jobApplications'),
    jobId: Number(payload.jobId),
    guardId: Number(payload.guardId),
    status: 'submitted',
    appliedAt: new Date().toISOString(),
  };

  db.jobApplications.push(application);
  return json(res, 201, application);
}

async function hireApplication(req, res, applicationId) {
  const payload = await readJson(req);
  if (!payload) return json(res, 400, { error: 'Invalid JSON body' });

  const application = db.jobApplications.find((a) => a.id === Number(applicationId));
  if (!application) return json(res, 404, { error: 'Application not found' });
  if (application.status === 'hired') return json(res, 409, { error: 'Application already hired' });

  const job = getJobById(application.jobId);
  if (!job) return json(res, 404, { error: 'Job not found' });

  const activeAssignmentsForJob = db.assignments.filter((a) => a.jobId === job.id && a.status === 'active').length;
  if (activeAssignmentsForJob >= Number(job.guardsRequired)) {
    return json(res, 409, { error: 'Job guard capacity reached' });
  }

  const assignment = {
    id: nextId('assignments'),
    jobId: job.id,
    companyId: job.companyId,
    guardId: application.guardId,
    applicationId: application.id,
    status: 'active',
    hiredAt: new Date().toISOString(),
  };
  db.assignments.push(assignment);

  application.status = 'hired';
  application.hiredAt = assignment.hiredAt;

  // optional scheduling at hire time
  let shift = null;
  let timesheet = null;

  if (payload.createShift) {
    if (!payload.siteName || !payload.start || !payload.end) {
      return json(res, 400, { error: 'siteName, start, and end are required when createShift=true' });
    }

    shift = {
      id: nextId('shifts'),
      assignmentId: assignment.id,
      companyId: assignment.companyId,
      guardId: assignment.guardId,
      siteName: payload.siteName,
      start: payload.start,
      end: payload.end,
      status: 'scheduled',
    };
    db.shifts.push(shift);

    timesheet = {
      id: nextId('timesheets'),
      shiftId: shift.id,
      guardId: shift.guardId,
      companyId: shift.companyId,
      hoursWorked: 0,
      approvalStatus: 'pending',
      createdAt: new Date().toISOString(),
    };
    db.timesheets.push(timesheet);
  }

  return json(res, 201, {
    application,
    assignment,
    shift,
    timesheet,
  });
}

async function createShift(req, res) {
  const payload = await readJson(req);
  if (!payload) return json(res, 400, { error: 'Invalid JSON body' });

  const required = ['assignmentId', 'siteName', 'start', 'end'];
  const missing = required.filter((f) => payload[f] === undefined || payload[f] === '');
  if (missing.length) return json(res, 400, { error: `Missing fields: ${missing.join(', ')}` });

  const assignment = db.assignments.find((a) => a.id === Number(payload.assignmentId));
  if (!assignment) return json(res, 404, { error: 'Assignment not found' });

  const shift = {
    id: nextId('shifts'),
    assignmentId: assignment.id,
    companyId: assignment.companyId,
    guardId: assignment.guardId,
    siteName: payload.siteName,
    start: payload.start,
    end: payload.end,
    status: payload.status || 'scheduled',
  };
  db.shifts.push(shift);

  const timesheet = {
    id: nextId('timesheets'),
    shiftId: shift.id,
    guardId: shift.guardId,
    companyId: shift.companyId,
    hoursWorked: 0,
    approvalStatus: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.timesheets.push(timesheet);

  return json(res, 201, { shift, timesheet });
}

async function attendanceCheck(req, res, type) {
  const payload = await readJson(req);
  if (!payload) return json(res, 400, { error: 'Invalid JSON body' });
  if (!payload.guardId || !payload.shiftId) return json(res, 400, { error: 'guardId and shiftId are required' });

  const shift = db.shifts.find((s) => s.id === Number(payload.shiftId));
  if (!shift) return json(res, 404, { error: 'Shift not found' });

  const event = {
    id: nextId('attendance'),
    guardId: Number(payload.guardId),
    shiftId: Number(payload.shiftId),
    type,
    timestamp: new Date().toISOString(),
    nfcTag: payload.nfcTag || null,
  };
  db.attendance.push(event);

  if (type === 'check-out') {
    const timesheet = db.timesheets.find((t) => t.shiftId === Number(payload.shiftId));
    if (timesheet && payload.hoursWorked !== undefined) {
      timesheet.hoursWorked = Number(payload.hoursWorked);
    }
  }

  return json(res, 201, event);
}

const routes = {
  'GET /health': (_req, res) => json(res, 200, { ok: true, service: 'security-mobile-backend' }),

  'POST /auth/login': async (req, res) => {
    const payload = await readJson(req);
    if (!payload) return json(res, 400, { error: 'Invalid JSON body' });
    const result = login(payload.email, payload.password);
    if (!result) return json(res, 401, { error: 'Invalid credentials' });
    return json(res, 200, result);
  },

  'POST /auth/register': async (req, res) => {
    const payload = await readJson(req);
    if (!payload) return json(res, 400, { error: 'Invalid JSON body' });
    const result = register(payload);
    if (result.error) return json(res, 400, result);
    return json(res, 201, result);
  },

  'GET /companies': list('companies'),
  'POST /companies': create('companies', ['name', 'companyNumber', 'address', 'contactDetails']),

  'GET /guards': list('guards'),
  'POST /guards': create('guards', ['fullName', 'siaLicenceNumber', 'phone']),

  // Job = requirement, not assignment/shift
  'GET /jobs': list('jobs'),
  'POST /jobs': create('jobs', ['companyId', 'title', 'guardsRequired', 'hourlyRate', 'status']),

  // JobApplication = candidate interest in a job
  'GET /job-applications': list('jobApplications'),
  'GET /applications': list('jobApplications'), // backward-compatible alias
  'POST /job-applications': createJobApplication,
  'POST /applications': createJobApplication,

  // Assignment = hired guard against a job
  'GET /assignments': list('assignments'),

  // Shift = schedule linked to assignment
  'GET /shifts': list('shifts'),
  'POST /shifts': createShift,

  // Timesheet = payroll entity linked to shift
  'GET /timesheets': list('timesheets'),

  'GET /attendance': list('attendance'),
  'POST /attendance/check-in': (req, res) => attendanceCheck(req, res, 'check-in'),
  'POST /attendance/check-out': (req, res) => attendanceCheck(req, res, 'check-out'),
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return preflight(res);

  const path = parsePath(req);

  // Dynamic route: hire application => create assignment (+optional shift+timesheet)
  const hireMatch = path.match(/^\/job-applications\/(\d+)\/hire$/);
  if (req.method === 'POST' && hireMatch) {
    return hireApplication(req, res, hireMatch[1]);
  }

  const key = `${req.method} ${path}`;
  const handler = routes[key];
  if (!handler) return notFound(res);
  return handler(req, res);
});

const port = Number(process.env.PORT || 4000);
server.listen(port, () => {
  console.log(`Security backend running on http://localhost:${port}`);
});
