/**
 * 星程课表 · ESA 边缘天气
 *
 * 客户端拉天气走 `GET /api/weather/:name1[/:name2]`（见 desktop/main.js 的
 * requestWeatherWithRetry）。原来这条请求到了 ESA 仍然原样回源到 FC，由 FC 查和风天气；
 * 这里把「取天气」直接搬到边缘：边缘自己查和风天气、把结果缓存进边缘 KV，
 * 源站函数完全不参与这条路径。
 *
 * 设计要点（取舍与实测见 docs/design.md）：
 *  1. 只接管 `GET /api/weather/<城市>[/<省份>]`；其余请求一律 `fetch(request)` 透传，
 *     本函数不改变任何其他接口的行为。
 *  2. 缓存整个响应体，TTL 10 分钟——与源站 `cache.CachePage(10*time.Minute)` 一致。
 *     和风天气按次计费且有免费额度，边缘必须挡在它前面。
 *  3. 任何一步失败（环境变量没配、和风天气报错、响应格式不认识、KV 抛异常）都降级成
 *     `fetch(request)` 回源，由源站按原有逻辑处理。边缘只做加速，不做单点。
 *  4. 不带城市的 `/api/weather/` 同样在边缘处理：城市取 ESA 运行时 `request.info`
 *     里由客户端 IP 定位到的 `ip_city_en`（替代原先 Cloudflare 的 CF-IPCity），
 *     定位不到才回源。
 *
 * 注意：课表版本缓存（issue #63 的另一半）**不在**本函数里。等自动任务（desktop#57）
 * 落地、版本串语义稳定后再单独加；届时用 `s1.` / `g1.` 前缀，与本函数的 `w1.` 不冲突。
 */

/** ESA 边缘 KV 存储空间名称，与控制台/OpenAPI 中创建的 NameSpace 一致 */
const KV_NAMESPACE = 'astra';

/** 缓存键前缀，同时兼作结构版本号；改动值结构时必须同时升版本，避免读到旧格式 */
const CACHE_KEY_PREFIX = 'w1.';

/** 响应体缓存时长（秒），与源站天气接口的 CachePage TTL 保持一致 */
const CACHE_TTL_SECONDS = 600;

/** 函数变量键名（控制台「函数变量」/ esa-cli env、secret） */
const ENV_API_HOST = 'QW_API_HOST';
const ENV_API_KEY = 'QW_API_KEY';

/** 标记本响应是否由边缘产出，用于线上验证与排障 */
const EDGE_HEADER = 'X-Astra-Edge-Weather';

/** 城市名/省份名的长度上限，挡住畸形路径把超长串塞进上游 URL 与 KV 键 */
const MAX_QUERY_LENGTH = 64;

/** 和风天气 API 主机名的合法字符。用于「校验」而不是「清洗」 */
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

/** 非法城市名的字符：控制字符与路径分隔符 */
const INVALID_QUERY_CHARACTERS = /[\\/\u0000-\u001f\u007f]/;

/** base64url 字母表（A-Za-z0-9-_），ESA 边缘 KV 的键只接受字母、数字、- 和 _ */
const BASE64URL_ALPHABET =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export default {
	async fetch(request, context, env) {
		const method = String(request.method || 'GET').toUpperCase();

		// 写请求：透传后按源站声明的失效范围清理课表版本缓存（不改变响应）
		if (method !== 'GET' && method !== 'HEAD') {
			try {
				return await handleMutating(request, env, context);
			} catch (e) {
				return fetch(request);
			}
		}

		try {
			const schedule = await handleSchedule(request, env, context);
			if (schedule) {
				return schedule;
			}
		} catch (e) {
			// 边缘侧任何异常都回源：响应形态由源站决定，函数不自己造错误响应
		}

		try {
			const response = await handleWeather(request, env, context);
			if (response) {
				return response;
			}
		} catch (e) {
			// 同上：天气边缘失败一律回源
		}
		return fetch(request);
	},
};

/**
 * 只负责天气这一条路径；返回 null 表示「不接管，交给调用方回源」。
 */
