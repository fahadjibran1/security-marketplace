const _url = process.env.DATABASE_URL;
if (!_url) {
  throw new Error('DATABASE_URL environment variable is required — set it before running UAT scripts');
}
const _dbName = new URL(_url).pathname.replace(/^\//, '');
if (_dbName !== 'security_marketplace_staging') {
  throw new Error(`DATABASE_URL points to "${_dbName}", not "security_marketplace_staging" — non-staging DB rejected`);
}
module.exports = { DB_URL: _url };