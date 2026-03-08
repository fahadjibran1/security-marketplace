const defaultHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, defaultHeaders);
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  return json(res, 404, { error: 'Not found' });
}

function preflight(res) {
  res.writeHead(204, defaultHeaders);
  res.end();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const data = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

module.exports = { json, notFound, preflight, readJson };
