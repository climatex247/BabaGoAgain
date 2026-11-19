'use strict';

const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');
const db = require('./database-mysql');
const { initializeCoreSchema } = require('./schema-mysql');
const opay = require('./opay');
const path = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createReferralService } = require('./referrals');
const referrals = createReferralService(db);

const app = express();

// Trust the single reverse-proxy hop in the Render deployment.
app.set('trust proxy', 1);

// BGA_AUTH_RATE_LIMITS: protect authentication endpoints against automated abuse.
const makeAuthLimiter = (windowMs, limit, message) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    success: false,
    message
  })
});

const registerLimiter = makeAuthLimiter(
  15 * 60 * 1000, 5,
  'Too many registration attempts. Please try again in 15 minutes.'
);

const loginLimiter = makeAuthLimiter(
  15 * 60 * 1000, 10,
  'Too many login attempts. Please try again in 15 minutes.'
);

const resendVerificationLimiter = makeAuthLimiter(
  15 * 60 * 1000, 3,
  'Too many verification requests. Please try again later.'
);

const forgotPasswordLimiter = makeAuthLimiter(
  15 * 60 * 1000, 3,
  'Too many password recovery requests. Please try again later.'
);

const resetPasswordLimiter = makeAuthLimiter(
  15 * 60 * 1000, 10,
  'Too many password reset attempts. Please try again later.'
);


app.disable('x-powered-by');

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://127.0.0.1:5000'
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(morgan('dev'));

/* BGA_CSRF_ORIGIN_GUARD
 * Protect cookie-authenticated state-changing requests against CSRF.
 */
const trustedBrowserOrigins = new Set();

for (const configured of [
  process.env.APP_BASE_URL,
  process.env.CORS_ORIGIN
]) {
  if (!configured) continue;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      trustedBrowserOrigins.add(parsed.origin);
    }
  } catch {
    console.error('[SECURITY] Ignoring invalid configured browser origin.');
  }
}

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const cookies = String(req.headers.cookie || '');
  const hasSessionCookie = cookies
    .split(';')
    .some(item => item.trim().startsWith('bga_session='));

  // Public authentication requests without an existing session are unaffected.
  if (!hasSessionCookie) return next();

  const origin = String(req.headers.origin || '').trim();
  const referer = String(req.headers.referer || '').trim();

  let requestOrigin = '';

  try {
    if (origin && origin !== 'null') {
      requestOrigin = new URL(origin).origin;
    } else if (referer) {
      requestOrigin = new URL(referer).origin;
    }
  } catch {
    requestOrigin = '';
  }

  if (!requestOrigin || !trustedBrowserOrigins.has(requestOrigin)) {
    console.warn('[SECURITY] Blocked untrusted state-changing request:', req.method, req.path);
    return res.status(403).json({
      success: false,
      message: 'Request origin could not be verified. Refresh the page and try again.'
    });
  }

  next();
});


const frontendPath = path.resolve(__dirname, '../frontend');

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    application: 'Baba Go Again'
  });
});

app.get('/api', (req, res) => {
  res.json({
    success: true,
    application: 'Baba Go Again',
    version: '1.0.0',
    message: 'API is running'
  });
});

app.use(express.static(frontendPath, {
  setHeaders(res, filePath) {
    if (/register\.(js|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(frontendPath, 'register.html'));
});

app.get('/ai-guide', (req, res) => res.sendFile(path.join(frontendPath, 'ai-guide.html')));

app.get('/login', (req, res) => {
  res.sendFile(path.join(frontendPath, 'login.html'));
});

app.get('/forgot-password', (req, res) => {
  res.sendFile(path.join(frontendPath, 'forgot-password.html'));
});

app.get('/reset-password', (req, res) => { res.sendFile(path.join(frontendPath, 'reset-password.html')); });

const TOKEN_TTL = 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const passwordHash = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve(`${salt}:${key.toString('hex')}`)));
const passwordMatches = async (password, stored) => {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = await passwordHash(password, salt);
  const actualBuf = Buffer.from(actual.split(':')[1], 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  return actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
};
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const sessionSecret = () => String(process.env.SESSION_SECRET || '' );
function makeSession(userId, sessionVersion=0) { const payload=Buffer.from(JSON.stringify({sub:userId,ver:sessionVersion,exp:Date.now()+7*24*60*60*1000})).toString('base64url'); const sig=crypto.createHmac('sha256',sessionSecret()).update(payload).digest('base64url'); return `${payload}.${sig}`; }
function readSession(req) {
  const raw = String(req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith('bga_session='))?.slice('bga_session='.length);
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig || !sessionSecret()) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && data.sub && Number.isInteger(data.ver) ? data : null;
  } catch { return null; }
}

async function sendEmail(to, subject, textContent, htmlContent) {
  const key = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_FROM;
  const senderName = process.env.BREVO_SENDER_NAME || 'Baba Go Again';
  if (!key || !senderEmail) {
    console.error('Email delivery not configured: set BREVO_API_KEY and BREVO_SENDER_EMAIL in backend/.env');
    throw new Error('Email delivery is not configured.');
  }
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject, textContent, htmlContent })
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Brevo email delivery failed:', response.status, detail.slice(0, 300));
    throw new Error('Email delivery is temporarily unavailable. Check the email provider configuration.');
  }
  return true;
}
const publicUser = row => ({ id: row.id, name: row.full_name, email: row.email, phone: row.phone, state: row.state_name, lga: row.lga_name, ward: row.ward_name, preferredLanguage: row.preferred_language, roles: JSON.parse(row.roles_json || '[]'), emailVerified: Boolean(row.email_verified), status: row.status });
const safeText = (v, max=300) => String(v || '').trim().slice(0, max);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function getPublicBaseUrl() {
  const value = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (!value) throw new Error('APP_BASE_URL is not configured.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    throw new Error('APP_BASE_URL must be a reachable public HTTP(S) address.');
  }
  return value;
}

