/**
 * 星程课表 · ESA 边缘天气
 *
 * 客户端拉天气走 `GET /api/weather/:name1[/:name2]`（见 desktop/main.js 的
 * requestWeatherWithRetry）。原来这条请求到了 ESA 仍然原样回源到 FC，由 FC 查和风天气；
 * 这里把「取天气」直接搬到边缘：边缘自己查和风天气、把结果缓存进边缘 KV，
 * 源站函数完全不参与这条路径。
 *
 * 设计要点（取舍与实测见 docs/design.md）：
 *  1. 只接管 `GET /api/weather/<城市>[/<省份>]`、`GET /api/weather/`、连通性探针
 *     `GET|HEAD /`（见 handleRoot）与后半段的课表版本读写；其余请求一律 `fetch(request)`
 *     透传，本函数不改变任何其他接口的行为。
 *  2. 缓存整个响应体，TTL 10 分钟——与源站 `cache.CachePage(10*time.Minute)` 一致。
 *     和风天气按次计费且有免费额度，边缘必须挡在它前面。
 *  3. **天气一旦被本函数认出，就绝不回源**：函数变量没配、和风天气报错、响应格式不认识、
 *     函数内部抛异常，全部由边缘自己按源站的错误契约作答（状态码与 JSON 键同形，见
 *     weatherError）。把失败推回源站解决不了问题——源站那条分支依赖的定位头在 ESA 上同样
 *     不存在，只会稳定回 400——却会把天气流量重新压回 FC，正是这个函数要消灭的东西。
 *  4. 不带城市的 `/api/weather/`：城市取 ESA 运行时 `request.info` 里由客户端 IP 定位到的
 *     `ip_city_en`（替代原先 Cloudflare 的 CF-IPCity）；定位不到时按源站同形的 400 作答。
 *
 * 课表版本缓存（issue #63 的另一半）在本文件后半段：`handleSchedule`，键前缀 `s1.`，
 * 与天气的 `w1.` 并列在同一个边缘 KV 存储空间。
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

/** 标记本响应是否由边缘产出，用于线上验证与排障：hit（命中缓存）/ miss（边缘现取）/ error（边缘就地判定的失败） */
const EDGE_HEADER = 'X-Astra-Edge-Weather';

/** 标记根路径连通性探针由边缘作答（见 handleRoot），线上验证与排障用 */
const ROOT_EDGE_HEADER = 'X-Astra-Edge-Root';

/**
 * 函数变量键名：最低兼容客户端版本（形如 `202610.1.0`）。
 * 未配置、或值不是点分纯数字时闸门整体关闭——宁可放过旧客户端，
 * 也不能因为一个配置笔误把全量客户端挡在门外。
 */
const ENV_MIN_CLIENT_VERSION = 'MIN_CLIENT_VERSION';

/** 标记本响应由「最低兼容客户端版本」闸门就地产出：block（版本过低，未回源） */
const MIN_VERSION_HEADER = 'X-Astra-Edge-Min-Version';

/** 闸门要求的版本号，回显在 426 上，客户端日志与排障一眼看出被拦的原因 */
const MIN_VERSION_VALUE_HEADER = 'X-Astra-Min-Client-Version';

/**
 * 根路径 `/` 的响应体，与源站 gin 根路由逐字同形
 * （usr-backend/main.go、sys-backend/router/setup.go 的 `c.JSON(200, gin.H{"message": "Hello World"})`）。
 * 连通性探测只看「通不通」，保持同形即可，客户端与监控都不用改。
 */
const BODY_ROOT = JSON.stringify({ message: 'Hello World' });

/** 源站 gin 对未注册方法/路径的默认 404 体（实测 18 字节，见 docs/design.md 3.2） */
const BODY_ROOT_NOT_FOUND = '404 page not found';