async function handleWeather(request, env, context) {
	if (String(request.method || 'GET').toUpperCase() !== 'GET') {
		return null;
	}
	const url = new URL(request.url);
	const query = weatherQueryOf(url.pathname);
	if (!query) {
		return null;
	}
	const config = readConfig(env, context);
	if (!config) {
		return null;
	}

	// 不带城市的那条路径靠客户端 IP 定位；定位不到就回源，由源站决定响应
	const located = query.name === '' ? geoQueryOf(request) : query;
	if (!located) {
		return null;
	}

	const store = createStore();
	const cacheKey = cacheKeyOf(located);

	if (store) {
		const cached = await readCache(store, cacheKey);
		if (cached !== null) {
			return weatherResponse(cached, 'hit');
		}
	}

	const body = await fetchWeather(config, located);
	if (body === null) {
		return null;
	}

	if (store) {
		await writeCache(store, cacheKey, body);
	}
	return weatherResponse(body, 'miss');
}

/**
 * 解析 `/api/weather/<城市>[/<省份>]`。
 *
 * 客户端把地区设置原样拼进 URL，Node 的 URL 会把非 ASCII 百分号编码，
 * 所以这里必须解码后再用；解码失败（畸形百分号序列）一律不接管。
 * 其余路径（含 `/api/weather/`、`/api/weather/a/b/c`）都不是这个接口的形态，返回 null。
 */
export function weatherQueryOf(pathname) {
	const segments = String(pathname || '')
		.split('/')
		.filter((segment) => segment !== '');
	// 两段 = `/api/weather/`：不带城市，由客户端 IP 定位，见 geoQueryOf
	if (segments.length !== 2 && segments.length !== 3 && segments.length !== 4) {
		return null;
	}
	if (segments[0].toLowerCase() !== 'api' || segments[1].toLowerCase() !== 'weather') {
		return null;
	}
	if (segments.length === 2) {
		return { name: '', adm: '' };
	}
	const name = decodeSegment(segments[2]);
	if (!isQueryValue(name)) {
		return null;
	}
	if (segments.length === 3) {
		return { name, adm: '' };
	}
	const adm = decodeSegment(segments[3]);
	if (!isQueryValue(adm)) {
		return null;
	}
	return { name, adm };
}

/**
 * 从 ESA 的 `request.info` 里取客户端所在城市，供不带城市的 `/api/weather/` 使用。
 *
 * 这条路径原来依赖 Cloudflare 注入的 `CF-IPCity` / `CF-Region`，站点迁到 ESA 之后
 * 那两个头不再存在（源站那条分支因此返回 400）。ESA 的等价物是运行时的
 * `request.info`，实测形态：
 *
 *   { ip_city_en: "Nanjing", ip_region_en: "Jiangsu", ip_region_id: "CN-JS",
 *     ip_country_id: "CN", ip_city_id: "320100", remote_addr: "..." }
 *
 * 只有英文名和行政编码，没有中文名；和风天气的城市查询支持英文城市名（实测
 * Nanjing / Chongqing / Beijing / Guangzhou 都能查到正确的中文标准名），
 * 所以直接用 `ip_city_en` 当作 location。
 *
 * 为什么只取城市、不把 `ip_region_en` 当 `adm`：实测带不带 adm 结果完全一致，
 * 而多传一个省名就多一种对不上和风天气 adm 词表的可能（例如 Nei Mongol / Inner
 * Mongolia 这种拼法差异），少一个参数少一种失败模式。
 */
export function geoQueryOf(request) {
	const info = request && request.info;
	if (!info || typeof info !== 'object') {
		return null;
	}
	const name = asText(info.ip_city_en).trim();
	if (!isQueryValue(name)) {
		return null;
	}
	return { name, adm: '' };
}

function decodeSegment(segment) {
	try {
		return decodeURIComponent(segment);
	} catch (e) {
		return null;
	}
}

function isQueryValue(value) {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_QUERY_LENGTH &&
		!INVALID_QUERY_CHARACTERS.test(value)
	);
}

/**
 * 缓存键：`w1.<base64url(城市)>.<base64url(省份)>`
 *
 * 城市名可能含非 ASCII（ESA 边缘 KV 拒绝非 ASCII 键），因此必须编码。
 * base64url 的输出里不会出现 `.`，所以这个键的切分没有歧义。
 */
export function cacheKeyOf(query) {
	return (
		CACHE_KEY_PREFIX + base64url(query.name) + '.' + base64url(query.adm || '')
	);
}

