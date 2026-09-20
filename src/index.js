/**
 * 星程课表 · ESA 边缘版本缓存
 *
 * 课表接口（GET /:school/:grade/:class）的响应只在少数时刻变化，但客户端每次拉取
 * 都会把源站函数调起来查库。这个边缘函数把「当前有效版本 + 该版本必然失效的时刻」
 * 缓存在 ESA 边缘 KV 里，客户端带着本地 version 回来时直接在边缘回 304，不回源。
 *
 * 设计要点（背景见 docs/design.md）：
 *  1. KV 里只存版本元信息，不存课表响应体；cache miss 一律回源，边缘不承担数据一致性。
 *  2. 回源时请求原样透传（保留 version 参数），源站自己的 304 快路径照旧生效，
 *     元信息由响应头带回，边缘不需要发第二次请求。
 *  3. 边缘 KV 是最终一致的（最迟 300 秒），因此「写请求主动失效」不能保证立即全球生效；
 *     版本元信息里的 expire 是兜底，二者共同把过期窗口限制在有界范围内。
 *  4. 缓存是纯优化：KV 不可用、异常、格式不认识时一律降级为直接回源，绝不因为缓存
 *     故障改变接口的可用性。
 */

/** ESA 边缘 KV 存储空间名称，与控制台/OpenAPI 中创建的 NameSpace 一致 */
const KV_NAMESPACE = 'astra';

/** KV 键前缀，同时兼作结构版本号；改动值结构时必须同时升版本，避免读到旧格式 */
const ENTRY_KEY_PREFIX = 's1.';
const GEN_KEY_PREFIX = 'g1.';

/**
 * 非班级路径的首段。班级路径固定是 \(/:school/:grade/:class\) 三段，
 * 但 /web/xxx/yyy 与 /api/weather/xxx 同样是三段，这里显式排除。
 */
const RESERVED_FIRST_SEGMENTS = new Set(['web', 'api', 'ws']);

/** 源站下发的元信息响应头，见 usr-backend 的 router/client/getSchedule.go */
const HEADER_VERSION = 'X-Astra-Schedule-Version';
const HEADER_EXPIRE = 'X-Astra-Schedule-Expire';

/** 版本串的合法字符与长度上限，防止异常响应把任意内容写进 KV */
const VERSION_PATTERN = /^[0-9A-Za-z:._-]{1,128}$/;

/**
 * 会改变服务端数据的请求方法，只有这些方法成功后才推进世代。
 * 这里用白名单而不是「非 GET/HEAD 就失效」：浏览器的跨域预检用的是 OPTIONS，
 * 源站会对它回 2xx，按后者处理会让每次预检都把该域名下所有班级的缓存打掉。
 */
const MUTATING_METHODS = new Set(['PUT', 'POST', 'PATCH', 'DELETE']);

/** base64url 字母表（A-Za-z0-9-_），ESA 边缘 KV 的键只接受字母、数字、- 和 _ */
const BASE64URL_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export default {
	fetch(request) {
		return handleRequest(request).catch(() => fetch(request));
	},
};

async function handleRequest(request) {
	const method = String(request.method || 'GET').toUpperCase();

	// url 要在 fetch 之前取：请求体交给 fetch 之后 request 可能已不可再被读取。
	// 取 hostname 而不是 host：host 会带上非默认端口（如 :8443），而冒号不是边缘 KV 允许的键字符
	const url = new URL(request.url);
	const host = url.hostname;

	// GET 之外一律透传（含 HEAD 与跨域预检 OPTIONS），只有会改数据的方法才推进世代
	if (method !== 'GET') {
		const response = await fetch(request);
		if (MUTATING_METHODS.has(method) && isSuccess(response.status)) {
			await invalidateHost(host);
		}
		return response;
	}

	const classId = classIdOf(url.pathname);
	if (!classId) {
		return fetch(request);
	}

	// 浏览器发出的跨域请求不走 304 快路径：合成的 304 带不回源站的 CORS 响应头，
	// 浏览器会把它当成网络错误。桌面客户端是 Node 请求，不带 Origin。
	if (request.headers.get('Origin')) {
		return fetch(request);
	}

	const clientVersion = url.searchParams.get('version');
	if (!clientVersion) {
		return fetch(request);
	}

	const store = createStore();
	if (!store) {
		return fetch(request);
	}

	const entryKey = entryKeyOf(host, classId);
	const genKey = genKeyOf(host);
	const state = await readCacheState(store, entryKey, genKey);
	if (isFresh(state, clientVersion)) {
		return notModified(state.entry);
	}

	// 回源时保持请求原样：源站命中自己的 304 时会带上 expire 响应头，
	// 边缘据此仍然能刷新 KV，不必为了拿元信息而多打一次源站
	const response = await fetch(request);
	const meta = readMeta(response, clientVersion);
	if (meta) {
		await writeEntry(store, entryKey, meta, state.gen);
	}
	return response;
}

function isSuccess(status) {
	return typeof status === 'number' && status >= 200 && status < 300;
}

/** 解析班级路径；非班级路径返回 null */
function classIdOf(pathname) {
	const segments = String(pathname || '')
		.split('/')
		.filter((segment) => segment !== '');
	if (segments.length !== 3) {
		return null;
	}
	if (RESERVED_FIRST_SEGMENTS.has(segments[0].toLowerCase())) {
		return null;
	}
	return segments.join('/');
}

/**
 * 班级条目的键：s1.<host>.<base64url(班级路径)>
 * host 只含 [a-z0-9.-]，班级路径可能含中文（ESA 边缘 KV 拒绝非 ASCII 键），因此做 base64url 编码。
 */
