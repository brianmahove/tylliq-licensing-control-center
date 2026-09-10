// Small, consistent JSON envelope for every licensing endpoint. Kept
// intentionally minimal (unlike a general-purpose app backend) since this
// service only ever talks to the Flutter client and the admin panel, both
// of which just need {success, ...} or {success:false, error:{code,message}}.

function ok(data = {}) {
  return { success: true, ...data };
}

function fail(code, message, extra = {}) {
  return { success: false, error: { code, message, ...extra } };
}

function sendJson(res, status, body) {
  res.status(status).set("content-type", "application/json").send(JSON.stringify(body));
}

module.exports = { ok, fail, sendJson };
