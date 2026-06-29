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

// ---------- 数据库连接 ----------
mongoose.connect('mongodb+srv://wangyuan8298_db_user:yyqLMYEX2H1c8Fld@cluster0.wynlgs.mongodb.net/?appName=Cluster0')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB连接失败:', err));

// ---------- 用户模型 ----------
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  is_active: { type: Boolean, default: true },
  expire_time: { type: Date, default: null },
  created_at: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// ---------- 注册接口 ----------
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashed });
    await user.save();
    res.json({ message: '注册成功' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 登录接口 ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: '用户不存在' });

    if (!user.is_active) {
      return res.status(403).json({ error: '账号已被禁用，请联系管理员' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: '密码错误' });

    const token = jwt.sign(
      { userId: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ message: '登录成功', username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 验证登录状态 ----------
app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: '未登录' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    if (!user.is_active) return res.status(403).json({ error: '账号已禁用' });

    res.json({ username: user.username });
  } catch (err) {
    res.status(401).json({ error: '登录已过期' });
  }
});

// ---------- 退出登录 ----------
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: '已退出' });
});

// ---------- 管理员禁用用户 ----------
app.post('/api/admin/disable', async (req, res) => {
  const { username } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: '用户不存在' });
    user.is_active = false;
    await user.save();
    res.json({ message: `用户 ${username} 已禁用` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 启动服务 ----------
app.listen(PORT, () => console.log(`服务器运行在端口 ${PORT}`));