function entryKeyOf(host, classId) {
	return ENTRY_KEY_PREFIX + normalizeHost(host) + '.' + base64url(classId);
}

/**
 * 世代键：g1.<host>
 * 任何写请求都会把它换成一个新值；条目里记下写入时的世代，读取时二者必须一致。
 * 这样一次写入就能让该域名下所有班级的缓存失效，不必枚举键（边缘 KV 没有前缀枚举能力），
 * 也覆盖了 /web/autorun、/web/countdown 这类一次影响多个班级的全局写入。
 */
function genKeyOf(host) {
	return GEN_KEY_PREFIX + normalizeHost(host);
}

function normalizeHost(host) {
	return String(host || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
}

function createStore() {
	const EdgeKV = globalThis.EdgeKV;
	if (typeof EdgeKV !== 'function') {
		return null;
	}
	try {
		return new EdgeKV({ namespace: KV_NAMESPACE });
	} catch (e) {
		return null;
	}
}

async function readCacheState(store, entryKey, genKey) {
	const entry = await readEntry(store, entryKey);
	const gen = await readText(store, genKey);
	return { entry, gen };
}

async function readEntry(store, key) {
	try {
		const raw = await store.get(key, { type: 'text' });
		if (typeof raw !== 'string' || raw === '') {
			return null;
		}
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch (e) {
		return null;
	}
}

async function readText(store, key) {
	try {
		const raw = await store.get(key, { type: 'text' });
		return typeof raw === 'string' ? raw : '';
	} catch (e) {
		return '';
	}
}

/**
 * 判断缓存条目能否直接判定为 304：
 * 版本与客户端一致、未过期、且世代未被写请求推进过。
 */
function isFresh(state, clientVersion) {
	const entry = state.entry;
	if (!entry) {
		return false;
	}
	if (typeof entry.v !== 'string' || entry.v !== clientVersion) {
		return false;
	}
	if (typeof entry.e !== 'number' || !Number.isFinite(entry.e)) {
		return false;
	}
	if (nowSeconds() >= entry.e) {
		return false;
	}
	return normalizeGen(entry.g) === normalizeGen(state.gen);
}

function normalizeGen(gen) {
	return typeof gen === 'string' ? gen : '';
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

/**
 * 从源站响应里取出可缓存的版本元信息。
 * 200 用响应头里的版本；304 说明源站也认为客户端版本有效，版本取客户端带回来的那个，
 * 两者都必须带上 expire，否则不缓存（宁可回源，也不能拿一个不知道何时过期的版本去判 304）。
 */
function readMeta(response, clientVersion) {
	const expire = parseExpire(response.headers.get(HEADER_EXPIRE));
	if (!expire) {
		return null;
	}
	if (response.status === 304) {
		return { v: clientVersion, e: expire };
	}
	if (response.status !== 200) {
		return null;
	}
	const version = response.headers.get(HEADER_VERSION);
	if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
		return null;
	}
	return { v: version, e: expire };
}

function parseExpire(raw) {
	if (typeof raw !== 'string' || raw === '') {
		return 0;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.floor(value);
}

async function writeEntry(store, entryKey, meta, gen) {
	// 已经过期的元信息不值得写：写下去下一次请求也必然 miss，白白多一次 KV 写入。
	// 同时挡住源站时钟异常（或响应头被篡改）时写进一个永远不新鲜的条目。
	if (meta.e <= nowSeconds()) {
		return;
	}
	try {
		await store.put(
			entryKey,
			JSON.stringify({ v: meta.v, e: meta.e, g: normalizeGen(gen) }),
		);
	} catch (e) {
		// 缓存写入失败只影响下一次能否命中，不影响本次响应
	}
}

/** 写请求成功后推进世代，使该域名下所有班级的条目立即不再新鲜 */
async function invalidateHost(host) {
	const store = createStore();
	if (!store) {
		return;
	}
	const gen = nowSeconds() + '-' + Math.random().toString(36).slice(2, 10);
	try {
		await store.put(genKeyOf(host), gen);
	} catch (e) {
		// 失效失败时靠条目自带的 expire 兜底
	}
}

function notModified(entry) {
	return new Response(null, {
		status: 304,
		headers: {
			'X-Astra-Edge-Cache': 'hit',
			[HEADER_VERSION]: entry.v,
			[HEADER_EXPIRE]: String(entry.e),
		},
	});
}

/** UTF-8 字节 + base64url 编码，不依赖 btoa（边缘运行时不一定提供） */
export function base64url(input) {
	const bytes = utf8Encode(String(input));
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
		out += BASE64URL_ALPHABET[b0 >> 2];
		out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
		if (b1 === undefined) {
			break;
		}
		out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
		if (b2 === undefined) {
			break;
		}
		out += BASE64URL_ALPHABET[b2 & 0x3f];
	}
	return out;
}

export function utf8Encode(input) {
	const out = [];
	for (let i = 0; i < input.length; i++) {
		const cp = input.codePointAt(i);
		if (cp > 0xffff) {
			i++; // 代理对已由 codePointAt 合并，跳过低位代理
		}
		if (cp < 0x80) {
			out.push(cp);
		} else if (cp < 0x800) {
			out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
		} else if (cp < 0x10000) {
			out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
		} else {
			out.push(
				0xf0 | (cp >> 18),
				0x80 | ((cp >> 12) & 0x3f),
				0x80 | ((cp >> 6) & 0x3f),
				0x80 | (cp & 0x3f),
			);
		}
	}
	return out;
}

export {
	HEADER_VERSION,
	HEADER_EXPIRE,
	KV_NAMESPACE,
	classIdOf,
	entryKeyOf,
	genKeyOf,
	isFresh,
	notModified,
	parseExpire,
	readMeta,
};