const geo = require('nigeria-inec-geo');
const locationById = (collection, id) => collection.find(x => String(x.portal_id) === String(id));

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const name = safeText(req.body.name, 100), phone = safeText(req.body.phone, 20);
    const email = safeText(req.body.email, 254).toLowerCase(), address = safeText(req.body.address, 300);
    const password = String(req.body.password || ''), confirmPassword = String(req.body.confirmPassword || '');
    const suppliedReferralCode = safeText(req.body.referralCode, 32).toUpperCase();
    const founderEmail = safeText(process.env.BGA_FOUNDER_EMAIL || 'babagoagain@gmail.com', 254).toLowerCase();
    const isFounderRegistration = email === founderEmail;
    const language = safeText(req.body.preferredLanguage || 'English', 60);
    const state = locationById(geo.states(), req.body.state);
    const lga = locationById(geo.lgas(), req.body.lga);
    const ward = locationById(geo.wards(), req.body.ward);
    const pu = req.body.pollingUnit ? geo.pollingUnits().find(x => String(x.portal_id) === String(req.body.pollingUnit)) : null;
    const roles = Array.isArray(req.body.roles) ? req.body.roles.map(x => safeText(x, 40)).filter(x => ['Member','Volunteer','Youth Leader','Women Leader','Politician','Coordinator','Other'].includes(x)) : (req.body.roles ? [safeText(req.body.roles,40)] : []);
    if (!name || !phone || !emailPattern.test(email) || !address) return res.status(400).json({ success:false, message:'Complete your name, phone, email and residential address.' });
    if (!suppliedReferralCode && !isFounderRegistration) return res.status(400).json({ success:false, code:'REFERRAL_CODE_REQUIRED', message:'A valid referral code is required to register. Ask the person who invited you for their invitation link or QR code.' });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ success:false, message:'Password must be between 6 and 128 characters.' });
    if (password !== confirmPassword) return res.status(400).json({ success:false, message:'Passwords do not match.' });
    if (!state || !lga || String(lga.state_portal_id) !== String(state.portal_id) || !ward || String(ward.lga_portal_id) !== String(lga.portal_id)) return res.status(400).json({ success:false, message:'Select a valid State, LGA and Ward in order.' });
    if (req.body.pollingUnit && (!pu || pu.state_code !== state.code || pu.lga_code !== lga.code || pu.ward_code !== ward.code)) return res.status(400).json({ success:false, message:'The polling unit does not match your selected location.' });
    if (!roles.length) return res.status(400).json({ success:false, message:'Select at least one role.' });
    if (req.body.acceptTerms !== true || req.body.acceptPrivacy !== true) return res.status(400).json({ success:false, message:'Accept the Terms and Privacy Notice to continue.' });
    const duplicate = await db.get('SELECT id, email, phone, email_verified, status FROM users WHERE email = ? OR phone = ?', [email, phone]);
    if (duplicate) {
      const sameEmail = duplicate.email === email;
      const unverified = sameEmail && !duplicate.email_verified && duplicate.status === 'pending_verification';
      return res.status(409).json({
        success: false,
        code: unverified ? 'VERIFICATION_REQUIRED' : 'ACCOUNT_EXISTS',
        message: unverified
          ? 'An account already exists with this email but is not verified. Do not register again. Go to Login and use Resend Verification Email.'
          : 'An account with that email address or phone number already exists. Please log in or recover your existing account.'
      });
    }
    const id = crypto.randomUUID(), now = new Date().toISOString(), hash = await passwordHash(password);
    const otherRole = roles.includes('Other') ? safeText(req.body.otherRoleText,100) : null;
    await referrals.ensureSchema();

    let referral;
    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + TOKEN_TTL;

    await db.transaction(async tx => {
      await tx.run(
        `INSERT INTO users
        (id,full_name,phone,email,preferred_language,address,state_id,state_name,
         lga_id,lga_name,ward_id,ward_name,polling_unit_id,roles_json,other_role,
         password_hash,email_verified,status,accepted_terms,accepted_privacy,
         created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'pending_verification',1,1,?,?)`,
        [id,name,phone,email,language,address,String(state.portal_id),state.name,
         String(lga.portal_id),lga.name,String(ward.portal_id),ward.name,
         pu ? String(pu.portal_id) : null,JSON.stringify(roles),otherRole,
         hash,now,now]
      );

      referral = await referrals.registerMember(
        tx,
        id,
        isFounderRegistration ? '' : suppliedReferralCode,
        isFounderRegistration
      );

      await tx.run(
        'INSERT INTO email_verification_tokens (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
        [tokenHash(token),id,expires,Date.now()]
      );
    });

    try {
      const base = getPublicBaseUrl();
      await sendEmail(email,'Verify your Baba Go Again account',`Hello ${name}, verify your account using this link: ${base}/verify-email?token=${token}\nThis link expires in 60 minutes.`,`<p>Hello ${name.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))},</p><p>Please verify your Baba Go Again account.</p><p><a href="${base}/verify-email?token=${token}">Verify email address</a></p><p>This link expires in 60 minutes.</p>`);
    } catch (mailError) {
      console.error('Registration verification email failed:', mailError.message);
      return res.status(201).json({
        success: true,
        code: 'VERIFICATION_EMAIL_FAILED',
        message: 'Your account has been created, but the verification email could not be sent. Do not register again. Go to Login and use Resend Verification Email when email service is available.',
        emailDelivery: false,
        referralCode: referral.referralCode
      });
    }
    return res.status(201).json({success:true,message:'Account created. Check your email and verify your address before logging in.',emailDelivery:true,referralCode:referral.referralCode});

  } catch (error) {
    if (error.code === 'INVALID_REFERRAL_CODE') {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }

    const duplicateMessage = String(
      error.sqlMessage || error.message || ''
    );

    const emailOrPhoneDuplicate =
      error.code === 'ER_DUP_ENTRY' &&
      /for key ['"`]?(?:[^'"`]+\.)?(?:email|phone)['"`]?/i.test(
        duplicateMessage
      );

    if (emailOrPhoneDuplicate) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email address or phone number already exists.'
      });
    }

    console.error('Registration error:', error);

    return res.status(500).json({
      success: false,
      message: 'Registration failed unexpectedly. Please try again.'
    });
  }

});

app.get('/email-verification', (req, res) => res.sendFile(path.join(frontendPath, 'verify-email.html')));

app.get('/verify-email', async (req,res) => {
  try {
    const token = safeText(req.query.token, 200);
    if (!token) return res.status(400).send('Verification link is missing.');
    const hashedToken = tokenHash(token);

    const verified = await db.transaction(async tx => {
      // Lock the token row so concurrent requests cannot consume it twice.
      const record = await tx.get(
        'SELECT user_id,expires_at FROM email_verification_tokens WHERE token_hash = ? FOR UPDATE',
        [hashedToken]
      );

      if (!record) return false;

      const now = Date.now();

      if (Number(record.expires_at) < now) {
        await tx.run(
          'DELETE FROM email_verification_tokens WHERE token_hash = ? AND expires_at < ?',
          [hashedToken, now]
        );
        return false;
      }

      // Consume the token exactly once.
      const consumed = await tx.run(
        'DELETE FROM email_verification_tokens WHERE token_hash = ? AND expires_at >= ?',
        [hashedToken, now]
      );

      if (consumed.changes !== 1) return false;

      const activated = await tx.run(
        "UPDATE users SET email_verified=1,status='active',updated_at=? WHERE id=? AND email_verified=0 AND status='pending_verification'",
        [new Date().toISOString(), record.user_id]
      );

      return activated.changes === 1;
    });

    if (!verified) {
      return res.status(400).send('<h1>Verification link expired or invalid</h1><p>Your account may still exist. Do not register again. Return to login and use Resend Verification Email to request a new link.</p><a href="/login">Go to login</a>');
    }
    return res.send('<!doctype html><meta name="viewport" content="width=device-width"><title>Email verified</title><h1>Email verified successfully</h1><p>Your account is ready. You can now log in.</p><a href="/login">Go to login</a>');
  } catch(e) { console.error(e); return res.status(500).send('Could not verify email. Please try again later.'); }
});


const verificationResendCooldown = new Map();

app.post('/api/auth/resend-verification', resendVerificationLimiter, async (req, res) => {
  const generic = 'If an unverified account matches that email, verification instructions will be sent.';
  try {
    const email = safeText(req.body.email, 254).toLowerCase();
    if (!emailPattern.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }

    const now = Date.now();
    const previous = verificationResendCooldown.get(email) || 0;
    if (now - previous < 60000) {
      return res.json({ success: true, message: generic });
    }
    const user = await db.get(
      "SELECT id, full_name, email, email_verified, status FROM users WHERE lower(email) = lower(?)",
      [email]
    );

    console.info('Verification resend diagnostic:', {
      accountFound: Boolean(user),
      emailVerified: user ? Boolean(user.email_verified) : null,
      status: user ? user.status : null
    });

    if (user && !user.email_verified && user.status === 'pending_verification') {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = now + TOKEN_TTL;

      // Preserve existing verification tokens until email delivery succeeds.
      await db.run(
        'INSERT INTO email_verification_tokens (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)',
        [tokenHash(token), user.id, expires, now]
      );

      const base = getPublicBaseUrl();
      try {
        await sendEmail(
          email,
          'Verify your Baba Go Again account',
          'Hello ' + user.full_name + ', verify your account using this link: ' + base + '/verify-email?token=' + token + '\nThis link expires in 60 minutes.',
          '<p>Please verify your Baba Go Again account.</p><p><a href="' + base + '/verify-email?token=' + token + '">Verify email address</a></p><p>This link expires in 60 minutes.</p>'
        );
      } catch (mailError) {
        // Remove only the newly generated token; preserve older valid tokens.
        await db.run(
          'DELETE FROM email_verification_tokens WHERE user_id = ? AND token_hash = ?',
          [user.id, tokenHash(token)]
        );
        throw mailError;
      }

      // Replace older tokens only after successful email delivery.
      await db.run(
        'DELETE FROM email_verification_tokens WHERE user_id = ? AND token_hash <> ?',
        [user.id, tokenHash(token)]
      );
      verificationResendCooldown.set(email, Date.now());
      console.info('Verification email accepted by provider for eligible account.');
    }

    return res.json({ success: true, message: generic });
  } catch (error) {
    console.error('Verification resend failed:', error.message, 'cause:', error.cause ? JSON.stringify({name:error.cause.name,code:error.cause.code,message:error.cause.message}) : 'none');
    return res.status(503).json({
      success: false,
      message: 'Verification email could not be sent. Check the email provider configuration and try again later.'
    });
  }
});

app.post('/api/auth/login', loginLimiter, async (req,res) => {
  try {
    const email=safeText(req.body.email,254).toLowerCase(), password=String(req.body.password||'');
    const user=await db.get('SELECT * FROM users WHERE email=?',[email]);
    if (!user || !(await passwordMatches(password,user.password_hash))) return res.status(401).json({success:false,message:'Email or password is incorrect.'});
    if (!user.email_verified || user.status !== 'active') return res.status(403).json({success:false,message:'Please verify your email address before logging in.'});
    res.setHeader('Set-Cookie', `bga_session=${makeSession(user.id, user.session_version || 0)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
    return res.json({success:true,message:'Login successful.',user:publicUser(user)});
  } catch(e) { console.error('Login error:',e); return res.status(500).json({success:false,message:'Login is temporarily unavailable.'}); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const session = readSession(req);
    if (!session || !session.sub) {
      return res.status(401).json({ success: false, message: 'Not signed in.' });
    }
    const user = await db.get(
      "SELECT * FROM users WHERE id=? AND status='active' AND email_verified=1",
      [session.sub]
    );
    if (!user || Number(user.session_version || 0) !== session.ver) {
      return res.status(401).json({ success: false, message: 'Session is no longer valid. Please log in again.' });
    }
    return res.json({ success: true, user: publicUser(user) });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Could not load account.' });
  }
});
app.post('/api/auth/logout', async (req, res) => {
  const clearSessionCookie = () => {
    res.setHeader(
      'Set-Cookie',
      `bga_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`
    );
  };

  try {
    const session = readSession(req);

    if (session && session.sub) {
      await db.run(
        'UPDATE users SET session_version=session_version+1 WHERE id=?',
        [session.sub]
      );
    }

    clearSessionCookie();
    return res.json({ success: true, message: 'Logged out.' });
  } catch (error) {
    console.error('[SECURITY] Logout session invalidation failed:', error.message);
    clearSessionCookie();

    return res.status(503).json({
      success: false,
      message: 'Your browser session was cleared, but server-side logout could not be confirmed. Please try again.'
    });
  }
});

