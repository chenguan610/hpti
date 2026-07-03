/**
 * HPTI Backend Server
 * Zero-dependency Node.js server (built-in modules only)
 * Serves static files + REST API for test results & config management
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
};

// ==================== Data Layer ====================
function initData() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            password: 'admin',
            config: null,
            results: []
        }, null, 2));
    }
}

function readData() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) {
        return { password: 'admin', config: null, results: [] };
    }
}

function writeData(data) {
    // Atomic write: write to temp then rename
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

// ==================== Helpers ====================
function sendJSON(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 5e6) { body = ''; req.destroy(); } });
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });
}

function checkAuth(req, data) {
    const pwd = req.headers['x-admin-password'];
    return pwd && pwd === data.password;
}

function serveStatic(req, res, pathname) {
    let filePath = path.join(PUBLIC_DIR, pathname);
    if (pathname === '/' || pathname === '') {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    // Security: prevent directory traversal
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            // Fallback to index.html for SPA-like behavior
            if (ext === '' || ext === '.html') {
                fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
                    if (e2) { res.writeHead(404); res.end('Not Found'); }
                    else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d2); }
                });
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        } else {
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
            res.end(data);
        }
    });
}

// ==================== API Handlers ====================
async function handleApi(req, res, pathname, method) {
    const data = readData();

    // ---- POST /api/submit (public) ----
    if (method === 'POST' && pathname === '/api/submit') {
        const body = await readBody(req);
        // Basic validation
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
        // Keep max 50000 results
        if (data.results.length > 50000) {
            data.results = data.results.slice(-50000);
        }
        writeData(data);
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
        writeData(data);
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
        // Support pagination via query params
        const url = new URL(req.url, `http://${req.headers.host}`);
        const page = parseInt(url.searchParams.get('page')) || 1;
        const perPage = parseInt(url.searchParams.get('perPage')) || 0; // 0 = all
        const results = data.results.slice().reverse(); // newest first
        if (perPage > 0) {
            const start = (page - 1) * perPage;
            sendJSON(res, 200, {
                results: results.slice(start, start + perPage),
                total: results.length,
                page,
                perPage,
            });
        } else {
            sendJSON(res, 200, { results, total: results.length });
        }
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
            if (stats.byRarity[r.rarity] !== undefined) stats.byRarity[r.rarity]++;
            const pKey = (r.personalityEmoji || '') + ' ' + r.personalityCode + ' ' + r.personalityName;
            stats.byPersonality[pKey] = (stats.byPersonality[pKey] || 0) + 1;
            stats.byCode[r.personalityCode] = (stats.byCode[r.personalityCode] || 0) + 1;
        });
        // Top personality
        const topP = Object.entries(stats.byPersonality).sort((a, b) => b[1] - a[1])[0];
        if (topP) stats.topPersonality = { name: topP[0].trim(), count: topP[1] };
        // Today's count
        const today = new Date().toISOString().slice(0, 10);
        stats.todayCount = results.filter(r => r.timestamp.startsWith(today)).length;
        // Last 7 days trend
        stats.trend = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const ds = d.toISOString().slice(0, 10);
            stats.trend.push({
                date: ds,
                count: results.filter(r => r.timestamp.startsWith(ds)).length
            });
        }
        // Match percent distribution
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
        writeData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- POST /api/password (auth) ----
    if (method === 'POST' && pathname === '/api/password') {
        if (!checkAuth(req, data)) { sendJSON(res, 401, { error: '未授权' }); return; }
        const body = await readBody(req);
        if (!body.newPassword) { sendJSON(res, 400, { error: '请输入新密码' }); return; }
        data.password = body.newPassword;
        writeData(data);
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
        writeData(data);
        sendJSON(res, 200, { success: true });
        return;
    }

    // ---- GET /api/health (public, for Render health check) ----
    if (method === 'GET' && pathname === '/api/health') {
        const stats = { total: data.results.length, uptime: process.uptime() };
        sendJSON(res, 200, { status: 'ok', ...stats });
        return;
    }

    // ---- 404 ----
    sendJSON(res, 404, { error: 'Not Found' });
}

// ==================== Server ====================
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
        sendJSON(res, 204, {});
        return;
    }

    // API routes
    if (pathname.startsWith('/api/')) {
        try {
            await handleApi(req, res, pathname, method);
        } catch (e) {
            console.error('API Error:', e);
            sendJSON(res, 500, { error: '服务器内部错误' });
        }
        return;
    }

    // Static files
    serveStatic(req, res, pathname);
});

initData();
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ===================================');
    console.log('   HPTI Backend Server');
    console.log('  ===================================');
    console.log('  Test page:  http://localhost:' + PORT + '/');
    console.log('  Admin page: http://localhost:' + PORT + '/admin.html');
    console.log('  API base:   http://localhost:' + PORT + '/api');
    console.log('  ===================================');
    console.log('');
});
