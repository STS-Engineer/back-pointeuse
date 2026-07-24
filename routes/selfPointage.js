const express = require('express');
const crypto = require('crypto');
const moment = require('moment-timezone');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { verifyLocalSession } = require('../middleware/localSession');
const { normalizeMatricule } = require('./attendance');
const { applyManualCorrection } = require('../services/attendanceCorrection');
const mailer = require('../services/mailer');

const TIMEZONE = 'Africa/Tunis';

function intEnv(name, defaultValue) {
    const parsed = parseInt(process.env[name], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const SESSION_TTL_HOURS = intEnv('SELF_POINTAGE_SESSION_TTL_HOURS', 12);
const MAX_FAILED_ATTEMPTS = intEnv('SELF_POINTAGE_MAX_FAILED_ATTEMPTS', 5);
const LOCKOUT_MINUTES = intEnv('SELF_POINTAGE_LOCKOUT_MINUTES', 15);

function generatePin() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function todayInTz() {
    return moment().tz(TIMEZONE).format('YYYY-MM-DD');
}

function nowTimeInTz() {
    return moment().tz(TIMEZONE).format('HH:mm');
}

function formatTimeHHMM(value) {
    if (!value) return null;
    return String(value).slice(0, 5);
}

// ══════════════════════════════════════════════════════════════
// TABLE BOOTSTRAP
// ══════════════════════════════════════════════════════════════

let credentialsTableEnsured = false;

async function ensureCredentialsTable() {
    if (credentialsTableEnsured) return;
    await global.attendancePool.query(`
        CREATE TABLE IF NOT EXISTS public.self_pointage_credentials (
            matricule TEXT PRIMARY KEY,
            pin_hash TEXT NOT NULL,
            failed_attempts INT NOT NULL DEFAULT 0,
            locked_until TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    credentialsTableEnsured = true;
}

// Resolves an employee by matricule against BOTH databases (HR = source of
// truth for "still active", attendance = source of truth for uid/full
// name/card). Re-run on every login/me/punch call so an employee HR marks
// inactive/departed automatically loses self-pointage access, mirroring
// the active-only filtering already used everywhere else in this app
// (see routes/attendance.js:fetchActiveHrEmployees).
async function resolveActiveEmployeeByMatricule(matricule) {
    const normalized = normalizeMatricule(matricule);
    if (!normalized) return null;

    const { rows: hrRows } = await global.hrPool.query(`
        SELECT id, matricule, nom, prenom, adresse_mail
        FROM employees
        WHERE matricule = $1
          AND date_depart IS NULL
          AND COALESCE(statut, 'actif') = 'actif'
        LIMIT 1
    `, [normalized]);

    const hrEmployee = hrRows[0];
    if (!hrEmployee) return null;

    const { rows: attRows } = await global.attendancePool.query(`
        SELECT uid, matricule, pointeuse_user_id, full_name, card_no
        FROM public.employees
        WHERE matricule = $1
        LIMIT 1
    `, [normalized]);

    const attEmployee = attRows[0];
    if (!attEmployee || attEmployee.uid === null || attEmployee.uid === undefined) return null;

    return {
        hrId: hrEmployee.id,
        uid: attEmployee.uid,
        matricule: normalized,
        email: hrEmployee.adresse_mail || null,
        fullName: attEmployee.full_name || `${hrEmployee.prenom || ''} ${hrEmployee.nom || ''}`.trim(),
        cardNo: attEmployee.card_no || null,
        pointeuseUserId: attEmployee.pointeuse_user_id || null,
    };
}

async function fetchTodayAttendance(uid, date) {
    const { rows } = await global.attendancePool.query(`
        SELECT to_char(arrival_time, 'HH24:MI') AS "arrivalTime",
               to_char(departure_time, 'HH24:MI') AS "departureTime"
        FROM public.attendance_daily
        WHERE uid = $1 AND work_date = $2
    `, [uid, date]);
    return rows[0] || null;
}

// ══════════════════════════════════════════════════════════════
// POST /api/self-pointage/pin/request { matricule }
// ══════════════════════════════════════════════════════════════

router.post('/pin/request', async (req, res) => {
    try {
        const { matricule } = req.body || {};
        if (!matricule) return res.status(400).json({ success: false, error: 'matricule is required' });

        await ensureCredentialsTable();
        const employee = await resolveActiveEmployeeByMatricule(matricule);

        if (employee && employee.email) {
            const pin = generatePin();
            const pinHash = await bcrypt.hash(pin, 10);

            // Generating a new code immediately replaces the previous one —
            // same trade-off as any "forgot password" reset flow.
            await global.attendancePool.query(`
                INSERT INTO public.self_pointage_credentials (matricule, pin_hash, failed_attempts, locked_until, updated_at)
                VALUES ($1, $2, 0, NULL, now())
                ON CONFLICT (matricule) DO UPDATE SET
                    pin_hash = EXCLUDED.pin_hash,
                    failed_attempts = 0,
                    locked_until = NULL,
                    updated_at = now()
            `, [employee.matricule, pinHash]);

            try {
                await mailer.sendMail({
                    to: employee.email,
                    subject: 'Pointeuse — votre code de pointage',
                    html: `
                        <p>Bonjour ${employee.fullName || ''},</p>
                        <p>Voici votre code à 6 chiffres utilisé pour pointer votre arrivée et votre départ :</p>
                        <p style="font-size:24px; font-weight:bold; letter-spacing:4px;">${pin}</p>
                        <p>Ce code remplace tout code précédent. Ne le partagez avec personne.</p>
                    `,
                });
            } catch (mailError) {
                // Don't let an SMTP failure 500 this request — that would leak,
                // via the status code, that the matricule matched (unlike the
                // generic response below). Log and fall through instead.
                console.error(`❌ [self-pointage] failed to email PIN to matricule=${employee.matricule}:`, mailError.message);
            }
        }

        // Same response whether or not the matricule matched an active
        // employee, so this endpoint never reveals which matricules exist.
        res.json({ success: true, message: "Si ce matricule existe, un code a été envoyé par email." });
    } catch (error) {
        console.error('❌ POST /self-pointage/pin/request error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// POST /api/self-pointage/login { matricule, pin }
// ══════════════════════════════════════════════════════════════

router.post('/login', async (req, res) => {
    try {
        const { matricule, pin } = req.body || {};
        if (!matricule || !pin) {
            return res.status(400).json({ success: false, error: 'matricule and pin are required' });
        }

        const jwtSecret = process.env.SELF_POINTAGE_JWT_SECRET;
        if (!jwtSecret) {
            return res.status(500).json({ success: false, error: 'SELF_POINTAGE_JWT_SECRET not configured' });
        }

        await ensureCredentialsTable();
        const employee = await resolveActiveEmployeeByMatricule(matricule);
        if (!employee) return res.status(404).json({ success: false, error: 'employee_not_found' });

        const { rows } = await global.attendancePool.query(`
            SELECT * FROM public.self_pointage_credentials WHERE matricule = $1
        `, [employee.matricule]);
        const credentials = rows[0];

        if (!credentials) {
            return res.status(404).json({ success: false, error: 'pin_not_set' });
        }

        if (credentials.locked_until && moment(credentials.locked_until).isAfter(moment())) {
            return res.status(423).json({ success: false, error: 'locked', lockedUntil: credentials.locked_until });
        }

        const valid = await bcrypt.compare(String(pin), credentials.pin_hash);

        if (!valid) {
            const nextAttempts = (credentials.failed_attempts || 0) + 1;
            const nowLocked = nextAttempts >= MAX_FAILED_ATTEMPTS;
            const lockedUntil = nowLocked ? moment().add(LOCKOUT_MINUTES, 'minutes').toDate() : null;

            await global.attendancePool.query(`
                UPDATE public.self_pointage_credentials
                SET failed_attempts = $2, locked_until = $3, updated_at = now()
                WHERE matricule = $1
            `, [employee.matricule, nowLocked ? 0 : nextAttempts, lockedUntil]);

            if (nowLocked) {
                return res.status(423).json({ success: false, error: 'locked', lockedUntil });
            }
            return res.status(401).json({ success: false, error: 'invalid_pin' });
        }

        await global.attendancePool.query(`
            UPDATE public.self_pointage_credentials
            SET failed_attempts = 0, locked_until = NULL, updated_at = now()
            WHERE matricule = $1
        `, [employee.matricule]);

        const token = jwt.sign({ sub: employee.matricule }, jwtSecret, { expiresIn: `${SESSION_TTL_HOURS}h` });

        res.json({ success: true, token, employee: { fullName: employee.fullName, matricule: employee.matricule } });
    } catch (error) {
        console.error('❌ POST /self-pointage/login error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// GET /api/self-pointage/me
// ══════════════════════════════════════════════════════════════

router.get('/me', verifyLocalSession, async (req, res) => {
    try {
        const employee = await resolveActiveEmployeeByMatricule(req.matricule);
        if (!employee) {
            return res.status(404).json({ success: false, error: 'No active employee found for this account' });
        }

        const date = todayInTz();
        const attendance = await fetchTodayAttendance(employee.uid, date);

        res.json({
            success: true,
            employee: { fullName: employee.fullName, matricule: employee.matricule },
            date,
            arrivalTime: attendance ? formatTimeHHMM(attendance.arrivalTime) : null,
            departureTime: attendance ? formatTimeHHMM(attendance.departureTime) : null,
        });
    } catch (error) {
        console.error('❌ GET /self-pointage/me error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════
// POST /api/self-pointage/punch { type: 'arrival' | 'departure' }
// ══════════════════════════════════════════════════════════════

router.post('/punch', verifyLocalSession, async (req, res) => {
    try {
        const { type } = req.body || {};
        if (type !== 'arrival' && type !== 'departure') {
            return res.status(400).json({ success: false, error: "type must be 'arrival' or 'departure'" });
        }

        const employee = await resolveActiveEmployeeByMatricule(req.matricule);
        if (!employee) {
            return res.status(404).json({ success: false, error: 'No active employee found for this account' });
        }

        const date = todayInTz();
        const existing = await fetchTodayAttendance(employee.uid, date);
        const existingTime = existing ? formatTimeHHMM(type === 'arrival' ? existing.arrivalTime : existing.departureTime) : null;

        // Never clobber a real ZKTeco punch or an earlier self-punch, same
        // guard as services/remoteAttendance.js:getExistingRecordedTime.
        if (existingTime) {
            return res.status(409).json({ success: false, error: 'already_recorded', existingTime });
        }

        const recordedTime = nowTimeInTz();
        await applyManualCorrection(global.attendancePool, {
            uid: employee.uid,
            matricule: employee.matricule,
            pointeuseUserId: employee.pointeuseUserId,
            fullName: employee.fullName,
            cardNo: employee.cardNo,
            date,
            arrivalTime: type === 'arrival' ? recordedTime : null,
            departureTime: type === 'departure' ? recordedTime : null,
            comment: null,
            correctedBy: `self-pointage:${employee.matricule}`,
        });

        res.json({ success: true, type, date, recordedTime });
    } catch (error) {
        console.error('❌ POST /self-pointage/punch error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
module.exports.resolveActiveEmployeeByMatricule = resolveActiveEmployeeByMatricule;
module.exports.todayInTz = todayInTz;
