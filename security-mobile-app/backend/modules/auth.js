const { db, nextId } = require('../data/store');

function login(email, password) {
  const user = db.users.find((u) => u.email === email && u.password === password);
  if (!user) return null;
  return {
    token: `mock-token-${user.id}-${Date.now()}`,
    user: { id: user.id, email: user.email, role: user.role, companyId: user.companyId, guardId: user.guardId },
  };
}

function register(payload) {
  const { email, password, role } = payload;
  if (!email || !password || !role) return { error: 'email, password, and role are required' };
  if (db.users.some((u) => u.email === email)) return { error: 'email already exists' };

  const user = { id: nextId('users'), email, password, role };

  if (role === 'company') {
    const company = {
      id: nextId('companies'),
      name: payload.companyName || 'New Company',
      companyNumber: payload.companyNumber || '',
      address: payload.address || '',
      contactDetails: payload.contactDetails || '',
    };
    db.companies.push(company);
    user.companyId = company.id;
  }

  if (role === 'guard') {
    const guard = {
      id: nextId('guards'),
      fullName: payload.fullName || 'New Guard',
      siaLicenceNumber: payload.siaLicenceNumber || '',
      phone: payload.phone || '',
      locationSharingEnabled: Boolean(payload.locationSharingEnabled),
      status: 'pending',
    };
    db.guards.push(guard);
    user.guardId = guard.id;
  }

  db.users.push(user);
  return { user };
}

module.exports = { login, register };