/**
 * 失败时返回的响应体。状态码与 JSON 键与源站逐个对齐
 * （usr-backend/router/client/getWeather.go）：客户端只按「是否 2xx」决定要不要重试，
 * 所以状态码是硬契约，键名是给排障的人看的。
 * 403/400 的文案改写成边缘的处置建议——源站那句「请配置 JWT（kid/project_id/private_key_pem）」
 * 「请确保请求经过 ESA 或 Cloudflare」在边缘都不成立，照抄只会误导。
 */
const BODY_NO_CREDENTIAL = JSON.stringify({
	error: '未配置天气认证信息：请在 ESA 边缘函数的函数变量中配置 QW_API_HOST 与 QW_API_KEY',
});
const BODY_NO_CITY = JSON.stringify({
	error: '无法从客户端 IP 定位城市：请求可能没有经过 ESA 边缘节点，或运行时 request.info 缺少 ip_city_en',
});
const BODY_NOT_FOUND = JSON.stringify({
	temp: '404',
	weat: '不存在',
	warning: '',
	brief_warn: '',
});
const BODY_UPSTREAM_ERROR = JSON.stringify({
	error: '获取天气信息失败，超过最大重试次数，可能是上游服务器异常，或是本服务器存在网络波动',
});

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

		// 最低兼容客户端版本闸门：版本过低的客户端一律 426，连同连通性探针都不回源
		const outdated = handleMinClientVersion(request, method, env, context);
		if (outdated) {
			return outdated;
		}

		// 连通性探针 `/`：任何方法都在边缘作答，绝不回源（写请求的 KV 失效逻辑也轮不到它）
		const root = handleRoot(request, method);
		if (root) {
			return root;
		}

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
			// 只有「还没认出路径」（例如 new URL 抛异常）才会走到这里；认出之后
			// handleWeather 内部已自兜底，不会把异常漏到这一层。
		}
		return fetch(request);
	},
};

/* ============ 最低兼容客户端版本闸门（旧客户端一律 426） ============ */

/**
 * 只给「客户端」判版本。客户端 UA 是 `AstraSchedule/<版本>`（desktop/main/client-ua.js 逐字生成），
 * 返回版本串；`AstraSchedule` 没有版本号时返回空串（按 0 处理，低于任何阈值）；
 * 不是客户端（Mozilla/Chrome、脚本、扫描器）返回 null —— 一律放行。
 */
function clientVersionOf(userAgent) {
	const ua = String(userAgent || '').trim();
	if (!/^AstraSchedule(?:\/|\s|$)/i.test(ua)) {
		return null;
	}
	const matched = /^AstraSchedule\/(\S+)/i.exec(ua);
	return matched ? matched[1] : '';
}

/** 点分数字版本 → 数字数组；任一段不是纯数字就返回 null（非法值不参与比较） */
function versionParts(version) {
	const parts = String(version)
		.split('.')
		.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
	return parts.length > 0 && parts.every((value) => Number.isFinite(value)) ? parts : null;
}

/**
 * 点分数字版本比较，按段数值比而不是字符串字典序（`202609.28.150` > `202609.5.1`）；
 * 缺段按 0 补，所以 `202610.1` 与 `202610.1.0` 视为相等。返回 1 / 0 / -1。
 */
function compareVersions(left, right) {
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = (left[i] || 0) - (right[i] || 0);
		if (diff !== 0) {
			return diff > 0 ? 1 : -1;
		}
	}
	return 0;
}

/** 426 响应体：状态码是硬契约，其余字段是给排障的人看的 */
function minVersionBody(min) {
	return JSON.stringify({
		error: '客户端版本过低，已停止提供数据：请更新到 ' + min + ' 或更高版本',
		min_version: min,
	});
}

/**
 * 最低兼容客户端版本闸门：UA 里的客户端版本低于 `MIN_CLIENT_VERSION` 时，
 * 不论方法、路径、version 参数是什么，一律就地回 426，**绝不回源**——
 * 旧客户端只看到一次失败（自动更新照常进行，更新完成后自然恢复），
 * 源站不会为淘汰版本的轮询/风暴付出任何 FC 实例成本。
 *
 * 三条边界：
 * - 环境变量未配置或值非法 → 闸门关闭（fail-open），不因配置笔误误伤全量客户端；
 * - 非 AstraSchedule 的 UA → 视为兼容放行（开发调试要用；这类来源在 WAF 层另有 JS 质询兜底）；
 * - 客户端版本号缺失或含非数字段 → 按 0 处理，低于阈值即拦。
 *
 * 返回 null 表示放行（版本达标或不是客户端），交回 fetch 里的原流程。
 */
