const cors = require('cors')({ origin: true });

// The Flutter app never sends browser preflight requests, but the Next.js
// admin panel does - wrap every onRequest handler so both work uniformly.
function withCors(handler) {
  return (req, res) => cors(req, res, () => handler(req, res));
}

module.exports = { withCors };
