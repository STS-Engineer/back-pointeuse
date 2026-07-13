const express = require('express');
const router = express.Router();
const leaveBalance = require('../services/leaveBalance');

router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

function checkAutomationKey(req, res) {
    const expectedKey = process.env.LEAVE_BALANCE_API_KEY;
    if (!expectedKey) {
        res.status(503).json({ success: false, error: 'LEAVE_BALANCE_API_KEY is not configured on the server' });
        return false;
    }
    if (req.header('x-automation-key') !== expectedKey) {
        res.status(401).json({ success: false, error: 'Invalid or missing x-automation-key header' });
        return false;
    }
    return true;
}

router.get('/api/leave-balance', async (req, res) => {
    try {
        const rows = await leaveBalance.getAllLeaveBalances();
        res.json({ success: true, count: rows.length, balances: rows });
    } catch (error) {
        console.error('❌ GET /api/leave-balance error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/leave-balance/:employeeId', async (req, res) => {
    try {
        const employeeId = Number(req.params.employeeId);
        if (!Number.isFinite(employeeId)) {
            return res.status(400).json({ success: false, error: 'employeeId must be numeric' });
        }
        const row = await leaveBalance.getLeaveBalanceForEmployeeId(employeeId);
        if (!row) return res.status(404).json({ success: false, error: 'no balance found for employeeId' });
        res.json({ success: true, balance: row });
    } catch (error) {
        console.error('❌ GET /api/leave-balance/:employeeId error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Manual rewind — use this when attendance data arrived AFTER the nightly
// cron already advanced past that window (e.g. the ZKTeco device was down
// and data got backfilled later). Re-checks [sinceDate, asOfDate] and ADDS
// the freshly computed delta on top of the current balance. Only safe when
// the earlier pass genuinely credited 0 for that window — see the doc
// comment on recomputeLeaveBalances in services/leaveBalance.js.
router.post('/api/leave-balance/resync', async (req, res) => {
    try {
        if (!checkAutomationKey(req, res)) return;
        const { employeeIds, sinceDate, asOfDate } = req.body || {};

        if (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(sinceDate))) {
            return res.status(400).json({ success: false, error: 'sinceDate (YYYY-MM-DD) is required' });
        }
        if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate))) {
            return res.status(400).json({ success: false, error: 'asOfDate must be YYYY-MM-DD' });
        }
        if (employeeIds !== undefined && (!Array.isArray(employeeIds) || employeeIds.some(id => Number.isNaN(Number(id))))) {
            return res.status(400).json({ success: false, error: 'employeeIds must be an array of numbers if provided' });
        }

        const result = await leaveBalance.recomputeLeaveBalances({
            asOfDate: asOfDate || null,
            sinceDate,
            employeeIds: employeeIds || null,
        });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('❌ POST /api/leave-balance/resync error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
