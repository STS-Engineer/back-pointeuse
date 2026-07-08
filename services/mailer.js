const nodemailer = require('nodemailer');

function normalizeOptionalTextInput(value) {
    const normalized = String(value || '').trim();
    return normalized.length > 0 ? normalized : null;
}

function parseBooleanEnv(value, defaultValue = false) {
    if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
    return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Administration STS';
const MAIL_FROM_ADDRESS = normalizeOptionalTextInput(process.env.MAIL_FROM_ADDRESS)
    || normalizeOptionalTextInput(process.env.SMTP_USER)
    || 'administration.STS@avocarbon.com';

let cachedTransporter = null;

function createTransporter() {
    const host = normalizeOptionalTextInput(process.env.SMTP_HOST) || 'avocarbon-com.mail.protection.outlook.com';
    const parsedPort = Number.parseInt(String(process.env.SMTP_PORT || '25'), 10);
    const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 25;
    const secure = parseBooleanEnv(process.env.SMTP_SECURE, port === 465);
    const defaultAuthMode = host.toLowerCase().includes('mail.protection.outlook.com') ? 'none' : 'basic';
    const authMode = String(process.env.SMTP_AUTH_MODE || defaultAuthMode).trim().toLowerCase();
    const smtpUser = normalizeOptionalTextInput(process.env.SMTP_USER);
    const smtpPass = normalizeOptionalTextInput(process.env.SMTP_PASS);

    const transporterOptions = {
        host,
        port,
        secure,
        pool: true,
        maxConnections: 2,
        maxMessages: 100,
        connectionTimeout: 20000,
        greetingTimeout: 15000,
        socketTimeout: 60000,
        tls: { servername: host },
    };

    if (parseBooleanEnv(process.env.SMTP_REQUIRE_TLS, false)) {
        transporterOptions.requireTLS = true;
    }

    if (authMode !== 'none' && smtpUser && smtpPass) {
        transporterOptions.auth = { user: smtpUser, pass: smtpPass };
    }

    return nodemailer.createTransport(transporterOptions);
}

function getTransporter() {
    if (!cachedTransporter) cachedTransporter = createTransporter();
    return cachedTransporter;
}

/**
 * @param {{to: string|string[], cc?: string|string[], subject: string, html: string}} options
 */
async function sendMail({ to, cc, subject, html }) {
    const toList = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
    if (!toList.length) throw new Error('sendMail requires at least one "to" recipient');

    const transporter = getTransporter();
    return transporter.sendMail({
        from: { name: MAIL_FROM_NAME, address: MAIL_FROM_ADDRESS },
        to: toList.join(', '),
        cc: cc ? (Array.isArray(cc) ? cc.filter(Boolean).join(', ') : cc) : undefined,
        subject,
        html,
    });
}

module.exports = { sendMail };