app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req,res) => {
  const generic='If an account matches that email, password reset instructions will be sent.';
  try {
    const email=safeText(req.body.email,254).toLowerCase();
    if (!emailPattern.test(email)) return res.status(400).json({success:false,message:'Enter a valid email address.'});
    const user=await db.get('SELECT id,email,full_name FROM users WHERE email=? AND email_verified=1 AND status=\'active\'',[email]);
    if (user) {
      const token=crypto.randomBytes(32).toString('hex'), now=Date.now();
      // Remove only expired tokens; preserve valid links until replacement email delivery succeeds.
      await db.run('DELETE FROM password_reset_tokens WHERE user_id=? AND expires_at<?',[user.id,now]);
      await db.run('INSERT INTO password_reset_tokens (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',[tokenHash(token),user.id,now+RESET_TTL,now]);
      const base=getPublicBaseUrl();
      await sendEmail(email,'Reset your Baba Go Again password',`Reset your password: ${base}/reset-password?token=${token}\nThis link expires in 60 minutes.`,`<p>Reset your Baba Go Again password.</p><p><a href="${base}/reset-password?token=${token}">Reset password</a></p><p>This link expires in 60 minutes.</p>`);
      await db.run('DELETE FROM password_reset_tokens WHERE user_id=? AND token_hash<>?',[user.id,tokenHash(token)]);
    }
    return res.json({success:true,message:generic});
  } catch(e) { console.error('Password reset request error:',e.message); return res.status(503).json({success:false,message:'Password recovery email could not be sent. Please try again later.'}); }
});

app.post('/api/auth/reset-password', resetPasswordLimiter, async (req,res) => {
  try {
    const token=safeText(req.body.token,200), password=String(req.body.password||''), confirm=String(req.body.confirmPassword||'');
    if (!token) return res.status(400).json({success:false,message:'Reset token is missing. Request a new password-reset link.'});
    if (password.length<6 || password.length>128) return res.status(400).json({success:false,message:'Password must be between 6 and 128 characters.'});
    if (password!==confirm) return res.status(400).json({success:false,message:'Passwords do not match.'});
    const th=tokenHash(token);
    const record=await db.get('SELECT user_id,expires_at FROM password_reset_tokens WHERE token_hash=?',[th]);
    if (!record) return res.status(400).json({success:false,message:'This reset link is invalid or expired. Request a new one.'});
    if (Number(record.expires_at)<Date.now()) {
      await db.run('DELETE FROM password_reset_tokens WHERE token_hash=?',[th]);
      return res.status(400).json({success:false,message:'This reset link is invalid or expired. Request a new one.'});
    }
    const hash=await passwordHash(password);
    await db.transaction(async tx =>{
      await tx.run('UPDATE users SET password_hash=?, session_version=session_version+1, updated_at=? WHERE id=?',[hash,new Date().toISOString(),record.user_id]);
      await tx.run('DELETE FROM password_reset_tokens WHERE user_id=?',[record.user_id]);
    });
    return res.json({success:true,message:'Password changed successfully. You can now log in.'});
  } catch(e) { console.error('Password reset error:',e); return res.status(500).json({success:false,message:'Could not reset password. Please try again.'}); }
});





/* BGA_AI_GUIDE_ENDPOINT_V1: secure AI personal guide. */
const bgaAiGuestLimits = new Map();

app.post('/api/ai/chat', async (req, res) => {
  try {
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 100);
    const now = Date.now();
    let usage = bgaAiGuestLimits.get(ip);

    if (!usage || now - usage.start >= 60_000) {
      usage = { start: now, count: 0 };
    }
    usage.count += 1;
    bgaAiGuestLimits.set(ip, usage);

    if (usage.count > 10) {
      return res.status(429).json({
        success: false,
        message: 'You have reached the guide limit. Please wait a minute and try again.'
      });
    }

    // Periodically remove expired entries to keep the in-memory limiter bounded.
    if (bgaAiGuestLimits.size > 5000) {
      for (const [key, item] of bgaAiGuestLimits) {
        if (now - item.start >= 60_000) bgaAiGuestLimits.delete(key);
      }
    }

    const message = String(req.body && req.body.message || '').trim();
    const language = String(req.body && req.body.language || 'English').trim().slice(0, 60);

    if (!message) {
      return res.status(400).json({ success: false, message: 'Please enter a question.' });
    }
    if (message.length > 2000) {
      return res.status(400).json({
        success: false,
        message: 'Please keep your question under 2,000 characters.'
      });
    }

    const apiUrl = process.env.AI_API_URL;
    const apiKey = process.env.AI_API_KEY;
    const model = process.env.AI_MODEL;

    if (!apiUrl || !apiKey || !model) {
      return res.status(503).json({
        success: false,
        code: 'AI_NOT_CONFIGURED',
        message: 'The guide interface is ready, but its AI service has not been configured yet.'
      });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(apiUrl);
    } catch {
      return res.status(503).json({ success: false, message: 'AI service configuration is invalid.' });
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== 'localhost' && parsedUrl.hostname !== '127.0.0.1') {
      return res.status(503).json({ success: false, message: 'AI service must use a secure HTTPS connection.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    let upstream;
    try {
      upstream = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: [
                'You are Baba Go Again AI Personal Guide, a helpful and patient guide for the Baba Go Again application.',
                'Answer in the language requested by the user when you can do so reliably; otherwise explain the limitation and offer English.',
                'Help users understand registration, login, email verification, profiles, audio and video uploads, community, messages, public figures, wallet, polling-unit/location features, account security, and learning.',
                'Give clear, numbered steps suitable for beginners using an Android phone.',
                'Do not claim that you performed an action, accessed an account, verified an email, uploaded media, sent a message, or changed a wallet unless a trusted app tool explicitly confirms it.',
                'Never ask for passwords, one-time codes, private reset links, API keys, or banking PINs.',
                'Do not invent app buttons or features. If a feature cannot be confirmed, say so and guide the user to the relevant app section or support.',
                'For election and civic topics, provide neutral, factual guidance.',
                'Be honest about uncertainty and language support. Do not claim all 90 Nigerian languages are supported.',
                'Reply in ' + language + ' where possible.'
              ].join(' ')
            },
            { role: 'user', content: message }
          ],
          temperature: 0.4,
          max_tokens: 700
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      console.error('AI provider returned HTTP status:', upstream.status);
      return res.status(502).json({
        success: false,
        message: 'The AI service could not answer right now. Please try again later.'
      });
    }

    const data = await upstream.json();
    const answer = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;

    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(502).json({
        success: false,
        message: 'The AI service returned an empty answer. Please try again.'
      });
    }

    return res.json({ success: true, answer: answer.trim().slice(0, 8000) });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return res.status(504).json({ success: false, message: 'The AI response took too long. Please try again.' });
    }
    console.error('AI guide request failed:', error.message);
    return res.status(500).json({ success: false, message: 'The guide could not answer right now.' });
  }
});