/**
 * 读取和风天气的凭据。两个键都由函数变量下发（控制台「函数变量」或 esa-cli 的
 * env/secret），键名只能由字母数字下划线组成；敏感值建议用加密存储。
 *
 * 任一项缺失都返回 null —— 不接管、直接回源，未配置环境变量的部署行为与今天完全一致。
 * 除了文档承诺的第三个参数，也顺带看一眼 context：两个都不是时只回源，不会报错。
 */
export function readConfig(env, context) {
	const host = pickString([env, context], ENV_API_HOST).trim();
	const key = pickString([env, context], ENV_API_KEY).trim();
	if (!HOST_PATTERN.test(host) || key === '') {
		return null;
	}
	return { host, key };
}

function pickString(sources, name) {
	for (let i = 0; i < sources.length; i++) {
		const source = sources[i];
		if (source && typeof source[name] === 'string') {
			return source[name];
		}
	}
	return '';
}

async function fetchWeather(config, query) {
	const location = await lookupLocation(config, query);
	if (!location) {
		return null;
	}
	const now = await lookupNow(config, location.id);
	if (!now) {
		return null;
	}
	// 预警拿不到不算失败：源站也是这么处理的（warnResp, _ := ...）
	const alerts = await lookupWarning(config, location);
	return buildWeatherBody(location, now, alerts);
}

/** `GET /geo/v2/city/lookup`：城市名 → 城市 ID 与经纬度 */
async function lookupLocation(config, query) {
	let path = '/geo/v2/city/lookup?location=' + encodeURIComponent(query.name);
	if (query.adm) {
		path += '&adm=' + encodeURIComponent(query.adm);
	}
	const json = await qweatherJson(config, path);
	if (!json || json.code !== '200' || !Array.isArray(json.location)) {
		return null;
	}
	const first = json.location[0];
	if (!first || typeof first !== 'object') {
		return null;
	}
	const id = asText(first.id);
	const lat = asText(first.lat);
	const lon = asText(first.lon);
	const name = asText(first.name);
	if (id === '' || lat === '' || lon === '' || name === '') {
		return null;
	}
	return { id, lat, lon, name };
}

/** `GET /v7/weather/now`：实时天气。temp 为空视为失败，与源站判定一致 */
async function lookupNow(config, id) {
	const json = await qweatherJson(
		config,
		'/v7/weather/now?location=' + encodeURIComponent(id),
	);
	const now = json && json.now;
	if (!now || typeof now !== 'object' || asText(now.temp) === '') {
		return null;
	}
	return {
		temp: asText(now.temp),
		text: asText(now.text),
		windDir: asText(now.windDir),
		windScale: asText(now.windScale),
	};
}

/** `GET /weatheralert/v1/current/<lat>/<lon>`：预警。失败返回空数组 */
async function lookupWarning(config, location) {
	const lat = toFixed5(location.lat);
	const lon = toFixed5(location.lon);
	if (lat === null || lon === null) {
		return [];
	}
	const json = await qweatherJson(
		config,
		'/weatheralert/v1/current/' + encodeURIComponent(lat) + '/' + encodeURIComponent(lon),
	);
	if (!json || !Array.isArray(json.alerts)) {
		return [];
	}
	return json.alerts;
}

async function qweatherJson(config, path) {
	const response = await fetch('https://' + config.host + path, {
		headers: { 'X-QW-Api-Key': config.key },
	});
	if (!response || response.status !== 200) {
		return null;
	}
	try {
		return await response.json();
	} catch (e) {
		return null;
	}
}

/**
 * 组装响应体，字段与源站 model.WeatherResponse 逐字对齐
 * （usr-backend/router/client/getWeather.go 的 buildWeatherResponse）。
 */
export function buildWeatherBody(location, now, alerts) {
	return JSON.stringify({
		where: location.name,
		temp: now.temp,
		weat: now.text,
		wind: now.windDir,
		wind_power: now.windScale,
		warn: joinAlerts(alerts, 'description'),
		brief_warn: joinAlerts(alerts, 'headline'),
	});
}

function joinAlerts(alerts, field) {
	const parts = [];
	for (let i = 0; i < alerts.length; i++) {
		const alert = alerts[i];
		if (!alert || typeof alert !== 'object') {
			continue;
		}
		parts.push(asText(alert[field]).replace(/\n/g, ''));
	}
	return parts.join('；');
}

