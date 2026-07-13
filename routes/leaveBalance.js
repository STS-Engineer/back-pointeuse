const express = require('express');
const router = express.Router();
const leaveBalance = require('../services/leaveBalance');

router.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

router.get('/api/leave-balance', async (req, res) => {
    try {
        const rows = await leaveBalance.getAllLeaveBalances();
        res.json({ success: true, count: rows.length, balances: rows });
    } catch (error) {
        console.error('❌ GET /api/leave-balance error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/api/leave-balance/:uid', async (req, res) => {
    try {
        const uid = Number(req.params.uid);
        if (!Number.isFinite(uid)) {
            return res.status(400).json({ success: false, error: 'uid must be numeric' });
        }
        const row = await leaveBalance.getLeaveBalanceForUid(uid);
        if (!row) return res.status(404).json({ success: false, error: 'no balance found for uid' });
        res.json({ success: true, balance: row });
    } catch (error) {
        console.error('❌ GET /api/leave-balance/:uid error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
