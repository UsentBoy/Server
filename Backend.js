const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000; // Vercel auto sets PORT

// Configuration with Environment Variables
const botToken = process.env.BOT_TOKEN; // Must be set in Vercel Environment Variables
if (!botToken) {
    throw new Error('BOT_TOKEN environment variable is not set');
}
const adminId = 7414451693;
const adReward = 15;
const extraReward = 20;
const dailyAdLimit = 20;
const minBalance = 1000;
const minReferrals = 10;

let users = {};
let pendingWithdrawals = [];

app.use(cors());
app.use(bodyParser.json());

// Function to validate Telegram initData
function validateInitData(initData) {
    const data = new URLSearchParams(initData);
    const hash = data.get('hash');
    data.delete('hash');
    const keys = Array.from(data.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${data.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculatedHash !== hash) {
        throw new Error('Invalid initData');
    }
    const userStr = data.get('user');
    if (!userStr) throw new Error('No user in initData');
    return JSON.parse(userStr);
}

// Middleware to authenticate requests
async function auth(req, res, next) {
    try {
        const { initData } = req.body;
        if (!initData) return res.status(401).json({ error: 'No initData' });
        req.user = validateInitData(initData);
        next();
    } catch (err) {
        res.status(401).json({ error: err.message });
    }
}

app.post('/api/user/register', auth, async (req, res) => {
    const userId = req.user.id.toString();
    const profileName = req.user.username ? `@${req.user.username}` : req.user.first_name;
    const startParam = req.body.startParam;

    if (!users[userId]) {
        users[userId] = {
            name: profileName,
            balance: 0,
            referrals: 0,
            adViewsToday: 0,
            lastAdDay: '',
            extraClaimed: false,
            blocked: false
        };

        if (startParam && users[startParam] && startParam !== userId) {
            users[startParam].referrals += 1;
        }
    } else {
        users[userId].name = profileName;
    }

    const userData = users[userId];
    const today = new Date().toDateString();
    if (userData.lastAdDay !== today) {
        userData.adViewsToday = 0;
        userData.lastAdDay = today;
    }

    res.json({
        user: userData,
        isAdmin: parseInt(userId) === adminId
    });
});

app.post('/api/user/earn/ad', auth, async (req, res) => {
    const userId = req.user.id.toString();
    const userData = users[userId];
    if (!userData || userData.blocked) return res.status(403).json({ error: 'Access denied' });

    const today = new Date().toDateString();
    if (userData.lastAdDay !== today) {
        userData.adViewsToday = 0;
        userData.lastAdDay = today;
    }
    if (userData.adViewsToday >= dailyAdLimit) return res.status(400).json({ error: 'Daily limit reached' });

    userData.balance += adReward;
    userData.adViewsToday += 1;

    res.json({ user: userData });
});

app.post('/api/user/earn/extra', auth, async (req, res) => {
    const userId = req.user.id.toString();
    const userData = users[userId];
    if (!userData || userData.blocked) return res.status(403).json({ error: 'Access denied' });
    if (userData.extraClaimed) return res.status(400).json({ error: 'Already claimed' });

    userData.extraClaimed = true;
    userData.balance += extraReward;

    res.json({ user: userData });
});

app.post('/api/user/withdraw', auth, async (req, res) => {
    const userId = req.user.id.toString();
    const userData = users[userId];
    if (!userData || userData.blocked) return res.status(403).json({ error: 'Access denied' });
    if (userData.balance < minBalance || userData.referrals < minReferrals) {
        return res.status(400).json({ error: 'Requirements not met' });
    }

    const { method, details, amount } = req.body;
    if (!method || !details || !amount || amount > userData.balance || amount <= 0) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    userData.balance -= amount;
    const withdrawal = {
        userId,
        name: userData.name,
        method,
        details,
        amount,
        date: new Date().toISOString()
    };
    pendingWithdrawals.push(withdrawal);

    const text = `Withdrawal request from ${userData.name} (${userId}):\nMethod: ${method}\nDetails: ${details}\nAmount: ${amount} BDT`;
    try {
        const apiRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${adminId}&text=${encodeURIComponent(text)}`);
        const apiData = await apiRes.json();
        if (!apiData.ok) throw new Error(apiData.description);
    } catch (err) {
        userData.balance += amount;
        pendingWithdrawals.pop();
        return res.status(500).json({ error: 'Failed to notify admin: ' + err.message });
    }

    res.json({ user: userData });
});

app.post('/api/admin/data', auth, async (req, res) => {
    const userId = req.user.id.toString();
    if (parseInt(userId) !== adminId) return res.status(403).json({ error: 'Not admin' });

    res.json({
        users,
        pendingWithdrawals,
        adminId
    });
});

app.post('/api/admin/block', auth, async (req, res) => {
    const userId = req.user.id.toString();
    if (parseInt(userId) !== adminId) return res.status(403).json({ error: 'Not admin' });

    const targetId = req.body.userId;
    if (!users[targetId]) return res.status(404).json({ error: 'User not found' });
    users[targetId].blocked = true;

    res.json({ success: true });
});

app.post('/api/admin/reject-withdrawal', auth, async (req, res) => {
    const userId = req.user.id.toString();
    if (parseInt(userId) !== adminId) return res.status(403).json({ error: 'Not admin' });

    const index = req.body.index;
    if (index < 0 || index >= pendingWithdrawals.length) return res.status(400).json({ error: 'Invalid index' });
    pendingWithdrawals.splice(index, 1);

    res.json({ success: true });
});

// Export for Vercel
module.exports = app;
