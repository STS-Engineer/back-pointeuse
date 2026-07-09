const express = require('express');
const router = express.Router();
const missingPoints = require('../services/missingPoints');

// ── CORS (consistent with routes/attendance.js) ────────────────
router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
  label { display: block; margin-top: 16px; font-weight: 600; }
  input[type=time], textarea { width: 100%; padding: 8px; margin-top: 4px; box-sizing: border-box; font-size: 16px; }
  button { margin-top: 20px; padding: 10px 18px; font-size: 15px; border: none; border-radius: 4px; cursor: pointer; }
  .approve { background: #16a34a; color: white; }
  .reject { background: #dc2626; color: white; margin-left: 8px; }
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

// ══════════════════════════════════════════════════════════════
// EMPLOYEE CORRECTION FORM
// ══════════════════════════════════════════════════════════════

router.get('/missing-point/correct/:token', async (req, res) => {
    try {
        const row = await missingPoints.getRequestByEmployeeToken(req.params.token);
        if (!row) return res.status(404).send(invalidLinkPage());

        const workDate = row.work_date instanceof Date ? row.work_date.toISOString().split('T')[0] : String(row.work_date).split('T')[0];
        const needsArrival = row.missing_type === 'arrival' || row.missing_type === 'both';
        const needsDeparture = row.missing_type === 'departure' || row.missing_type === 'both';
        const reasonBlock = row.rejection_comment
            ? `<div class="card"><strong>Correction précédente refusée :</strong><p>${escapeHtml(row.rejection_comment)}</p></div>`
            : '';

        res.send(page('Pointage manquant', `
            <h1>Pointage manquant — ${escapeHtml(workDate)}</h1>
            <p>Bonjour ${escapeHtml(row.full_name)}, merci de renseigner l'heure manquante ci-dessous.</p>
            ${reasonBlock}
            <form method="POST" action="/missing-point/correct/${encodeURIComponent(req.params.token)}">
                ${needsArrival ? '<label>Heure d\'arrivée<input type="time" name="arrivalTime" required></label>' : ''}
                ${needsDeparture ? '<label>Heure de départ<input type="time" name="departureTime" required></label>' : ''}
                <label>Commentaire (optionnel)<textarea name="comment" rows="3"></textarea></label>
                <button class="submit" type="submit">Envoyer pour validation</button>
            </form>
        `));
    } catch (error) {
        console.error('❌ GET /missing-point/correct error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

router.post('/missing-point/correct/:token', async (req, res) => {
    try {
        const { arrivalTime, departureTime, comment } = req.body || {};
        const result = await missingPoints.submitEmployeeCorrection(req.params.token, { arrivalTime, departureTime, comment });
        if (!result.ok) return res.status(400).send(invalidLinkPage());

        res.send(page('Merci', '<h1>Merci !</h1><p>Votre correction a été envoyée à votre responsable pour validation.</p>'));
    } catch (error) {
        console.error('❌ POST /missing-point/correct error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

// ══════════════════════════════════════════════════════════════
// RESPONSABLE1 REVIEW
// ══════════════════════════════════════════════════════════════

router.get('/missing-point/review/:token', async (req, res) => {
    try {
        const row = await missingPoints.getRequestByResponsableToken(req.params.token);
        if (!row) return res.status(404).send(invalidLinkPage());

        const workDate = row.work_date instanceof Date ? row.work_date.toISOString().split('T')[0] : String(row.work_date).split('T')[0];
        const token = encodeURIComponent(req.params.token);

        res.send(page('Validation pointage', `
            <h1>Correction proposée — ${escapeHtml(workDate)}</h1>
            <div class="card">
                <p><strong>${escapeHtml(row.full_name)}</strong> (matricule ${escapeHtml(row.matricule)})</p>
                <p>Arrivée : ${escapeHtml(row.proposed_arrival_time || '(inchangée)')}</p>
                <p>Départ : ${escapeHtml(row.proposed_departure_time || '(inchangée)')}</p>
                <p>Commentaire : ${escapeHtml(row.employee_comment || '—')}</p>
            </div>
            <form method="POST" action="/missing-point/review/${token}/approve" style="display:inline">
                <button class="approve" type="submit">Approuver</button>
            </form>
            <form method="POST" action="/missing-point/review/${token}/reject" style="display:inline">
                <label>Motif du refus (si refus)<textarea name="rejectionComment" rows="2"></textarea></label>
                <button class="reject" type="submit">Refuser</button>
            </form>
        `));
    } catch (error) {
        console.error('❌ GET /missing-point/review error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

router.post('/missing-point/review/:token/approve', async (req, res) => {
    try {
        const result = await missingPoints.approveRequest(req.params.token);
        if (!result.ok) return res.status(400).send(invalidLinkPage());
        res.send(page('Validé', '<h1>Correction validée</h1><p>La correction a été enregistrée dans la base de données.</p>'));
    } catch (error) {
        console.error('❌ POST /missing-point/review/approve error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

router.post('/missing-point/review/:token/reject', async (req, res) => {
    try {
        const { rejectionComment } = req.body || {};
        const result = await missingPoints.rejectRequest(req.params.token, rejectionComment);
        if (!result.ok) return res.status(400).send(invalidLinkPage());
        res.send(page('Refusé', '<h1>Correction refusée</h1><p>L\'employé va recevoir un nouvel e-mail pour corriger.</p>'));
    } catch (error) {
        console.error('❌ POST /missing-point/review/reject error:', error.message);
        res.status(500).send(invalidLinkPage());
    }
});

// ══════════════════════════════════════════════════════════════
// MANUAL / TESTABLE TRIGGER — POST /api/missing-points/run
// ══════════════════════════════════════════════════════════════

function checkAutomationKey(req, res) {
    const expectedKey = process.env.MISSING_POINTS_API_KEY;
    if (!expectedKey) {
        res.status(503).json({ success: false, error: 'MISSING_POINTS_API_KEY is not configured on the server' });
        return false;
    }
    if (req.header('x-automation-key') !== expectedKey) {
        res.status(401).json({ success: false, error: 'Invalid or missing x-automation-key header' });
        return false;
    }
    return true;
}

router.post('/api/missing-points/pause', async (req, res) => {
    try {
        if (!checkAutomationKey(req, res)) return;
        const { paused = true } = req.body || {};
        const result = await missingPoints.setAutomationPaused(paused);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('❌ POST /api/missing-points/pause error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/missing-points/resend', async (req, res) => {
    try {
        if (!checkAutomationKey(req, res)) return;
        const { uid } = req.body || {};
        if (uid === undefined || uid === null || Number.isNaN(Number(uid))) {
            return res.status(400).json({ success: false, error: 'uid (numeric) is required' });
        }
        const result = await missingPoints.forceResendForUid(Number(uid));
        if (!result.ok) return res.status(404).json({ success: false, error: result.error });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('❌ POST /api/missing-points/resend error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/api/missing-points/run', async (req, res) => {
    try {
        if (!checkAutomationKey(req, res)) return;

        const { date, dryRun, testEmail } = req.body || {};

        // Test mode: creates one fully synthetic request using only the
        // given email (never real employee/HR data), so the whole loop can
        // be exercised safely from a single inbox. Ignores date/dryRun.
        if (testEmail) {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(testEmail))) {
                return res.status(400).json({ success: false, error: 'testEmail must be a valid email address' });
            }
            const result = await missingPoints.createSyntheticTestRequest(testEmail);
            return res.json({ success: true, ...result });
        }

        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
            return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
        }

        const result = await missingPoints.runDailySweep({ targetDate: date || null, dryRun: !!dryRun });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('❌ POST /api/missing-points/run error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