/* Authenticated community MVP: feed, groups, events and volunteering. */
async function authenticatedUser(req, res) {
  const session = readSession(req);
  const userId = session && session.sub;
  if (!userId) {
    res.status(401).json({ success: false, message: 'Please log in to continue.' });
    return null;
  }
  const user = await db.get("SELECT id, full_name, email, phone, roles_json, status, email_verified, session_version FROM users WHERE id = ?", [userId]);
  if (!user || user.status !== 'active' || !user.email_verified || Number(user.session_version || 0) !== Number(session.ver || 0)) {
    res.status(401).json({ success: false, message: 'Your session is no longer valid. Please log in again.' });
    return null;
  }
  return user;
}
const inputText = (value, max) => String(value || '').trim().slice(0, max);

app.get('/api/referrals/me', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;

    await referrals.ensureSchema();

    // Ensure older verified accounts also receive a referral code.
    const referralCode = await referrals.getOrCreateMemberCode(user.id);

    const summary = await db.get(`
      SELECT
        c.referral_code AS referralCode,
        s.full_name AS sponsorName,
        p.full_name AS matrixParentName,
        r.position AS matrixPosition,
        r.depth AS matrixDepth,
        (SELECT COUNT(*)
           FROM bga_referral_relationships x
          WHERE x.sponsor_id = u.id) AS directReferrals,
        (SELECT COUNT(*)
           FROM bga_referral_relationships x
           JOIN users invited ON invited.id = x.user_id
          WHERE x.sponsor_id = u.id
            AND invited.status = 'active'
            AND invited.email_verified = 1
        ) AS verifiedDirectReferrals,
        (SELECT COUNT(*)
           FROM bga_referral_relationships x
          WHERE x.matrix_parent_id = u.id) AS matrixChildren
      FROM users u
      JOIN bga_referral_codes c ON c.user_id = u.id
      LEFT JOIN bga_referral_relationships r ON r.user_id = u.id
      LEFT JOIN users s ON s.id = r.sponsor_id
      LEFT JOIN users p ON p.id = r.matrix_parent_id
      WHERE u.id = ?
      LIMIT 1
    `, [user.id]);

    if (!summary) {
      return res.status(404).json({
        success: false,
        message: 'Your referral code is not available yet.'
      });
    }

    return res.json({ success: true, data: { ...summary, referralCode } });
  } catch (error) {
    console.error('Referral summary failed:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not load your referral information.'
    });
  }
});


/* Baba Go Again extended social, media, public-profile and founder-admin features. */
require('./features').install(app, { db, authenticatedUser, frontendPath, referrals });

app.get('/dashboard', (req,res) => res.sendFile(path.join(frontendPath,'dashboard.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(frontendPath, 'profile.html')));
app.get('/referrals', (req, res) => res.sendFile(path.join(frontendPath, 'referrals.html')));

app.get('/community', (req, res) => res.sendFile(path.join(frontendPath, 'community.html')));

app.get('/api/community/feed', async (req, res) => {
  try {
    if (!await authenticatedUser(req, res)) return;
    const posts = await db.all(`SELECT p.id, p.user_id AS userId, p.body, p.created_at AS createdAt, u.full_name AS authorName,
      (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id) AS commentCount
      FROM community_posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 50`);
    res.json({ success: true, data: posts });
  } catch (e) { console.error('Feed read failed:', e); res.status(500).json({ success:false, message:'Could not load the community feed.' }); }
});

app.post('/api/community/posts', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res); if (!user) return;
    const body = inputText(req.body.body, 2000);
    if (!body) return res.status(400).json({ success:false, message:'Write something before publishing.' });
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    await db.run('INSERT INTO community_posts (id,user_id,body,created_at) VALUES (?,?,?,?)', [id,user.id,body,createdAt]);
    res.status(201).json({ success:true, data:{ id, body, createdAt, authorName:user.full_name, commentCount:0 } });
  } catch (e) { console.error('Post creation failed:',e); res.status(500).json({success:false,message:'Could not publish your post.'}); }
});


app.delete('/api/community/posts/:id', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const post = await db.get(
      'SELECT id,user_id AS userId FROM community_posts WHERE id=?',
      [req.params.id]
    );
    if (!post) return res.status(404).json({success:false,message:'Post not found.'});
    if (String(post.userId) !== String(user.id)) {
      return res.status(403).json({success:false,message:'You can only delete your own posts.'});
    }
    await db.transaction(async tx => {
      await tx.run('DELETE FROM post_comments WHERE post_id=?', [post.id]);
      await tx.run('DELETE FROM community_posts WHERE id=? AND user_id=?', [post.id,user.id]);
    });
    res.json({success:true,message:'Post and its comments deleted.'});
  } catch (e) {
    console.error('Post deletion failed:',e);
    res.status(500).json({success:false,message:'Could not delete post.'});
  }
});

app.delete('/api/community/comments/:id', async (req, res) => {
  try {
    const user = await authenticatedUser(req, res);
    if (!user) return;
    const comment = await db.get(
      'SELECT id,user_id AS userId FROM post_comments WHERE id=?',
      [req.params.id]
    );
    if (!comment) return res.status(404).json({success:false,message:'Comment not found.'});
    if (String(comment.userId) !== String(user.id)) {
      return res.status(403).json({success:false,message:'You can only delete your own comments.'});
    }
    await db.run('DELETE FROM post_comments WHERE id=? AND user_id=?', [comment.id,user.id]);
    res.json({success:true,message:'Comment deleted.'});
  } catch (e) {
    console.error('Comment deletion failed:',e);
    res.status(500).json({success:false,message:'Could not delete comment.'});
  }
});

app.get('/api/community/posts/:id/comments', async (req,res) => {
  try {
    if (!await authenticatedUser(req,res)) return;
    const post = await db.get('SELECT id FROM community_posts WHERE id=?',[req.params.id]);
    if (!post) return res.status(404).json({success:false,message:'Post not found.'});
    const data = await db.all(`SELECT c.id,c.user_id AS userId,c.body,c.created_at AS createdAt,u.full_name AS authorName FROM post_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.created_at ASC LIMIT 100`,[post.id]);
    res.json({success:true,data});
  } catch(e) { console.error('Comments read failed:',e); res.status(500).json({success:false,message:'Could not load comments.'}); }
});

app.post('/api/community/posts/:id/comments', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const post=await db.get('SELECT id,user_id AS userId FROM community_posts WHERE id=?',[req.params.id]);
    if(!post)return res.status(404).json({success:false,message:'Post not found.'});
    const body=inputText(req.body.body,1000); if(!body)return res.status(400).json({success:false,message:'Comment cannot be empty.'});
    const id=crypto.randomUUID(),createdAt=new Date().toISOString();
    await db.run('INSERT INTO post_comments (id,post_id,user_id,body,created_at) VALUES (?,?,?,?,?)',[id,post.id,user.id,body,createdAt]);
    if(post.userId!==user.id){
      try {
        await db.run("CREATE TABLE IF NOT EXISTS bga_notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'general',title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '/notifications',is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,read_at TEXT)");
        await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[crypto.randomUUID(),post.userId,'community','New comment from '+String(user.full_name||'A member').slice(0,100),body.slice(0,300),'/community',createdAt]);
      } catch(notificationError) { console.error('Community comment notification failed:',notificationError); }
    }
    res.status(201).json({success:true,data:{id,body,createdAt,authorName:user.full_name}});
  } catch(e) { console.error('Comment creation failed:',e); res.status(500).json({success:false,message:'Could not publish comment.'}); }
});

