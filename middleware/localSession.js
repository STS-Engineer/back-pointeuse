const jwt = require('jsonwebtoken');

function extractBearerToken(req) {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

// Verifies our own self-pointage session token (issued by POST
// /api/self-pointage/login) and sets req.matricule. Scoped to only the
// /api/self-pointage/me and /punch routes — every other endpoint in this
// API stays intentionally unauthenticated (see .env.example).
function createVerifyLocalSession({ secret = process.env.SELF_POINTAGE_JWT_SECRET } = {}) {
    return function verifyLocalSession(req, res, next) {
        if (!secret) {
            return res.status(500).json({ success: false, error: 'SELF_POINTAGE_JWT_SECRET not configured' });
        }

        const token = extractBearerToken(req);
        if (!token) {
            return res.status(401).json({ success: false, error: 'Missing bearer token' });
        }

        try {
            const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
            if (!payload.sub) {
                return res.status(401).json({ success: false, error: 'Token has no subject' });
            }
            req.matricule = payload.sub;
            next();
        } catch (err) {
            return res.status(401).json({ success: false, error: `Invalid token: ${err.message}` });
        }
    };
}

module.exports = { createVerifyLocalSession, verifyLocalSession: createVerifyLocalSession() };