function handleMinClientVersion(request, method, env, context) {
	const min = pickString([env, context], ENV_MIN_CLIENT_VERSION).trim();
	const minParts = versionParts(min);
	if (!minParts) {
		return null;
	}
	const version = clientVersionOf(request.headers.get('user-agent'));
	if (version === null) {
		return null;
	}
	const parts = versionParts(version);
	if (parts && compareVersions(parts, minParts) >= 0) {
		return null;
	}
	return new Response(method === 'HEAD' ? null : minVersionBody(min), {
		status: 426,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			[MIN_VERSION_HEADER]: 'block',
			[MIN_VERSION_VALUE_HEADER]: min,
		},
	});
}

/**
 * 根路径 `/`：源站只注册了 GET（usr-backend/main.go、sys-backend/router/setup.go），
 * 而实际打过来的几乎都是客户端/监控的连通性探测——启动时确认网络通不通，本身不承载业务。
 * 这类请求在边缘就能回答，没必要为一个 Hello World 拉起源站的 FC 实例（冷启动几百毫秒起）。
 *
 * 路径恰好是 `/` 就接管，**不看方法**：路由规则本身已经把 uri == "/" 的请求（含 POST/OPTIONS）
 * 全量送进函数，走到这里再放回源站等于白拉一次 FC，且写请求还会顺带触发一遍 KV 失效逻辑。
 * 非 `/` 一律返回 null，交回 fetch 里的原流程。
 *
 * 各方法的响应与线上实测的源站行为逐字同形（docs/design.md 3.2 有实测表）：
 * GET → 200 Hello World；HEAD → 200 空体；OPTIONS → 204 空体（源站 CORS 预检）；
 * 其余方法源站没有路由，gin 回 404 text/plain 的「404 page not found」。
 */
function handleRoot(request, method) {
	if (new URL(request.url).pathname !== '/') {
		return null;
	}
	if (method === 'GET' || method === 'HEAD') {
		return new Response(method === 'HEAD' ? null : BODY_ROOT, {
			status: 200,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				[ROOT_EDGE_HEADER]: 'hit',
			},
		});
	}
	if (method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: { [ROOT_EDGE_HEADER]: 'hit' } });
	}
	return new Response(BODY_ROOT_NOT_FOUND, {
		status: 404,
		headers: {
			'Content-Type': 'text/plain',
			[ROOT_EDGE_HEADER]: 'hit',
		},
	});
}

/**
 * 只负责天气这一条路径；返回 null 表示「这不是天气请求，交给调用方回源」。
 *
 * 认出天气路径之后**必定返回一个 Response**（不会再返回 null）：天气请求不回源，
 * 见文件头第 3 点。
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

	try {
		return await serveWeather(request, query, env, context);
	} catch (e) {
		// 源站 stats.go 的 recordWeatherError 只统计源站侧的上游失败，边缘这边的失败
		// 观测不到，所以必须留下日志（docs/design.md：观测口径需要用边缘日志补齐）
		console.error('weather edge error', e && e.message);
		// 边缘自己出错也不回源：给客户端一个源站同形的 502，让它按原有逻辑重试
		return weatherError(502, BODY_UPSTREAM_ERROR);
	}
}

/**
 * 天气路径的实际处理。每一步失败都就地转成响应，没有「返回 null 回源」这条路。
 */
