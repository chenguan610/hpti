/**
 * HPTI API - Cloudflare Pages Function
 * Catch-all handler for all /api/* routes
 * Uses Web standard Request/Response (no Node.js http module)
 */

// In-memory cache (persists across warm invocations within same isolate)
let _cache = null;

// ==================== Permission System ====================
const PERMISSIONS = {
    view:           { label: '查看数据',      desc: '查看仪表盘和测试记录',             defaultFor: ['viewer','editor','manager'] },
    edit_questions: { label: '编辑题库',      desc: '新增/修改/删除测试题目',           defaultFor: ['editor','manager'] },
    edit_personalities:{ label: '编辑人格库', desc: '新增/修改/删除人格类型',            defaultFor: ['editor','manager'] },
    edit_rarity:    { label: '编辑稀有度',    desc: '修改稀有度分级配置',                defaultFor: ['editor','manager'] },
    delete_records: { label: '删除记录',      desc: '清空测试记录',                      defaultFor: ['manager'] },
    manage_data:    { label: '数据管理',      desc: '导入导出数据、修改管理员密码',       defaultFor: ['manager'] },
    manage_users:   { label: '用户管理',      desc: '新增/修改/删除用户账号及权限',       defaultFor: ['manager'] },
};

const ALL_PERM_KEYS = Object.keys(PERMISSIONS);

// Build default permission sets for predefined roles
function getRoleDefaults(role) {
    const perms = {};
    ALL_PERM_KEYS.forEach(k => { perms[k] = false; });
    if (role === 'viewer') {
        perms.view = true;
    } else if (role === 'editor') {
        ALL_PERM_KEYS.forEach(k => { perms[k] = PERMISSIONS[k].defaultFor.includes('editor'); });
    } else if (role === 'manager') {
        ALL_PERM_KEYS.forEach(k => { perms[k] = true; });
    }
    return perms;
}

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

    _cache = { password: 'admin', config: null, results: [], users: [] };
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
            'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, X-Username',
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

// Returns { username, role, permissions } or null if not authenticated
function getAuthUser(request, data) {
    const pwd = request.headers.get('x-admin-password');
    if (!pwd) return null;

    // Admin login - full permissions
    if (pwd === data.password) {
        const fullPerms = {};
        ALL_PERM_KEYS.forEach(k => { fullPerms[k] = true; });
        return { username: 'admin', role: 'admin', permissions: fullPerms };
    }

    // User account login
    if (data.users && data.users.length > 0) {
        const username = request.headers.get('x-username') || '';
        const user = data.users.find(u => u.username === username && u.password === pwd);
        if (user) {
            // Ensure permissions object exists (migration from old format)
            const perms = user.permissions || getRoleDefaults(user.role || 'viewer');
            return { username: user.username, role: user.role || 'viewer', permissions: perms };
        }
    }
    return null;
}

