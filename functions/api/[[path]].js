/**
 * HPTI API - Cloudflare Pages Function
 * Catch-all handler for all /api/* routes
 * Uses Web standard Request/Response (no Node.js http module)
 */

// In-memory cache (persists across warm invocations within same isolate)
let _cache = null;

// ==================== Data Layer ====================
async function getData(env) {
    if (_cache) return _cache;

    // Try KV binding if available (for persistent storage)
    if (env && env.HPTI_KV) {
        try {
            const stored = await env.HPTI_KV.get('hpti_store');
            if (stored) {
                _cache = JSON.parse(stored);
                return _cache;
            }
        } catch (e) { /* fall through */ }
    }

    _cache = { password: 'admin', config: null, results: [] };
    return _cache;
}

async function saveData(data, env) {
    _cache = data;
    // Try KV for persistence
    if (env && env.HPTI_KV) {
        try {
            await env.HPTI_KV.put('hpti_store', JSON.stringify(data));
        } catch (e) { /* cache-only mode */ }
    }
}

// ==================== Helpers ====================
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
        },
    });
}

async function readBody(request) {
    try {
        return await request.json();
    } catch (e) {
        return {};
    }
}

function checkAuth(request, data) {
    const pwd = request.headers.get('x-admin-password');
    return pwd && pwd === data.password;
}

// ==================== API Handlers ====================
async function handleApi(request, env, pathname, method) {
    const data = await getData(env);

    // ---- POST /api/submit (public) ----
    if (method === 'POST' && pathname === '/api/submit') {
        const body = await readBody(request);
        if (!body.personalityCode || !body.personalityName) {
            return jsonResponse({ error: '缺少必填字段' }, 400);
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
            // 详细答题数据
            answers: body.answers || [],
            scores: body.scores || {},
            dimDetails: body.dimDetails || {},
            bestDist: body.bestDist !== undefined ? body.bestDist : null,
            duration: body.duration || 0,
            deviceInfo: body.deviceInfo || {},
            questionCount: body.questionCount || 0,
        };
        data.results.push(result);
        if (data.results.length > 50000) {
            data.results = data.results.slice(-50000);
        }
        await saveData(data, env);
        return jsonResponse({ success: true, id: result.id });
    }

    // ---- GET /api/config (public) ----
    if (method === 'GET' && pathname === '/api/config') {
        return jsonResponse({ config: data.config });
    }

    // ---- PUT /api/config (auth) ----
    if (method === 'PUT' && pathname === '/api/config') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        const body = await readBody(request);
        data.config = {
            questions: body.questions || [],
            personalities: body.personalities || [],
            rarityInfo: body.rarityInfo || {}
        };
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- POST /api/login (public) ----
    if (method === 'POST' && pathname === '/api/login') {
        const body = await readBody(request);
        if (body.password === data.password) {
            return jsonResponse({ success: true });
        } else {
            return jsonResponse({ success: false, error: '密码错误' }, 401);
        }
    }

    // ---- GET /api/results (auth) ----
    if (method === 'GET' && pathname === '/api/results') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        const results = data.results.slice().reverse();
        return jsonResponse({ results, total: results.length });
    }

    // ---- GET /api/stats (auth) ----
    if (method === 'GET' && pathname === '/api/stats') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
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
        // 平均测试时长
        const durations = results.filter(r => r.duration && r.duration > 0).map(r => r.duration);
        stats.avgDuration = durations.length > 0
            ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
            : 0;
        // 维度倾向统计
        stats.dimTendency = {};
        if (results.length > 0) {
            const dimKeys = ['sex', 'social', 'emotion', 'action', 'think', 'adventure'];
            dimKeys.forEach(dim => {
                const firstLetters = results.map(r => (r.userCode || '')[dimKeys.indexOf(dim)]);
                const firstCount = firstLetters.filter(l => l && l !== dimKeys[dim] && ['O','E','S','P','T','A'].includes(l)).length;
                stats.dimTendency[dim] = { first: firstCount, second: results.length - firstCount };
            });
        }
        return jsonResponse(stats);
    }

    // ---- DELETE /api/results (auth) ----
    if (method === 'DELETE' && pathname === '/api/results') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        data.results = [];
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- POST /api/password (auth) ----
    if (method === 'POST' && pathname === '/api/password') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        const body = await readBody(request);
        if (!body.newPassword) return jsonResponse({ error: '请输入新密码' }, 400);
        data.password = body.newPassword;
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- GET /api/export (auth) ----
    if (method === 'GET' && pathname === '/api/export') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        return jsonResponse(data);
    }

    // ---- POST /api/import (auth) ----
    if (method === 'POST' && pathname === '/api/import') {
        if (!checkAuth(request, data)) return jsonResponse({ error: '未授权' }, 401);
        const body = await readBody(request);
        if (body.password) data.password = body.password;
        if (body.config) data.config = body.config;
        if (body.results) data.results = body.results;
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- GET /api/health (public) ----
    if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ status: 'ok', total: data.results.length });
    }

    // ---- 404 ----
    return jsonResponse({ error: 'Not Found' }, 404);
}

// ==================== Cloudflare Pages Function Entry ====================
export async function onRequest(context) {
    const { request, env } = context;

    // CORS preflight
    if (request.method === 'OPTIONS') {
        return jsonResponse({}, 204);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    try {
        return await handleApi(request, env, pathname, method);
    } catch (e) {
        return jsonResponse({ error: '服务器内部错误', detail: e.message }, 500);
    }
}