async function serveWeather(request, query, env, context) {
	const config = readConfig(env, context);
	if (!config) {
		// 边缘没配和风天气凭据 → 取不到数，按源站「未配置天气认证信息」同状态码作答
		return weatherError(403, BODY_NO_CREDENTIAL);
	}

	// 不带城市的那条路径靠客户端 IP 定位
	const located = query.name === '' ? geoQueryOf(request) : query;
	if (!located) {
		return weatherError(400, BODY_NO_CITY);
	}

	const store = createStore();
	const cacheKey = cacheKeyOf(located);

	if (store) {
		const cached = await readCache(store, cacheKey);
		if (cached !== null) {
			return weatherResponse(cached, 'hit');
		}
	}

	const result = await fetchWeather(config, located);
	if (!result.ok) {
		// 与源站的两条失败分支对齐：城市查不到 → 404「不存在」；上游取数失败 → 502
		return result.reason === 'location'
			? weatherError(404, BODY_NOT_FOUND)
			: weatherError(502, BODY_UPSTREAM_ERROR);
	}

	if (store) {
		await writeCache(store, cacheKey, result.body);
	}
	return weatherResponse(result.body, 'miss');
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
 * 任一项缺失都返回 null —— 边缘取不到数，由调用方按 403 作答（不回源，见文件头第 3 点）。
 * 除了文档承诺的第三个参数，也顺带看一眼 context：两个都不是时只返回 null，不会报错。
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

/**
 * 查和风天气。返回 `{ ok: true, body }` 或 `{ ok: false, reason }`。
 *
 * `reason` 区分「城市查不到」（源站回 404）与「上游取数失败」（源站回 502），
 * 好让边缘给出与源站一致的状态码——源站的 cityLookup 出任何错都是 404，
 * 所以这里 lookupLocation 失败一律记 location。
 */
async function fetchWeather(config, query) {
	const location = await lookupLocation(config, query);
	if (!location) {
		return { ok: false, reason: 'location' };
	}
	const now = await lookupNow(config, location.id);
	if (!now) {
		return { ok: false, reason: 'upstream' };
	}
	// 预警拿不到不算失败：源站也是这么处理的（warnResp, _ := ...）
	const alerts = await lookupWarning(config, location);
	return { ok: true, body: buildWeatherBody(location, now, alerts) };
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

/** 边缘就地判定的失败响应：状态码与响应体都按源站的契约给，只是不再回源 */
function weatherError(status, body) {
	return new Response(body, {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			[EDGE_HEADER]: 'error',
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
	ENV_MIN_CLIENT_VERSION,
	KV_NAMESPACE,
	MIN_VERSION_HEADER,
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
 * 回源请求：把 version 换成 0，强制源站重新计算整周快照。
 * 构造失败时退回原请求——那样最多拿回一个 304（客户端数据仍然是对的），不影响本次响应。
 */
function scheduleOriginRequest(request) {
	try {
		const url = new URL(request.url);
		url.searchParams.set('version', '0');
		return new Request(url.toString(), request);
	} catch (e) {
		return request;
	}
}

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

	// 命中判据与源站 304 判据对齐：只比「数据版本 + 教学周」这两件有身份意义的事实。
	// 版本串第三段是「最后一次生成快照那天 + 7 天」的滑动值（源站 service.VersionBoundary 里
	// dateOnly(now).AddDate(0, 0, 7)）：每台设备最后一次拿到 200 的日期不同，手上的值就不同。
	// 拿它做整串比较时，同一个班在边缘（只有一个 KV 槽）只能命中其中一台设备的串，其余全部回源，
	// 而源站对它们一律答 304 —— 这正是「本该在边缘答 304 的请求抵达源站」的原因。
	// 第三段只在 e 到点时触发一次回源复核；e = 0 表示源站当时没有已知的未来变化点
	// （源站 scheduleVersion 此时同样省略第三段），按源站口径就是「304 长期有效」，
	// 边缘不另加自造上界——陈旧窗口只由写入失效（删键）强制关闭。
	if (
		cached &&
		!scheduleExpired(cached.e) &&
		sameScheduleIdentity(cached.v, clientVersion)
	) {
		return new Response(null, {
			status: 304,
			headers: { [SCHEDULE_EDGE_HEADER]: 'hit' },
		});
	}

	// 回源带 version=0：源站不再用第三段判定 304，原样透传客户端版本只会换回一个没有响应体的
	// 304，边缘学不到源站当前的变化点；带 0 强制源站重算整周快照，才能把版本与到期时刻写进 KV。
	const response = await fetch(scheduleOriginRequest(request));

	// 源站回 304（回源带的是 version=0，正常路径下不会发生：只可能是源站还在用第三段判定，
	// 或运行时没接受改写后的请求）。无论哪种，**不能**把客户端那串写进 KV——那是拿请求者的私有值
	// 覆盖共享槽，同一个班的不同第三段互相踩，回源永远不收敛（源站只认数据版本与教学周，不会纠正它们）。
	if (response.status === 304) {
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

/**
 * 写入版本与到期时刻。到期时刻只取源站给的第三段（下一次可能变化时刻）；没有该段就存 0：
 * 源站 scheduleVersion 同样在没有已知未来变化点时省略第三段，语义是 304 长期有效
 * （usr-backend/router/client/getSchedule.go:186-197），边缘不另加上界。
 * 陈旧窗口由写入操作强制关闭：源站写入响应带 X-Astra-Purge-Scopes，handleMutating 删键后
 * 下一次读回源即拿到新的数据版本。写失败只影响下一次能否命中，本次响应照常返回。
 */
async function writeScheduleVersion(store, key, version) {
	const normalized = String(version || '');
	if (!normalized) {
		return;
	}
	const expiresAt = scheduleBoundaryOf(normalized);
	try {
		await store.put(
			key,
			JSON.stringify({ v: normalized, e: expiresAt }),
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
 * 没有该段说明当前没有已知的未来变化点，返回 0，原样写进 KV。
 * 0 只代表「没有已知变化点」，不代表版本串不会再变；但源站在这种情况下同样省略第三段、
 * 由写入推进 dataVersion 兜底，所以边缘不另加自造上界，陈旧窗口交给写入失效删键。
 */
export function scheduleBoundaryOf(version) {
	const parts = String(version || '').split(':');
	if (parts.length < 3) {
		return 0;
	}
	const boundary = Number(parts[2]);
	return Number.isFinite(boundary) && boundary > 0 ? Math.floor(boundary) : 0;
}

/**
 * 解析版本串 dataVersion:weekNumber[:变化点]，与源站 parseScheduleVersion 同口径：
 * 只认前两段，第二段之后（变化点）一律忽略，因此客户端可以不带它；
 * 只有一段时按旧客户端的纯数据版本处理，week 记 0（与任何 week >= 1 的复合版本都不同）。
 * 数据版本不是整数、或教学周不是 >= 1 的整数时返回 null，调用方一律按「不同」处理（回源更安全）。
 */
export function parseScheduleVersion(version) {
	const parts = String(version == null ? '' : version).split(':');
	const dataVersion = versionToNumber(parts[0]);
	if (dataVersion === null) {
		return null;
	}
	if (parts.length < 2) {
		return { dataVersion, week: 0 };
	}
	const week = versionToNumber(parts[1]);
	if (week === null || week < 1) {
		return null;
	}
	return { dataVersion, week };
}

/** 两个版本串的身份部分（数据版本 + 教学周）是否相同；任一侧解析不出来都算不同 */
export function sameScheduleIdentity(left, right) {
	const a = parseScheduleVersion(left);
	const b = parseScheduleVersion(right);
	return !!a && !!b && a.dataVersion === b.dataVersion && a.week === b.week;
}

function versionToNumber(part) {
	const text = String(part == null ? '' : part);
	return /^[+-]?\d+$/.test(text) ? Number(text) : null;
}

/**
 * 越过存下来的到期时刻就必须回源：即使版本串没变，命中结果也可能已经不同了。
 * 到期时刻就是源站给的第三段变化点（> 0）；e = 0 表示当时没有已知的未来变化点，
 * 永不到点——过期只能由写入失效（X-Astra-Purge-Scopes 触发的删键）强制。
 */
function scheduleExpired(boundary) {
	return boundary > 0 && nowSeconds() >= boundary;
}