app.get('/api/community/groups', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const data=await db.all(`SELECT g.id,g.name,g.description,g.created_by AS creatorId,g.created_at AS createdAt,u.full_name AS creatorName,
      (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id) AS memberCount,
      EXISTS(SELECT 1 FROM group_members mine WHERE mine.group_id=g.id AND mine.user_id=?) AS joined
      FROM community_groups g JOIN users u ON u.id=g.created_by ORDER BY g.created_at DESC LIMIT 100`,[user.id]);
    res.json({success:true,data});
  } catch(e) { console.error('Groups read failed:',e); res.status(500).json({success:false,message:'Could not load groups.'}); }
});

app.post('/api/community/groups', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const name=inputText(req.body.name,80),description=inputText(req.body.description,500);
    if(name.length<3)return res.status(400).json({success:false,message:'Group name must be at least 3 characters.'});
    const id=crypto.randomUUID(),createdAt=new Date().toISOString();
    await db.transaction(async tx =>{await tx.run('INSERT INTO community_groups (id,name,description,created_by,created_at) VALUES (?,?,?,?,?)',[id,name,description,user.id,createdAt]);await tx.run('INSERT INTO group_members (group_id,user_id,joined_at) VALUES (?,?,?)',[id,user.id,createdAt]);});
    res.status(201).json({success:true,data:{id,name,description,createdAt,creatorName:user.full_name,memberCount:1,joined:1}});
  } catch(e) { console.error('Group creation failed:',e); res.status(500).json({success:false,message:'Could not create group.'}); }
});

app.post('/api/community/groups/:id/join', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const group=await db.get('SELECT id,name,created_by AS creatorId FROM community_groups WHERE id=?',[req.params.id]);
    if(!group)return res.status(404).json({success:false,message:'Group not found.'});
    const joinedAt=new Date().toISOString();
    const result=await db.run('INSERT IGNORE INTO group_members (group_id,user_id,joined_at) VALUES (?,?,?)',[group.id,user.id,joinedAt]);
    if(result.changes && String(group.creatorId)!==String(user.id)){
      try {
        await db.run("CREATE TABLE IF NOT EXISTS bga_notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'general',title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '/notifications',is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,read_at TEXT)");
        await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[crypto.randomUUID(),group.creatorId,'community','New group member','Someone joined your group: '+group.name.slice(0,100),'/community',joinedAt]);
      } catch(notificationError) { console.error('Group join notification failed:',notificationError); }
    }
    res.json({success:true,message:'You joined the group.'});
  } catch(e) { console.error('Group join failed:',e); res.status(500).json({success:false,message:'Could not join group.'}); }
});


app.post('/api/community/groups/:id/leave', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const group=await db.get('SELECT id,created_by AS createdBy FROM community_groups WHERE id=?',[req.params.id]);
    if(!group)return res.status(404).json({success:false,message:'Group not found.'});
    if(String(group.createdBy)===String(user.id))
      return res.status(400).json({success:false,message:'The group creator cannot leave their own group. Delete the group or transfer ownership first.'});
    const result=await db.run('DELETE FROM group_members WHERE group_id=? AND user_id=?',[group.id,user.id]);
    res.json({success:true,message:result.changes?'You left the group.':'You were not a member of this group.'});
  } catch(e) { console.error('Leave group failed:',e); res.status(500).json({success:false,message:'Could not leave group.'}); }
});

app.get('/api/community/events', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const data=await db.all(`SELECT e.id,e.title,e.description,e.location,e.starts_at AS startsAt,e.created_by AS creatorId,e.created_at AS createdAt,u.full_name AS creatorName,
      (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id=e.id) AS attendeeCount,
      EXISTS(SELECT 1 FROM event_attendees mine WHERE mine.event_id=e.id AND mine.user_id=?) AS attending
      FROM community_events e JOIN users u ON u.id=e.created_by ORDER BY e.starts_at ASC LIMIT 100`,[user.id]);
    res.json({success:true,data});
  } catch(e) { console.error('Events read failed:',e); res.status(500).json({success:false,message:'Could not load events.'}); }
});

app.post('/api/community/events', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const title=inputText(req.body.title,120),description=inputText(req.body.description,1000),location=inputText(req.body.location,200),startsAt=inputText(req.body.startsAt,40);
    const timestamp=Date.parse(startsAt);
    if(title.length<3 || !Number.isFinite(timestamp) || timestamp<=Date.now())return res.status(400).json({success:false,message:'Enter an event title and a future date/time.'});
    const id=crypto.randomUUID(),createdAt=new Date().toISOString(),iso=new Date(timestamp).toISOString();
    await db.run('INSERT INTO community_events (id,title,description,location,starts_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)',[id,title,description,location,iso,user.id,createdAt]);
    res.status(201).json({success:true,data:{id,title,description,location,startsAt:iso,createdAt,creatorName:user.full_name,attendeeCount:0,attending:0}});
  } catch(e) { console.error('Event creation failed:',e); res.status(500).json({success:false,message:'Could not create event.'}); }
});

app.post('/api/community/events/:id/attend', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const event=await db.get('SELECT id,title,starts_at,created_by AS creatorId FROM community_events WHERE id=?',[req.params.id]);
    if(!event)return res.status(404).json({success:false,message:'Event not found.'});
    if(Date.parse(event.starts_at)<=Date.now())return res.status(400).json({success:false,message:'This event has already started.'});
    const joinedAt=new Date().toISOString();
    const result=await db.run('INSERT IGNORE INTO event_attendees (event_id,user_id,joined_at) VALUES (?,?,?)',[event.id,user.id,joinedAt]);
    if(result.changes && String(event.creatorId)!==String(user.id)){
      try {
        await db.run("CREATE TABLE IF NOT EXISTS bga_notifications (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,type TEXT NOT NULL DEFAULT 'general',title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '/notifications',is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,read_at TEXT)");
        await db.run('INSERT INTO bga_notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',[crypto.randomUUID(),event.creatorId,'community','New event attendee','Someone registered for your event: '+event.title.slice(0,120),'/community',joinedAt]);
      } catch(notificationError) { console.error('Event attendance notification failed:',notificationError); }
    }
    res.json({success:true,message:'You are registered for this event.'});
  } catch(e) { console.error('Event attendance failed:',e); res.status(500).json({success:false,message:'Could not join event.'}); }
});


app.post('/api/community/events/:id/cancel-attendance', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const event=await db.get('SELECT id,starts_at AS startsAt FROM community_events WHERE id=?',[req.params.id]);
    if(!event)return res.status(404).json({success:false,message:'Event not found.'});
    if(Date.parse(event.startsAt)<=Date.now())return res.status(400).json({success:false,message:'Attendance cannot be cancelled after the event has started.'});
    const result=await db.run('DELETE FROM event_attendees WHERE event_id=? AND user_id=?',[event.id,user.id]);
    res.json({success:true,message:result.changes?'Your attendance has been cancelled.':'You were not registered for this event.'});
  } catch(e) { console.error('Cancel attendance failed:',e); res.status(500).json({success:false,message:'Could not cancel attendance.'}); }
});

app.delete('/api/community/events/:id', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const event=await db.get('SELECT id,created_by AS createdBy FROM community_events WHERE id=?',[req.params.id]);
    if(!event)return res.status(404).json({success:false,message:'Event not found.'});
    if(String(event.createdBy)!==String(user.id))
      return res.status(403).json({success:false,message:'You can only delete events you created.'});
    await db.transaction(async tx =>{
      await tx.run('DELETE FROM event_attendees WHERE event_id=?',[event.id]);
      await tx.run('DELETE FROM community_events WHERE id=? AND created_by=?',[event.id,user.id]);
    });
    res.json({success:true,message:'Your event was deleted.'});
  } catch(e) { console.error('Event deletion failed:',e); res.status(500).json({success:false,message:'Could not delete event.'}); }
});

app.post('/api/volunteers/apply', async (req,res) => {
  try {
    const user=await authenticatedUser(req,res); if(!user)return;
    const interests=inputText(req.body.interests,1000),availability=inputText(req.body.availability,300);
    if(interests.length<10)return res.status(400).json({success:false,message:'Describe your volunteer interests (at least 10 characters).'});
    const existing=await db.get('SELECT id FROM volunteer_applications WHERE user_id=?',[user.id]);
    if(existing)return res.status(409).json({success:false,message:'You have already submitted a volunteer application.'});
    const id=crypto.randomUUID(),createdAt=new Date().toISOString();
    await db.run('INSERT INTO volunteer_applications (id,user_id,interests,availability,created_at) VALUES (?,?,?,?,?)',[id,user.id,interests,availability,createdAt]);
    res.status(201).json({success:true,message:'Volunteer application submitted.',data:{id,state:'pending',createdAt}});
  } catch(e) { console.error('Volunteer application failed:',e); res.status(500).json({success:false,message:'Could not submit volunteer application.'}); }
});

