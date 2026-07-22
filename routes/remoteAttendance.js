const express = require('express');
const router = express.Router();
const remoteAttendance = require('../services/remoteAttendance');

// ── CORS (consistent with routes/attendance.js, routes/missingPoints.js) ──
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

// ══════════════════════════════════════════════════════════════
// HTML HELPERS
// ══════════════════════════════════════════════════════════════

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function page(title, body) {
    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 560px; margin: 40px auto; padding: 0 16px; color: #1f2937; }
  h1 { font-size: 20px; }
  button { margin-top: 20px; padding: 10px 18px; font-size: 15px; border: none; border-radius: 4px; cursor: pointer; }
  .submit { background: #2563eb; color: white; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 16px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function invalidLinkPage() {
    return page('Lien invalide', '<h1>Ce lien n\'est plus valide</h1><p>Il a peut-être déjà été utilisé ou a expiré.</p>');
}

function alreadyConfirmedPage(recordedTime) {
    return page('Déjà confirmé', `<h1>Déjà confirmé</h1><p>Ce pointage a déjà été enregistré à <strong>${escapeHtml(recordedTime || '')}</strong>.</p>`);
}

// ══════════════════════════════════════════════════════════════
// PUBLIC PUNCH CONFIRMATION
// GET shows a page with a single button; the actual recording only
// happens on POST. This is deliberate: email link scanners (e.g.
// Microsoft Defender Safe Links, common on the Outlook relay this app
// already sends through) auto-fetch every link in an email with a GET
// request. If GET itself recorded the punch, employees could be marked
// "arrived" before ever opening the email.
// ══════════════════════════════════════════════════════════════

router.get('/remote-attendance/punch/:token', async (req, res) => {
    try {
        const row = await remoteAttendance.getPunchByToken(req.params.token);
        if (!row) return res.status(404).send(invalidLinkPage());
        if (row.used_at) return res.send(alreadyConfirmedPage(row.recorded_time));

        const workDate = row.work_date instanceof Date ? row.work_date.toISOString().split('T')[0] : String(row.work_date).split('T')[0];
        const isArrival = row.punch_type === 'arrival';
        const token = encodeURIComponent(req.params.token);

        res.send(page('Confirmation télétravail', `
            <h1>${isArrival ? 'Confirmer votre arrivée' : 'Confirmer votre départ'} — ${escapeHtml(workDate)}</h1>
            <p>Bonjour ${escapeHtml(row.full_name)}, cliquez sur le bouton ci-dessous pour enregistrer ${isArrival ? "votre heure d'arrivée" : "votre heure de départ"} maintenant.</p>
            <form method="POST" action="/remote-attendance/punch/${token}">
                <button class="submit" type="submit">${isArrival ? 'Confirmer mon arrivée' : 'Confirmer mon départ'}</button>
            </form>
        `));
    } catch (error) {
        console.error('❌ GET /remote-attendance/punch error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

router.post('/remote-attendance/punch/:token', async (req, res) => {
    try {
        const result = await remoteAttendance.confirmPunch(req.params.token);
        if (!result.ok) {
            if (result.error === 'already_used') return res.send(alreadyConfirmedPage(result.row.recorded_time));
            return res.status(400).send(invalidLinkPage());
        }

        const isArrival = result.row.punch_type === 'arrival';
        res.send(page('Merci', `
            <h1>Merci !</h1>
            <p>${isArrival ? 'Votre arrivée' : 'Votre départ'} a été enregistré${isArrival ? 'e' : ''} à <strong>${escapeHtml(result.recordedTime)}</strong>.</p>
        `));
    } catch (error) {
        console.error('❌ POST /remote-attendance/punch error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

// ══════════════════════════════════════════════════════════════
// ADMIN — REMOTE WORK DAYS (no auth — matches user's explicit choice to
// keep this endpoint key-free; unlike /api/missing-points and
// /api/leave-balance, nothing here requires an x-automation-key header)
// ══════════════════════════════════════════════════════════════

router.get('/api/remote-days', async (req, res) => {
    try {
        const days = await remoteAttendance.listRemoteWorkDays();
        res.json({ success: true, days });
    } catch (error) {
        console.error('❌ GET /api/remote-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/remote-days', async (req, res) => {
    try {
        const { date, label } = req.body || {};
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }
        const day = await remoteAttendance.addRemoteWorkDay(date, label);
        res.json({ success: true, day });
    } catch (error) {
        console.error('❌ POST /api/remote-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.delete('/api/remote-days/:date', async (req, res) => {
    try {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(req.params.date))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }
        const deleted = await remoteAttendance.removeRemoteWorkDay(req.params.date);
        res.json({ success: true, deleted });
    } catch (error) {
        console.error('❌ DELETE /api/remote-days error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// MANUAL / TESTABLE TRIGGER — POST /api/remote-attendance/send
// ══════════════════════════════════════════════════════════════

router.post('/api/remote-attendance/send', async (req, res) => {
    try {
        const { date, type, dryRun, testEmail } = req.body || {};
        if (!['arrival', 'departure'].includes(type)) {
            return res.status(400).json({ success: false, error: "type must be 'arrival' or 'departure'" });
        }

        // Test mode: creates one fully synthetic punch using only the given
        // email (never real employee/HR data), so the whole loop can be
        // exercised safely from a single inbox. Ignores date/dryRun.
        if (testEmail) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(testEmail))) {
                return res.status(400).json({ success: false, error: 'testEmail must be a valid email address' });
            }
            const result = await remoteAttendance.createSyntheticTestPunch(testEmail, type);
            return res.json({ success: true, ...result });
        }

        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }

        const result = await remoteAttendance.sendPunchLinksForDate(date || remoteAttendance.todayInTz(), type, { dryRun: !!dryRun });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('❌ POST /api/remote-attendance/send error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
