/**
 * HPTI API - Vercel Serverless Function
 * Catch-all handler for all /api/* routes
 * Zero external dependencies (built-in modules only)
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = '/tmp/hpti-data';
const DATA_FILE = path.join(DATA_DIR, 'store.json');

// In-memory cache (persists across warm invocations)
let _cache = null;

// ==================== Data Layer ====================
function getData() {
    if (_cache) return _cache;
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(DATA_FILE)) {
            _cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
            return _cache;
        }
    } catch (e) { /* fall through to default */ }
    _cache = { password: 'admin', config: null, results: [] };
    return _cache;
}

function saveData(data) {
    _cache = data;
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    } catch (e) {
        // /tmp write failed, cache-only mode
    }
}

// ==================== Helpers ====================
function sendJSON(res, status, data) {
    try {
        const body = JSON.stringify(data);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
        res.statusCode = status;
        res.end(body);
    } catch (e) {
        // response already sent or connection closed
    }
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 5e6) { body = ''; req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
        req.on('error', () => resolve({}));
    });
}

function checkAuth(req, data) {
    const pwd = req.headers['x-admin-password'];
    return pwd && pwd === data.password;
}

// ==================== API Handlers ====================
async function handleApi(req, res, pathname, method) {
    const data = getData();

    // ---- POST /api/submit (public) ----
    if (method === 'POST' && pathname === '/api/submit') {
        const body = await readBody(req);
        if (!body.personalityCode || !body.personalityName) {
            sendJSON(res, 400, { error: '缺少必填字段' });
            return;
        }
        const result = {
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            userCode: body.userCode || '',
            personalityCode: body.personalityCode,
            personalityName: body.personalityName,
            personalityEmoji: body.personalityEmoji || '',
            matchPercent: body.matchPercent || 0,
            rarity: body.rarity || '',
            timestamp: new Date().toISOString(),
        };
        data.results.push(result);
        if (data.results.length > 50000) {
            data.results = data.results.slice(-50000);
        }
        saveData(data);
        sendJSON(res, 200, { success: true, id: result.id });
        return;
    }

    // ---- GET /api/config (public) ----
    if (method === 'GET' && pathname === '/api/config') {
        sendJSON(res, 200, { config: data.config });
        return;
    }

    // ---- PUT /api/config (auth) ----
    if (method === 'PUT' && pathname === '/api/config') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const body = await readBody(req);
        data.config = {
            questions: body.questions || [],
            personalities: body.personalities || [],
            rarityInfo: body.rarityInfo || {}
        };
        saveData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- POST /api/login (public) ----
    if (method === 'POST' && pathname === '/api/login') {
        const body = await readBody(req);
        if (body.password === data.password) {
            sendJSON(res, 200, { success: true });
        } else {
            sendJSON(res, 401, { success: false, error: '密码错误' });
        }
        return;
    }

    // ---- GET /api/results (auth) ----
    if (method === 'GET' && pathname === '/api/results') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const results = data.results.slice().reverse();
        sendJSON(res, 200, { results, total: results.length });
        return;
    }

    // ---- GET /api/stats (auth) ----
    if (method === 'GET' && pathname === '/api/stats') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const results = data.results;
        const stats = {
            total: results.length,
            byRarity: { common: 0, rare: 0, epic: 0, legendary: 0 },
            byPersonality: {},
            byCode: {},
            recent: results.slice(-20).reverse(),
        };
        results.forEach(r => {
            if (r.rarity && stats.byRarity[r.rarity] !== undefined) stats.byRarity[r.rarity]++;
            const pKey = (r.personalityEmoji || '') + ' ' + r.personalityCode + ' ' + r.personalityName;
            stats.byPersonality[pKey] = (stats.byPersonality[pKey] || 0) + 1;
            stats.byCode[r.personalityCode] = (stats.byCode[r.personalityCode] || 0) + 1;
        });
        const topP = Object.entries(stats.byPersonality).sort((a, b) => b[1] - a[1])[0];
        if (topP) stats.topPersonality = { name: topP[0].trim(), count: topP[1] };
        const today = new Date().toISOString().slice(0, 10);
        stats.todayCount = results.filter(r => r.timestamp && r.timestamp.startsWith(today)).length;
        stats.trend = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const ds = d.toISOString().slice(0, 10);
            stats.trend.push({
                date: ds,
                count: results.filter(r => r.timestamp && r.timestamp.startsWith(ds)).length
            });
        }
        stats.avgMatch = results.length > 0
            ? Math.round(results.reduce((s, r) => s + (r.matchPercent || 0), 0) / results.length)
            : 0;
        sendJSON(res, 200, stats);
        return;
    }

    // ---- DELETE /api/results (auth) ----
    if (method === 'DELETE' && pathname === '/api/results') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        data.results = [];
        saveData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- POST /api/password (auth) ----
    if (method === 'POST' && pathname === '/api/password') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const body = await readBody(req);
        if (!body.newPassword) { sendJSON(res, 400, { error: '请输入新密码' }); return; }
        data.password = body.newPassword;
        saveData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- GET /api/export (auth) ----
    if (method === 'GET' && pathname === '/api/export') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        sendJSON(res, 200, data);
        return;
    }

    // ---- POST /api/import (auth) ----
    if (method === 'POST' && pathname === '/api/import') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const body = await readBody(req);
        if (body.password) data.password = body.password;
        if (body.config) data.config = body.config;
        if (body.results) data.results = body.results;
        saveData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- GET /api/health (public) ----
    if (method === 'GET' && pathname === '/api/health') {
        sendJSON(res, 200, { status: 'ok', total: data.results.length });
        return;
    }

    // ---- 404 ----
    sendJSON(res, 404, { error: 'Not Found' });
}

// ==================== Vercel Entry Point ====================
module.exports = async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        sendJSON(res, 204, {});
        return;
    }

    // Parse pathname from req.url (works in all Vercel runtimes)
    let pathname = '/api/';
    try {
        const parsed = new URL(req.url, 'http://localhost');
        pathname = parsed.pathname;
    } catch (e) {
        // fallback: extract path manually
        const rawUrl = req.url || '';
        pathname = rawUrl.split('?')[0];
    }

    try {
        await handleApi(req, res, pathname, req.method);
    } catch (e) {
        console.error('API Error:', e);
        sendJSON(res, 500, { error: '服务器内部错误' });
    }
};