function asText(value) {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	return '';
}

function toFixed5(raw) {
	const value = Number(raw);
	return Number.isFinite(value) ? value.toFixed(5) : null;
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

async function readCache(store, key) {
	try {
		const raw = await store.get(key, { type: 'text' });
		if (typeof raw !== 'string' || raw === '') {
			return null;
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}
		if (typeof parsed.b !== 'string' || parsed.b === '') {
			return null;
		}
		if (typeof parsed.e !== 'number' || !Number.isFinite(parsed.e)) {
			return null;
		}
		// ESA 边缘 KV 没有 TTL 能力，过期时刻只能存在值里、由读取方自己比较
		if (nowSeconds() >= parsed.e) {
			return null;
		}
		return parsed.b;
	} catch (e) {
		return null;
	}
}

async function writeCache(store, key, body) {
	try {
		await store.put(
			key,
			JSON.stringify({ b: body, e: nowSeconds() + CACHE_TTL_SECONDS }),
		);
	} catch (e) {
		// 写失败只影响下一次能否命中，本次响应照常返回
	}
}

function weatherResponse(body, state) {
	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			[EDGE_HEADER]: state,
		},
	});
}

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
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
	CACHE_TTL_SECONDS,
	EDGE_HEADER,
	ENV_API_HOST,
	ENV_API_KEY,
	KV_NAMESPACE,
};

/* ===================== 课表版本缓存（issue desktop#63） ===================== */

/** 课表版本 KV 键前缀，与天气的 w1. 并列（同一存储空间，靠前缀区分） */
const SCHEDULE_KEY_PREFIX = 's1.';

/** 标记本次响应的课表版本判定结果，用于线上验证与排障 */
const SCHEDULE_EDGE_HEADER = 'X-Astra-Edge-Schedule';

/**
 * 源站用它声明「这次写入让哪些班级的缓存失效」，值是以逗号分隔的 school/grade/class。
 * 缺这个头、或头里没有合法 scope 时，边缘**不报错也不操作**、原样返回——
 * 用户、认证这类接口本来就与课表缓存无关。
 */
const PURGE_SCOPES_HEADER = 'X-Astra-Purge-Scopes';

/**
 * 只接管「客户端课表读取」：GET + 恰好三段路径 + 带 version 查询参数。
 * version 参数是客户端独有的判据——管理端读配置走 /web/config/...，不带该参数。
 * 返回 null 表示不接管，交给调用方回源。
 */
async function handleSchedule(request, env, context) {
	if (String(request.method || 'GET').toUpperCase() !== 'GET') {
		return null;
	}
	const url = new URL(request.url);
	const classPath = classPathOf(url.pathname);
	if (!classPath || !url.searchParams.has('version')) {
		return null;
	}
	const store = createStore();
	if (!store) {
		return null;
	}
	const key = scheduleKeyOf(hostOf(request), classPath);
	const clientVersion = String(url.searchParams.get('version') || '');
	const cached = await readScheduleCache(store, key);

	// 命中：客户端版本与缓存一致，且还没走到「下一次可能变化」的时刻 → 304
	if (cached && cached.v === clientVersion && !scheduleExpired(cached.e)) {
		return new Response(null, {
			status: 304,
			headers: { [SCHEDULE_EDGE_HEADER]: 'hit' },
		});
	}

	// 回源：原样透传（version 参数必须带上，源站要按三段解析它）
	const response = await fetch(request);

	// 304：说明客户端带来的版本就是源站当前版本，把它写进 KV，
	// 否则这次回源白跑、KV 永远填不上（304 没有响应体，只能这样补）
	if (response.status === 304) {
		await writeScheduleVersion(store, key, clientVersion);
		return new Response(null, {
			status: 304,
			headers: { [SCHEDULE_EDGE_HEADER]: 'revalidated' },
		});
	}

	// 200：读掉响应体以取出 version，再按原样重建（内容不变，只是能带上边缘标记）。
	// 不用 response.clone()：ESA 边缘运行时不保证提供它，一旦缺失就会静默写不进 KV。
	if (response.status === 200) {
		let text = '';
		try {
			text = await response.text();
		} catch (e) {
			text = '';
		}
		await writeScheduleVersion(store, key, versionOfScheduleBody(text));
		return new Response(text, {
			status: 200,
			headers: {
				...Object.fromEntries(response.headers),
				[SCHEDULE_EDGE_HEADER]: 'miss',
			},
		});
	}

	return response;
}

