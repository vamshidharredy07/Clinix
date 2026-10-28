require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey123!';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

mongoose.set('bufferCommands', false);

async function connectDB() {
  try {
    const dbUri = process.env.MONGO_URI;
    console.log(`[DB] Attempting connection with URI starting with: ${dbUri ? dbUri.substring(0, 20) : 'UNDEFINED'}`);
    await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 5000 });
    console.log(`[DB] ${process.env.INSTANCE_ID || 'local'}: Connected successfully!`);
  } catch (err) {
    console.error(`[DB] ${process.env.INSTANCE_ID || 'local'}: Connection error:`, err.message);
  }
}
connectDB();

// --- USER SCHEMA ---
const UserSchema = new mongoose.Schema({
  username:     { type: String, required: true, unique: true },
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['doctor', 'nurse', 'admin'], default: 'nurse' },
  totpSecret:   { type: String, default: '' },
  is2FAEnabled: { type: Boolean, default: false }
});

UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const User = mongoose.model('User', UserSchema);

// --- HEALTH LOG SCHEMA ---
const HealthLogSchema = new mongoose.Schema({
  patientName: { type: String, required: true },
  metricType:  { type: String, required: true },
  value:       { type: String, required: true },
  unit:        { type: String, required: true },
  notes:       { type: String, default: '' },
  date:        { type: Date, default: Date.now }
});

const HealthLog = mongoose.model('HealthLog', HealthLogSchema);

// --- JWT & RBAC MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied: No token provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

const authorizeRoles = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied: Action requires role [${allowedRoles.join(', ')}]` });
    }
    next();
  };
};

// --- AUTHENTICATION APIS ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    const newUser = new User({ username, email, password, role });
    await newUser.save();
    res.status(201).json({ message: 'User registered successfully', userId: newUser._id, role: newUser.role });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '1h' });

    res.json({
      message: 'Login successful',
      token,
      role: user.role,
      is2FAEnabled: user.is2FAEnabled
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TOTP 2FA APIS ---
app.post('/api/auth/2fa/setup', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const secret = speakeasy.generateSecret({ name: `ClinixEHR:${email}` });
    user.totpSecret = secret.base32;
    await user.save();

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({ message: '2FA setup initiated', secret: secret.base32, qrCodeUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/2fa/verify', async (req, res) => {
  try {
    const { email, token } = req.body;
    const user = await User.findOne({ email });
    if (!user || !user.totpSecret) return res.status(400).json({ error: '2FA not setup' });

    const isValid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token
    });
    if (!isValid) return res.status(400).json({ error: 'Invalid 2FA Token' });

    user.is2FAEnabled = true;
    await user.save();

    res.json({ message: '2FA verified and enabled successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- HEALTH LOG APIS (Protected with RBAC) ---
app.get('/api/logs', async (req, res) => {
  try {
    console.log(`[API Hit] Request served by instance: ${process.env.INSTANCE_ID || 'local'}`);
    const logs = await HealthLog.find().sort({ date: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logs', async (req, res) => {
  try {
    const newLog = new HealthLog(req.body);
    const savedLog = await newLog.save();
    res.status(201).json(savedLog);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/logs/:id', authenticateToken, authorizeRoles('doctor'), async (req, res) => {
  try {
    const updatedLog = await HealthLog.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!updatedLog) return res.status(404).json({ error: 'Record not found' });
    res.json(updatedLog);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/logs/:id', authenticateToken, authorizeRoles('doctor'), async (req, res) => {
  try {
    const deletedLog = await HealthLog.findByIdAndDelete(req.params.id);
    if (!deletedLog) return res.status(404).json({ error: 'Record not found' });
    res.json({ message: 'Record deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (Instance: ${process.env.INSTANCE_ID || 'local'})`);
});