/* Volunteer earnings ledger and OPay payouts. All ledger amounts are stored in kobo. */
function walletEncryptionKey() {
  const secret = String(process.env.WALLET_ENCRYPTION_KEY || '').trim();
  if (secret.length < 32) throw new Error('WALLET_ENCRYPTION_KEY must be set to a secret of at least 32 characters.');
  return crypto.createHash('sha256').update(secret).digest();
}
function encryptRecipient(value) {
  const key = walletEncryptionKey(), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
function decryptRecipient(value) {
  const [iv, tag, ciphertext] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', walletEncryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}
async function requireWalletAdmin(req, res) {
  const user = await authenticatedUser(req, res);
  if (!user) return null;

  try {
    const roles = await db.all(
      'SELECT role FROM bga_admin_roles WHERE user_id=?',
      [user.id]
    );

    const roleAllowed = roles.some(
      row => row.role === 'founder' || row.role === 'wallet_admin'
    );

    if (!roleAllowed) {
      res.status(403).json({
        success: false,
        message: 'Administrator access is required.'
      });
      return null;
    }

    return user;
  } catch (error) {
    console.error('[SECURITY] Wallet administrator role lookup failed:', error.message);
    res.status(503).json({
      success: false,
      message: 'Administrator permissions are temporarily unavailable.'
    });
    return null;
  }
}
async function walletBalanceKobo(userId) {
  const row = await db.get('SELECT COALESCE(SUM(amount_kobo),0) AS balance FROM wallet_transactions WHERE user_id=?', [userId]);
  return Number(row?.balance || 0);
}
async function refundPayoutIfNeeded(payoutId, adminId, reason) {
  return db.transaction(async tx => {
    const payout = await tx.get('SELECT * FROM wallet_payouts WHERE id=?', [payoutId]);
    if (!payout || !['pending','processing'].includes(payout.status)) return false;
    const changed = await tx.run("UPDATE wallet_payouts SET status='failed',failure_reason=?,updated_at=?,processed_by=? WHERE id=? AND status IN ('pending','processing')", [String(reason || 'Transfer failed').slice(0,300),new Date().toISOString(),adminId,payoutId]);
    if (!changed.changes) return false;
    const ref = `PAYOUT-REFUND-${payoutId}`;
    if (!await tx.get('SELECT id FROM wallet_transactions WHERE reference=?', [ref])) {
      await tx.run('INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,related_payout_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [crypto.randomUUID(),payout.user_id,'payout_refund',payout.amount_kobo,ref,'Refund for failed volunteer payout',payoutId,adminId,new Date().toISOString()]);
    }
    return true;
  });
}

app.get('/wallet', (req,res) => res.sendFile(path.join(frontendPath, 'wallet.html')));
app.get('/admin/wallet', (req,res) => res.sendFile(path.join(frontendPath, 'admin-wallet.html')));

app.get('/api/wallet/me', async (req,res) => {
  try {
    const user = await authenticatedUser(req,res); if (!user) return;
    let roles = []; try { roles = JSON.parse(user.roles_json || '[]'); } catch {}
    const appRow = await db.get("SELECT state FROM volunteer_applications WHERE user_id=?", [user.id]);
    if (!roles.includes('Volunteer') && appRow?.state !== 'approved') return res.status(403).json({success:false,message:'The earnings wallet is available to approved volunteers. Select Volunteer during registration or contact the coordination team.'});
    const balanceKobo = await walletBalanceKobo(user.id);
    const transactions = await db.all('SELECT id,type,amount_kobo AS amountKobo,reference,description,created_at AS createdAt FROM wallet_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50',[user.id]);
    const payouts = await db.all("SELECT id,amount_kobo AS amountKobo,recipient_type AS recipientType,status,opay_reference AS reference,opay_order_no AS providerOrderNo,failure_reason AS failureReason,requested_at AS requestedAt,updated_at AS updatedAt FROM wallet_payouts WHERE user_id=? ORDER BY requested_at DESC LIMIT 25",[user.id]);
    res.json({success:true,data:{balanceKobo,transactions,payouts,opayConfigured:opay.config().enabled}});
  } catch(e) { console.error('Wallet summary failed:',e.message); res.status(500).json({success:false,message:'Could not load volunteer wallet.'}); }
});

app.post('/api/wallet/payouts', async (req,res) => {
  try {
    const user = await authenticatedUser(req,res); if (!user) return;
    let roles = []; try { roles = JSON.parse(user.roles_json || '[]'); } catch {}
    const appRow = await db.get("SELECT state FROM volunteer_applications WHERE user_id=?", [user.id]);
    if (!roles.includes('Volunteer') && appRow?.state !== 'approved') return res.status(403).json({success:false,message:'Only registered or approved volunteers can request payouts.'});
    if (!process.env.WALLET_ENCRYPTION_KEY || process.env.WALLET_ENCRYPTION_KEY.trim().length < 32) return res.status(503).json({success:false,message:'Wallet payout security is not configured yet. Contact the administrator.'});
    const amountNaira = Number(req.body.amountNaira);
    if (!Number.isSafeInteger(amountNaira) || amountNaira < 100 || amountNaira > 5000000) return res.status(400).json({success:false,message:'Enter a whole-naira amount between ₦100 and ₦5,000,000.'});
    const recipientType = req.body.recipientType === 'opay_wallet' ? 'opay_wallet' : req.body.recipientType === 'bank' ? 'bank' : '';
    const recipientName = safeText(req.body.recipientName,100);
    if (!recipientName || !recipientType) return res.status(400).json({success:false,message:'Enter the recipient name and choose OPay wallet or bank transfer.'});
    let recipient;
    if (recipientType === 'opay_wallet') {
      let phone = safeText(req.body.phoneNumber,20).replace(/[\s()-]/g,'');
      if (/^0\d{10}$/.test(phone)) phone = '+234' + phone.slice(1);
      if (!/^\+234\d{10}$/.test(phone)) return res.status(400).json({success:false,message:'Enter a Nigerian mobile number, e.g. +2348012345678.'});
      recipient = {recipientName,phoneNumber:phone};
    } else {
      const bankCode = safeText(req.body.bankCode,20), bankAccountNumber = safeText(req.body.bankAccountNumber,20).replace(/\s/g,'');
      if (!/^[A-Za-z0-9_-]{2,12}$/.test(bankCode) || !/^\d{10}$/.test(bankAccountNumber)) return res.status(400).json({success:false,message:'Enter a valid bank code and 10-digit bank account number.'});
      recipient = {recipientName,bankCode,bankAccountNumber};
    }
    const encrypted = encryptRecipient(recipient), payoutId = crypto.randomUUID(), now = new Date().toISOString(), ref = 'BGA-' + payoutId.replace(/-/g,'').slice(0,24).toUpperCase();
    await db.transaction(async tx => {
      const row = await tx.get('SELECT COALESCE(SUM(amount_kobo),0) AS balance FROM wallet_transactions WHERE user_id=?', [user.id]);
      const balance = Number(row?.balance || 0), amountKobo = amountNaira * 100;
      if (balance < amountKobo) throw Object.assign(new Error('Your available volunteer balance is insufficient for this payout.'),{statusCode:400});
      await tx.run('INSERT INTO wallet_payouts (id,user_id,amount_kobo,recipient_type,recipient_name,recipient_data_encrypted,status,opay_reference,requested_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [payoutId,user.id,amountKobo,recipientType,recipientName,encrypted,'pending',ref,now,now]);
      await tx.run('INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,related_payout_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)', [crypto.randomUUID(),user.id,'payout_hold',-amountKobo,'PAYOUT-HOLD-'+payoutId,'Reserved for volunteer payout',payoutId,user.id,now]);
    });
    res.status(201).json({success:true,message:'Payout request submitted for administrator review.',data:{id:payoutId,amountNaira,recipientType,status:'pending',reference:ref}});
  } catch(e) { if (e.statusCode) return res.status(e.statusCode).json({success:false,message:e.message}); console.error('Payout request failed:',e.message); res.status(500).json({success:false,message:'Could not submit payout request.'}); }
});

app.get('/api/admin/wallet/members', async (req,res) => {
  try {
    const admin = await requireWalletAdmin(req,res); if (!admin) return;
    const q = safeText(req.query.q,100);
    if (q.length < 2) return res.json({success:true,data:[]});
    const like = '%' + q.replace(/[\\%_]/g,'') + '%';
    const data = await db.all("SELECT id,full_name AS name,email,phone,roles_json AS roles FROM users WHERE status='active' AND email_verified=1 AND (full_name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY full_name LIMIT 30",[like,like,like]);
    res.json({success:true,data:data.map(row=>({...row,roles:(()=>{try{return JSON.parse(row.roles||'[]')}catch{return []}})()}))});
  } catch(e) { console.error('Admin wallet member search failed:',e.message); res.status(500).json({success:false,message:'Could not search members.'}); }
});


async function sendBgaWalletNotification(userId, type, title, body) {
  try {
    await db.run(`CREATE TABLE IF NOT EXISTS bga_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'general',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '/notifications',
      is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, read_at TEXT
    )`);
    await db.run(
      'INSERT INTO bga_notifications (id,user_id,type,title,body,link,created_at) VALUES (?,?,?,?,?,?,?)',
      [crypto.randomUUID(), userId, type, title, body, '/wallet', new Date().toISOString()]
    );
  } catch (e) {
    console.error('Wallet notification failed:', e.message);
  }
}

app.post('/api/admin/wallet/credit', async (req,res) => {
  try {
    const admin = await requireWalletAdmin(req,res); if (!admin) return;
    const userId = safeText(req.body.userId,80), amountNaira = Number(req.body.amountNaira), description = safeText(req.body.description || 'Volunteer programme credit',200);
    if (!userId || !Number.isSafeInteger(amountNaira) || amountNaira < 1 || amountNaira > 5000000) return res.status(400).json({success:false,message:'Select a member and enter a credit between ₦1 and ₦5,000,000.'});
    const user = await db.get("SELECT id,roles_json FROM users WHERE id=? AND status='active' AND email_verified=1",[userId]);
    if (!user) return res.status(404).json({success:false,message:'Verified active member not found.'});
    const id = crypto.randomUUID(), now = new Date().toISOString(), reference = 'BGA-CREDIT-' + id.replace(/-/g,'').toUpperCase();
    await db.run('INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',[id,userId,'volunteer_credit',amountNaira*100,reference,description,admin.id,now]);
      await sendBgaWalletNotification(userId,'wallet','Wallet credited',`Your volunteer wallet was credited with ₦${amountNaira.toLocaleString()}.`);
    res.status(201).json({success:true,message:'Volunteer wallet credited.',data:{reference,amountNaira,balanceKobo:await walletBalanceKobo(userId)}});
  } catch(e) { console.error('Wallet credit failed:',e.message); res.status(500).json({success:false,message:'Could not credit volunteer wallet.'}); }
});

app.get('/api/admin/wallet/payouts', async (req,res) => {
  try {
    const admin = await requireWalletAdmin(req,res); if (!admin) return;
    const status = ['pending','processing','completed','failed','rejected'].includes(req.query.status) ? req.query.status : '';
    const sql = `SELECT p.id,p.user_id AS userId,p.amount_kobo AS amountKobo,p.recipient_type AS recipientType,p.recipient_name AS recipientName,p.status,p.opay_reference AS reference,p.opay_order_no AS providerOrderNo,p.failure_reason AS failureReason,p.requested_at AS requestedAt,u.full_name AS volunteerName,u.email AS volunteerEmail FROM wallet_payouts p JOIN users u ON u.id=p.user_id ${status ? 'WHERE p.status=?' : ''} ORDER BY p.requested_at DESC LIMIT 100`;
    const data = await db.all(sql,status ? [status] : []);
    res.json({success:true,data});
  } catch(e) { console.error('Payout queue failed:',e.message); res.status(500).json({success:false,message:'Could not load payout queue.'}); }
});

app.post('/api/admin/wallet/payouts/:id/reject', async (req,res) => {
  try {
    const admin = await requireWalletAdmin(req,res); if (!admin) return;
    const payout = await db.get('SELECT * FROM wallet_payouts WHERE id=?',[req.params.id]);
    if (!payout) return res.status(404).json({success:false,message:'Payout request not found.'});
    if (payout.status !== 'pending') return res.status(409).json({success:false,message:'Only pending payout requests can be rejected.'});
    await db.transaction(async tx => {
      const changed = await tx.run("UPDATE wallet_payouts SET status='rejected',failure_reason=?,updated_at=?,processed_by=? WHERE id=? AND status='pending'",[safeText(req.body.reason || 'Rejected by administrator',300),new Date().toISOString(),admin.id,payout.id]);
      if (!changed.changes) throw Object.assign(new Error('This payout is no longer pending.'), {statusCode:409});
      const refundRef = 'PAYOUT-REFUND-' + payout.id;
      if (!await tx.get('SELECT id FROM wallet_transactions WHERE reference=?',[refundRef])) await tx.run('INSERT INTO wallet_transactions (id,user_id,type,amount_kobo,reference,description,related_payout_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),payout.user_id,'payout_refund',payout.amount_kobo,refundRef,'Refund for rejected volunteer payout',payout.id,admin.id,new Date().toISOString()]);
    });
    await sendBgaWalletNotification(payout.user_id,'wallet','Payout rejected','Your payout request was rejected. The reserved balance has been returned to your wallet.');
      res.json({success:true,message:'Payout rejected and reserved balance returned to volunteer.'});
  } catch(e) { console.error('Payout rejection failed:',e.message); res.status(500).json({success:false,message:'Could not reject payout.'}); }
});

app.post('/api/admin/wallet/payouts/:id/approve', async (req,res) => {
  const admin = await requireWalletAdmin(req,res); if (!admin) return;
  const cfg = opay.config();
  if (!cfg.enabled) return res.status(503).json({success:false,message:'OPay payouts are not enabled. Configure approved OPay merchant credentials and set OPAY_PAYOUT_ENABLED=true before approving transfers.'});
  let payout;
  try {
    payout = await db.get('SELECT * FROM wallet_payouts WHERE id=?',[req.params.id]);
    if (!payout) return res.status(404).json({success:false,message:'Payout request not found.'});
    if (payout.status !== 'pending') return res.status(409).json({success:false,message:'This payout is no longer pending; do not submit it again.'});
    const claim = await db.run("UPDATE wallet_payouts SET status='processing',updated_at=?,processed_by=? WHERE id=? AND status='pending'",[new Date().toISOString(),admin.id,payout.id]);
    if (!claim.changes) return res.status(409).json({success:false,message:'Another administrator has already claimed this payout. Refresh the queue.'});
    const recipient = decryptRecipient(payout.recipient_data_encrypted);
    const amountNaira = payout.amount_kobo / 100;
    const response = await opay.createTransfer({reference:payout.opay_reference,amountNaira,recipientType:payout.recipient_type,recipientName:recipient.recipientName,phoneNumber:recipient.phoneNumber,bankCode:recipient.bankCode,bankAccountNumber:recipient.bankAccountNumber,reason:'Baba Go Again volunteer payout'});
    if (String(response.code) !== '00000') {
      await refundPayoutIfNeeded(payout.id,admin.id,String(response.message || 'OPay rejected transfer'));
      return res.status(502).json({success:false,message:'OPay rejected the transfer. The held balance was returned.',providerCode:String(response.code || ''),providerMessage:String(response.message || '').slice(0,160)});
    }
    const orderNo = safeText(response.data?.orderNo || response.data?.orderNumber || '',100) || null;
    await db.run("UPDATE wallet_payouts SET opay_order_no=?,updated_at=? WHERE id=? AND status='processing'",[orderNo,new Date().toISOString(),payout.id]);
    res.json({success:true,message:'OPay accepted the transfer request. It remains processing until its final status is confirmed.',data:{reference:payout.opay_reference,providerOrderNo:orderNo,status:'processing'}});
  } catch(e) {
    console.error('OPay payout submission uncertain:',e.message);
    // Do not refund or retry after a network timeout: OPay may have accepted the transfer.
    res.status(502).json({success:false,message:'Transfer outcome is uncertain. The payout remains processing to prevent duplicate payment. Reconcile with OPay before any retry.'});
  }
});

app.post('/api/admin/wallet/payouts/:id/check-status', async (req,res) => {
  const admin = await requireWalletAdmin(req,res); if (!admin) return;
  try {
    const payout = await db.get('SELECT * FROM wallet_payouts WHERE id=?',[req.params.id]);
    if (!payout) return res.status(404).json({success:false,message:'Payout request not found.'});
    if (payout.status !== 'processing') return res.status(409).json({success:false,message:'Only processing payouts can be checked.'});
    if (!payout.opay_order_no) return res.status(409).json({success:false,message:'OPay has not returned an order number. Reconcile by reference with OPay support; do not retry this transfer automatically.'});
    const response = await opay.queryTransfer({reference:payout.opay_reference,orderNo:payout.opay_order_no,recipientType:payout.recipient_type});
    if (String(response.code) !== '00000') return res.status(502).json({success:false,message:'OPay status query did not succeed. The payout remains processing.'});
    const status = String(response.data?.status || response.data?.orderStatus || '').toUpperCase();
    if (['SUCCESS','SUCCESSFUL','COMPLETED'].includes(status)) {
      await db.run("UPDATE wallet_payouts SET status='completed',failure_reason=NULL,updated_at=?,processed_by=? WHERE id=? AND status='processing'",[new Date().toISOString(),admin.id,payout.id]);
      await sendBgaWalletNotification(payout.user_id,'wallet','Payout completed','OPay confirmed that your payout was successful.');
      return res.json({success:true,message:'OPay confirmed the payout as successful.',data:{status:'completed'}});
    }
    if (['FAIL','FAILED','CANCEL','CANCELLED','REJECTED'].includes(status)) {
      await refundPayoutIfNeeded(payout.id,admin.id,String(response.data?.errorMsg || response.data?.message || 'OPay reported a failed transfer'));
      await sendBgaWalletNotification(payout.user_id,'wallet','Payout failed','The payout failed. The held balance has been returned to your wallet.');
      return res.json({success:true,message:'OPay reported a failed payout; the held balance was returned.',data:{status:'failed'}});
    }
    res.json({success:true,message:'OPay has not confirmed a final status. The payout remains processing.',data:{providerStatus:status || 'UNKNOWN',status:'processing'}});
  } catch(e) { console.error('OPay status check failed:',e.message); res.status(502).json({success:false,message:'Could not confirm the payout status. Do not retry the transfer.'}); }
});

/* Nigeria electoral geography directory: package-backed endpoints. */
const nigeriaGeo = require('nigeria-inec-geo');

const locationStates = nigeriaGeo.states();
const locationLgas = nigeriaGeo.lgas();
const locationWards = nigeriaGeo.wards();
const locationPollingUnits = nigeriaGeo.pollingUnits();

app.get('/api/locations/states', (req, res) => {
  const data = locationStates.map(s => ({
    id: s.portal_id,
    code: s.code,
    name: s.name === 'FCT' ? 'ABUJA (FCT)' : s.name
  })).sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data });
});

app.get('/api/locations/lgas', (req, res) => {
  const stateId = String(req.query.state || '');
  const state = locationStates.find(s => s.portal_id === stateId);

  if (!state) {
    return res.status(400).json({
      success: false,
      message: 'Select a valid state.'
    });
  }

  const data = locationLgas
    .filter(lga => lga.state_portal_id === state.portal_id)
    .map(lga => ({
      id: lga.portal_id,
      code: lga.code,
      name: lga.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data });
});

app.get('/api/locations/wards', (req, res) => {
  const lgaId = String(req.query.lga || '');
  const lga = locationLgas.find(item => item.portal_id === lgaId);

  if (!lga) {
    return res.status(400).json({
      success: false,
      message: 'Select a valid local government area.'
    });
  }

  const data = locationWards
    .filter(ward => ward.lga_portal_id === lga.portal_id)
    .map(ward => ({
      id: ward.portal_id,
      code: ward.code,
      name: ward.name
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data });
});

app.get('/api/locations/polling-units', (req, res) => {
  const stateCode = String(req.query.state || '');
  const lgaCode = String(req.query.lga || '');
  const wardCode = String(req.query.ward || '');

  if (
    !/^\d{2}$/.test(stateCode) ||
    !/^\d{2}$/.test(lgaCode) ||
    !/^\d{2}$/.test(wardCode)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid state, LGA, and ward codes are required.'
    });
  }

  const state = locationStates.find(item => item.code === stateCode);
  if (!state) {
    return res.status(400).json({
      success: false,
      message: 'Invalid state code.'
    });
  }

  const lga = locationLgas.find(item =>
    item.state_code === stateCode && item.code === lgaCode
  );

  if (!lga) {
    return res.status(400).json({
      success: false,
      message: 'The selected LGA does not belong to this state.'
    });
  }

  const ward = locationWards.find(item =>
    item.state_code === stateCode &&
    item.lga_code === lgaCode &&
    item.code === wardCode
  );

  if (!ward) {
    return res.status(400).json({
      success: false,
      message: 'The selected ward does not belong to this LGA.'
    });
  }

  const data = locationPollingUnits
    .filter(unit =>
      unit.state_code === stateCode &&
      unit.lga_code === lgaCode &&
      unit.ward_code === wardCode
    )
    .map(unit => ({
      id: unit.portal_id,
      code: unit.code,
      name: unit.name,
      location: unit.location || '',
      fullCode: unit.full_code
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Resource not found'
  });
});


const PORT = Number(process.env.PORT) || 5000;

if (process.env.NODE_ENV === 'production') {
  const secret = String(process.env.SESSION_SECRET || '');

  if (secret.length < 32 ||
      secret === 'CHANGE_THIS_SESSION_SECRET_BEFORE_PUBLIC_DEPLOYMENT') {
    console.error('FATAL: Production requires a unique SESSION_SECRET of at least 32 characters.');
    process.exit(1);
  }

  if (process.env.COOKIE_SECURE !== 'true') {
    console.error('FATAL: Production requires COOKIE_SECURE=true behind HTTPS.');
    process.exit(1);
  }
}

let server;
let shuttingDown = false;

async function start() {
  try {
    console.log('[MYSQL HOST CHECK]', JSON.stringify(process.env.MYSQL_HOST), 'length=', (process.env.MYSQL_HOST || '').length);
      try {
        console.log('[MYSQL DNS CHECK]', await require('dns').promises.lookup(process.env.MYSQL_HOST));
      } catch (e) {
        console.error('[MYSQL DNS CHECK FAILED]', e.code);
      }
      console.log('[STARTUP 1] Testing MySQL connection...');
    await initializeCoreSchema(db);
    console.log('[STARTUP] Core MySQL account schema verified.');
    await db.ready();
    console.log('[STARTUP 2] MySQL connection successful.');
    console.log('[DATABASE] MySQL connection verified.');
    console.log('[STARTUP 3] Checking database identity...');
    const identity = await db.get(
      'SELECT DATABASE() AS databaseName, @@hostname AS serverName'
    );

    console.log('[STARTUP 4] Checking founder account...');
    const account = await db.get(
      `SELECT id, email, email_verified, status
       FROM users
       WHERE LOWER(email) = LOWER(?)
       LIMIT 1`,
      ['babagoagain@gmail.com']
    );

    console.log('[DATABASE IDENTITY]', identity);

    console.log('[FOUNDER ACCOUNT CHECK]', {
      found: Boolean(account),
      emailVerified: account ? Boolean(account.email_verified) : null,
      status: account ? account.status : null
    });


    console.log('[STARTUP 5] Opening HTTP server...');
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log('================================');
      console.log('BABA GO AGAIN BACKEND');
      console.log(`Port: ${PORT}`);
      console.log(`Frontend: ${frontendPath}`);
      console.log('Database: MySQL READY');
      console.log('================================');
    });

    server.on('error', error => {
      console.error('[SERVER] Startup error:', error.message);
      process.exitCode = 1;
    });

  } catch (error) {
    console.error('[DATABASE] Startup failed:', error.message);
    await db.close().catch(() => {});
    process.exitCode = 1;
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[SHUTDOWN] Received ${signal}`);

  try {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }

    await db.close();
    console.log('[SHUTDOWN] Database connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('[SHUTDOWN] Error:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();