/**
 * 写请求：只发起一次回源，随后按响应头失效缓存。
 * 失效失败不影响响应——缓存多留一会儿好过把一次成功的写入报成失败。
 */
async function handleMutating(request, env, context) {
	const response = await fetch(request);
	try {
		const store = createStore();
		if (store) {
			for (const key of purgeKeysOf(hostOf(request), response.headers.get(PURGE_SCOPES_HEADER))) {
				await store.delete(key);
			}
		}
	} catch (e) {
		// 忽略：缓存失效失败不改变写入结果
	}
	return response;
}

/** 解析课表读取路径；不是恰好三段则返回 null */
export function classPathOf(pathname) {
	const parts = String(pathname || '')
		.split('/')
		.filter(Boolean);
	if (parts.length !== 3) {
		return null;
	}
	const head = parts[0].toLowerCase();
	if (head === 'web' || head === 'api' || head === 'ws') {
		return null;
	}
	return { school: parts[0], grade: parts[1], class: parts[2] };
}

/** 请求的主机名（小写）；解析失败返回空串 */
function hostOf(request) {
	try {
		return new URL(request.url).hostname.toLowerCase();
	} catch (e) {
		return '';
	}
}

/** KV 键：s1.<host>.<school>.<grade>.<class>，各段 base64url 以避开键的字符限制 */
function scheduleKeyOf(host, classPath) {
	return keyOfScheduleParts(host, [classPath.school, classPath.grade, classPath.class]);
}

export function keyOfScheduleParts(host, parts) {
	return (
		SCHEDULE_KEY_PREFIX +
		[host, ...parts].map((part) => base64url(String(part))).join('.')
	);
}

/** 把 X-Astra-Purge-Scopes 翻译成本次主机下的 KV 键；非法 scope 一律跳过 */
export function purgeKeysOf(host, scopes) {
	const keys = [];
	for (const raw of String(scopes || '').split(',')) {
		const parts = String(raw)
			.trim()
			.split('/')
			.filter(Boolean);
		if (parts.length !== 3) {
			continue;
		}
		keys.push(keyOfScheduleParts(host, parts));
	}
	return keys;
}

async function readScheduleCache(store, key) {
	try {
		const raw = await store.get(key, { type: 'text' });
		if (typeof raw !== 'string' || raw === '') {
			return null;
		}
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}
		if (typeof parsed.v !== 'string' || parsed.v === '') {
			return null;
		}
		const boundary = Number(parsed.e);
		return { v: parsed.v, e: Number.isFinite(boundary) ? boundary : 0 };
	} catch (e) {
		return null;
	}
}

/** 写入版本；写失败只影响下一次能否命中，本次响应照常返回 */
async function writeScheduleVersion(store, key, version) {
	const normalized = String(version || '');
	if (!normalized) {
		return;
	}
	try {
		await store.put(
			key,
			JSON.stringify({ v: normalized, e: scheduleBoundaryOf(normalized) }),
		);
	} catch (e) {
		// 写失败只影响下一次能否命中，本次响应照常返回
	}
}

/** 从课表响应体里取 version 字段 */
export function versionOfScheduleBody(text) {
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object') {
			return '';
		}
		const version = parsed.version;
		return typeof version === 'string' ? version : '';
	} catch (e) {
		return '';
	}
}

/**
 * 版本串第三段是「下一次可能变化时刻」（Unix 秒），源站 scheduleVersion 生成；
 * 没有该段说明之后不会再变，返回 0。
 */
export function scheduleBoundaryOf(version) {
	const parts = String(version || '').split(':');
	if (parts.length < 3) {
		return 0;
	}
	const boundary = Number(parts[2]);
	return Number.isFinite(boundary) && boundary > 0 ? Math.floor(boundary) : 0;
}

/** 越过变化点就必须回源：即使版本串没变，命中结果也已经不同了 */
function scheduleExpired(boundary) {
	return boundary > 0 && nowSeconds() >= boundary;
}