// Check if user has a specific permission (or is admin)
function checkPerm(authUser, permission) {
    if (!authUser) return false;
    if (authUser.role === 'admin') return true;
    return authUser.permissions && authUser.permissions[permission] === true;
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

    // ---- PUT /api/config (auth: edit_questions or edit_personalities or edit_rarity) ----
    if (method === 'PUT' && pathname === '/api/config') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'edit_questions') && !checkPerm(user, 'edit_personalities') && !checkPerm(user, 'edit_rarity')) {
            return jsonResponse({ error: '未授权：需要编辑权限' }, 401);
        }
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
        // Check admin password first
        if (body.password === data.password) {
            const fullPerms = {};
            ALL_PERM_KEYS.forEach(k => { fullPerms[k] = true; });
            return jsonResponse({ success: true, role: 'admin', permissions: fullPerms });
        }
        // Check user accounts
        if (body.username && data.users) {
            const user = data.users.find(u => u.username === body.username && u.password === body.password);
            if (user) {
                const perms = user.permissions || getRoleDefaults(user.role || 'viewer');
                return jsonResponse({ success: true, role: user.role || 'viewer', username: user.username, permissions: perms });
            }
        }
        return jsonResponse({ success: false, error: '用户名或密码错误' }, 401);
    }

    // ---- GET /api/results (auth: view) ----
    if (method === 'GET' && pathname === '/api/results') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'view')) return jsonResponse({ error: '未授权：需要查看权限' }, 401);
        const results = data.results.slice().reverse();
        return jsonResponse({ results, total: results.length });
    }

    // ---- GET /api/stats (auth: view) ----
    if (method === 'GET' && pathname === '/api/stats') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'view')) return jsonResponse({ error: '未授权：需要查看权限' }, 401);
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
        const durations = results.filter(r => r.duration && r.duration > 0).map(r => r.duration);
        stats.avgDuration = durations.length > 0
            ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
            : 0;
        stats.dimTendency = {};
        if (results.length > 0) {
            const dimKeys2 = ['sex', 'social', 'emotion', 'action', 'think', 'adventure'];
            dimKeys2.forEach(dim => {
                const firstLetters = results.map(r => (r.userCode || '')[dimKeys2.indexOf(dim)]);
                const firstCount = firstLetters.filter(l => l && l !== dimKeys2[dim] && ['O','E','S','P','T','A'].includes(l)).length;
                stats.dimTendency[dim] = { first: firstCount, second: results.length - firstCount };
            });
        }
        return jsonResponse(stats);
    }

    // ---- DELETE /api/results (auth: delete_records) ----
    if (method === 'DELETE' && pathname === '/api/results') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'delete_records')) return jsonResponse({ error: '未授权：需要删除记录权限' }, 401);
        data.results = [];
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- POST /api/password (auth: manage_data) ----
    if (method === 'POST' && pathname === '/api/password') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_data')) return jsonResponse({ error: '未授权：需要数据管理权限' }, 401);
        const body = await readBody(request);
        if (!body.newPassword) return jsonResponse({ error: '请输入新密码' }, 400);
        data.password = body.newPassword;
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- GET /api/users (auth: manage_users) ----
    if (method === 'GET' && pathname === '/api/users') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_users')) return jsonResponse({ error: '未授权：需要用户管理权限' }, 401);
        const users = (data.users || []).map(u => ({
            username: u.username,
            role: u.role || 'viewer',
            permissions: u.permissions || getRoleDefaults(u.role || 'viewer'),
            createdAt: u.createdAt || '',
        }));
        return jsonResponse({ users });
    }

    // ---- POST /api/users (auth: manage_users) ----
    if (method === 'POST' && pathname === '/api/users') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_users')) return jsonResponse({ error: '未授权：需要用户管理权限' }, 401);
        const body = await readBody(request);
        if (!body.username || !body.password) {
            return jsonResponse({ error: '用户名和密码不能为空' }, 400);
        }
        if (body.username.length < 2 || body.username.length > 30) {
            return jsonResponse({ error: '用户名长度需在 2-30 字符之间' }, 400);
        }
        if (body.password.length < 4) {
            return jsonResponse({ error: '密码长度至少 4 位' }, 400);
        }
        if (!data.users) data.users = [];
        if (data.users.find(u => u.username === body.username)) {
            return jsonResponse({ error: '用户名已存在' }, 409);
        }
        // Build permissions from request or use role defaults
        let perms;
        if (body.permissions && typeof body.permissions === 'object') {
            perms = {};
            ALL_PERM_KEYS.forEach(k => {
                perms[k] = body.permissions[k] === true;
            });
        } else {
            perms = getRoleDefaults(body.role || 'viewer');
        }
        data.users.push({
            username: body.username,
            password: body.password,
            role: body.role || 'viewer',
            permissions: perms,
            createdAt: new Date().toISOString(),
        });
        await saveData(data, env);
        return jsonResponse({ success: true, username: body.username });
    }

    // ---- PUT /api/users (auth: manage_users) ----
    if (method === 'PUT' && pathname === '/api/users') {
        const authUser = getAuthUser(request, data);
        if (!checkPerm(authUser, 'manage_users')) return jsonResponse({ error: '未授权：需要用户管理权限' }, 401);
        const body = await readBody(request);
        if (!body.username) return jsonResponse({ error: '请指定用户名' }, 400);
        if (!data.users) data.users = [];
        const targetUser = data.users.find(u => u.username === body.username);
        if (!targetUser) return jsonResponse({ error: '用户不存在' }, 404);
        // Update password if provided
        if (body.password && body.password.length >= 4) {
            targetUser.password = body.password;
        }
        // Update permissions if provided
        if (body.permissions && typeof body.permissions === 'object') {
            if (!targetUser.permissions) targetUser.permissions = {};
            ALL_PERM_KEYS.forEach(k => {
                if (body.permissions.hasOwnProperty(k)) {
                    targetUser.permissions[k] = body.permissions[k] === true;
                }
            });
        }
        // Update role label
        if (body.role) {
            targetUser.role = body.role;
        }
        await saveData(data, env);
        return jsonResponse({ success: true, username: body.username });
    }

    // ---- DELETE /api/users (auth: manage_users) ----
    if (method === 'DELETE' && pathname === '/api/users') {
        const authUser = getAuthUser(request, data);
        if (!checkPerm(authUser, 'manage_users')) return jsonResponse({ error: '未授权：需要用户管理权限' }, 401);
        const body = await readBody(request);
        if (!body.username) return jsonResponse({ error: '请指定用户名' }, 400);
        if (!data.users) data.users = [];
        const idx = data.users.findIndex(u => u.username === body.username);
        if (idx === -1) return jsonResponse({ error: '用户不存在' }, 404);
        data.users.splice(idx, 1);
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- GET /api/export (auth: manage_data) ----
    if (method === 'GET' && pathname === '/api/export') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_data')) return jsonResponse({ error: '未授权：需要数据管理权限' }, 401);
        return jsonResponse(data);
    }

    // ---- POST /api/import (auth: manage_data) ----
    if (method === 'POST' && pathname === '/api/import') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_data')) return jsonResponse({ error: '未授权：需要数据管理权限' }, 401);
        const body = await readBody(request);
        if (body.password) data.password = body.password;
        if (body.config) data.config = body.config;
        if (body.results) data.results = body.results;
        await saveData(data, env);
        return jsonResponse({ success: true });
    }

    // ---- GET /api/permissions (auth: manage_users) ----
    if (method === 'GET' && pathname === '/api/permissions') {
        const user = getAuthUser(request, data);
        if (!checkPerm(user, 'manage_users')) return jsonResponse({ error: '未授权：需要用户管理权限' }, 401);
        const permDefs = {};
        ALL_PERM_KEYS.forEach(k => {
            permDefs[k] = { label: PERMISSIONS[k].label, desc: PERMISSIONS[k].desc };
        });
        return jsonResponse({ permissions: permDefs, keys: ALL_PERM_KEYS });
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
