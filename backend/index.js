require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(cookieParser());
app.use(cors({
  origin: ['http://localhost:5500', 'https://lottery-login.vercel.app', 'https://lottery-login-38xg.vercel.app'],
  credentials: true
}));

// ---------- 数据库连接（硬编码正确连接串） ----------
const MONGODB_URI = process.env.MONGODB_URI;
const opts = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 10000,
};
mongoose.connect(MONGO_URI, opts)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB连接失败:', err));

// ---------- 用户模型 ----------
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  is_active: { type: Boolean, default: true },
  is_admin: { type: Boolean, default: false },
  expire_time: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
  last_login: { type: Date, default: null }
});
const User = mongoose.model('User', UserSchema);

// ---------- 初始化管理员 ----------
(async function initAdmin() {
  try {
    const adminUser = 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'Admin@123';
    const existing = await User.findOne({ username: adminUser });
    if (!existing) {
      const hashed = await bcrypt.hash(adminPass, 10);
      await new User({ username: adminUser, password: hashed, is_admin: true }).save();
      console.log('✅ 管理员已创建 (用户名: admin)');
    } else if (!existing.is_admin) {
      existing.is_admin = true;
      await existing.save();
      console.log('✅ 已升级 admin 为管理员');
    }
  } catch (e) { console.error('初始化管理员失败:', e); }
})();

// ---------- 注册 ----------
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === 'admin') return res.status(400).json({ error: '该用户名不可用' });
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: '用户名已存在' });
    const hashed = await bcrypt.hash(password, 10);
    await new User({ username, password: hashed }).save();
    res.json({ message: '注册成功' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 登录 ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (!user.is_active) return res.status(403).json({ error: '账号已被禁用' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: '密码错误' });
    user.last_login = new Date();
    await user.save();
    const token = jwt.sign(
      { userId: user._id, username: user.username, role: user.is_admin ? 'admin' : 'user' },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '7d' }
    );
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    res.json({ message: '登录成功', username: user.username, isAdmin: user.is_admin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 验证登录 ----------
app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登录' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (!user.is_active) return res.status(403).json({ error: '账号已禁用' });
    res.json({ username: user.username, isAdmin: user.is_admin || false });
  } catch (err) {
    res.status(401).json({ error: '登录已过期' });
  }
});

// ---------- 退出 ----------
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: '已退出' });
});

// ---------- 管理员接口 ----------
async function adminAuth(req, res, next) {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登录' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    if (decoded.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: '登录已过期' });
  }
}

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/toggle-status', adminAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: '缺少用户名' });
    if (username === 'admin') return res.status(403).json({ error: '不能修改管理员状态' });
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    user.is_active = !user.is_active;
    await user.save();
    res.json({ message: `用户 ${username} 已${user.is_active ? '启用' : '禁用'}`, is_active: user.is_active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 启动 ----------
app.listen(PORT, () => console.log(`🚀 服务器运行在端口 ${PORT}`));
