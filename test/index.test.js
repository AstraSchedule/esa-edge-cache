import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import edgeWeather, {
	base64url,
	buildWeatherBody,
	cacheKeyOf,
	geoQueryOf,
	readConfig,
	weatherQueryOf,
} from '../src/index.js';

const QW_HOST = 'qu7qqnuwvp.re.qweatherapi.com';
const QW_KEY = 'test-api-key';
const ENV = { QW_API_HOST: QW_HOST, QW_API_KEY: QW_KEY };
const HOST = 'class.getastra.cn';
const CITY = '北京';
const ADM = '北京市';
// 相对当前时间取未来时刻：过期判定用的是边缘节点的真实时钟，写死时间戳会在将来变成「已过期」
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600;

/** 和风天气三个接口的真实响应片段（字段名与 QWeather v7 / geo v2 / weatheralert v1 一致） */
const LOCATION_BODY = {
	code: '200',
	location: [{ id: '101010100', lat: '39.90499', lon: '116.40529', name: '北京' }],
};
const NOW_BODY = {
	code: '200',
	now: { temp: '21', text: '晴', windDir: '东南风', windScale: '1' },
};
const ALERT_BODY = {
	alerts: [{ description: '高温\n预警', headline: '高温预警' }],
};

/** 记录 KV 操作的内存实现，模拟 ESA 边缘 KV（get/put/delete + namespace 绑定） */
function installKv(options = {}) {
	const data = new Map();
	const namespaces = [];
	class FakeEdgeKV {
		constructor(config) {
			namespaces.push(config && config.namespace);
			this.namespace = config && config.namespace;
		}
		async get(key) {
			if (options.failGet) {
				throw new Error('kv get failed');
			}
			return data.has(key) ? data.get(key) : undefined;
		}
		async put(key, value) {
			if (options.failPut) {
				throw new Error('kv put failed');
			}
			data.set(key, String(value));
			return undefined;
		}
		async delete(key) {
			return data.delete(key);
		}
	}
	globalThis.EdgeKV = FakeEdgeKV;
	return { data, namespaces };
}

function jsonResponse(body) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

/**
 * 安装假的 fetch：和风天气那三个接口按 path 命中 qweather 处理器，
 * 其余一律记成「回源」，与真实环境里 fetch(request) 打到源站 FC 对应。
 *
 * 记录数组固定在 out 上、由 installFetch 清空后复用：测试里重新安装时不会丢记录。
 */
function installFetch(qweather) {
	out.upstream.length = 0;
	out.origin.length = 0;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input.url;
		// 上游那三个请求用的是 fetch(url, { headers })，回源用的是 fetch(request)
		const headers = new Headers(
			(init && init.headers) || (typeof input === 'string' ? undefined : input.headers),
		);
		if (url.startsWith('https://' + QW_HOST)) {
			out.upstream.push({ url, headers });
			return qweather(url, out.upstream.length);
		}
		out.origin.push({ url, request: input });
		return new Response('origin', { status: 200 });
	};
}

const defaultQweather = (url) => {
	if (url.includes('/geo/v2/city/lookup')) return jsonResponse(LOCATION_BODY);
	if (url.includes('/v7/weather/now')) return jsonResponse(NOW_BODY);
	return jsonResponse(ALERT_BODY);
};

function request(path, init = {}, info) {
	const req = new Request('https://' + HOST + path, init);
	if (info !== undefined) {
		// ESA 运行时会在 request 上挂 `info`（客户端 IP/地域），这里照原样模拟
		req.info = info;
	}
	return req;
}

const weatherPath = '/api/weather/' + encodeURIComponent(CITY);
const weatherPathWithAdm = weatherPath + '/' + encodeURIComponent(ADM);

let kv;
const out = { upstream: [], origin: [] };

beforeEach(() => {
	kv = installKv();
	installFetch(defaultQweather);
});

afterEach(() => {
	delete globalThis.EdgeKV;
	delete globalThis.fetch;
});

async function call(req = request(weatherPath), env = ENV) {
	return edgeWeather.fetch(req, {}, env);
}

describe('路径识别', () => {
	test('只认 /api/weather/<城市>[/<省份>]，且按 UTF-8 解码', () => {
		expect(weatherQueryOf('/api/weather/%E5%8C%97%E4%BA%AC')).toEqual({
			name: '北京',
			adm: '',
		});
		expect(weatherQueryOf('/api/weather/%E5%8C%97%E4%BA%AC/%E5%8C%97%E4%BA%AC%E5%B8%82')).toEqual({
			name: '北京',
			adm: '北京市',
		});
		// 未编码的中文（测试/手工 curl 可能这么打）也要能认出来
		expect(weatherQueryOf('/api/weather/北京')).toEqual({ name: '北京', adm: '' });
	});

	test('两段的 /api/weather/ 识别为「不带城市」，其余路径不接管', () => {
		expect(weatherQueryOf('/api/weather/')).toEqual({ name: '', adm: '' });
		expect(weatherQueryOf('/api/weather')).toEqual({ name: '', adm: '' });
		expect(weatherQueryOf('/api/weather/a/b/c')).toBe(null);
		expect(weatherQueryOf('/api/config/北京')).toBe(null);
		expect(weatherQueryOf('/39/2023/1班')).toBe(null);
		expect(weatherQueryOf('/')).toBe(null);
	});

	test('畸形或超长的城市名不接管', () => {
		expect(weatherQueryOf('/api/weather/%E5')).toBe(null, '非法百分号序列要拒绝，不能抛异常');
		expect(weatherQueryOf('/api/weather/' + 'x'.repeat(65))).toBe(null);
		expect(weatherQueryOf('/api/weather/a%2Fb')).toBe(null, '解码出路径分隔符的要拒绝');
		expect(weatherQueryOf('/api/weather/a%08b')).toBe(null, '控制字符要拒绝');
	});
});

describe('缓存键', () => {
	test('键只用 ESA 允许的字符：字母、数字、-、_ 和 .', () => {
		const key = cacheKeyOf({ name: '某某中学', adm: '某某省' });
		expect(key.startsWith('w1.')).toBe(true);
		expect(/^[0-9A-Za-z._-]+$/.test(key)).toBe(true);
		expect(key.length).toBeLessThanOrEqual(512);
	});

	test('base64url 与 UTF-8 编码正确', () => {
		const expected = Buffer.from('北京', 'utf8')
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(base64url('北京')).toBe(expected);
	});

	test('键无歧义：城市与省份不会串位，有无省份也不同键', () => {
		const a = cacheKeyOf({ name: 'A/B', adm: '' });
		const b = cacheKeyOf({ name: 'A', adm: '/B' });
		expect(a).not.toBe(b);
		expect(cacheKeyOf({ name: '北京', adm: '' })).not.toBe(
			cacheKeyOf({ name: '北京', adm: '北京市' }),
		);
	});
});

describe('读取路径', () => {
	test('未命中时边缘自己查和风天气，返回与源站同形的响应并写缓存', async () => {
		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('miss');
		expect(out.upstream).toHaveLength(3, '城市查询 + 实时天气 + 预警');
		expect(out.origin).toHaveLength(0, '不该回源');
		expect(await response.json()).toEqual({
			where: '北京',
			temp: '21',
			weat: '晴',
			wind: '东南风',
			wind_power: '1',
			warn: '高温预警',
			brief_warn: '高温预警',
		});

		const stored = JSON.parse(kv.data.get(cacheKeyOf({ name: CITY, adm: '' })));
		expect(typeof stored.b).toBe('string');
		expect(stored.e).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	test('命中时不再查和风天气，也不回源', async () => {
		await call();
		out.upstream.length = 0;
		out.origin.length = 0;

		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('hit');
		expect(out.upstream).toHaveLength(0);
		expect(out.origin).toHaveLength(0);
		expect((await response.json()).temp).toBe('21');
	});

	test('条目过期后重新查和风天气', async () => {
		await call();
		kv.data.set(
			cacheKeyOf({ name: CITY, adm: '' }),
			JSON.stringify({ b: '{"temp":"旧"}', e: Math.floor(Date.now() / 1000) - 1 }),
		);
		out.upstream.length = 0;

		const response = await call();

		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('miss');
		expect(out.upstream).toHaveLength(3);
		expect((await response.json()).temp).toBe('21');
	});

	test('KV 里的值格式不认识时按未命中处理', async () => {
		kv.data.set(cacheKeyOf({ name: CITY, adm: '' }), 'not-json');

		const response = await call();

		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('miss');
		expect(out.upstream).toHaveLength(3);
	});

	test('省份参与查询：带上 adm 参数，并落进独立的缓存键', async () => {
		await call(request(weatherPathWithAdm));

		const lookup = out.upstream.find((u) => u.url.includes('/geo/v2/city/lookup'));
		expect(decodeURIComponent(lookup.url)).toContain('location=北京&adm=北京市');
		expect(kv.data.has(cacheKeyOf({ name: CITY, adm: ADM }))).toBe(true);
		expect(kv.data.has(cacheKeyOf({ name: CITY, adm: '' }))).toBe(false);
	});
});

// 不带城市的老路径原来靠 Cloudflare 的 CF-IPCity 头；站点迁到 ESA 之后改用运行时的
// request.info（实测字段：ip_city_en / ip_region_en / ip_city_id / remote_addr ...）。
describe('不带城市：用 request.info 定位客户端所在城市', () => {
	const INFO = {
		ip_city_en: 'Nanjing',
		ip_region_en: 'Jiangsu',
		ip_region_id: 'CN-JS',
		ip_city_id: '320100',
		remote_addr: '180.111.34.224',
	};

	test('有 request.info 时在边缘查天气，并按定位到的城市写缓存', async () => {
		const response = await edgeWeather.fetch(request('/api/weather/', {}, INFO), {}, ENV);

		expect(response.status).toBe(200);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('miss');
		expect(out.origin).toHaveLength(0, '不该回源');
		const lookup = out.upstream.find((u) => u.url.includes('/geo/v2/city/lookup'));
		expect(lookup.url).toContain('location=Nanjing');
		expect(lookup.url).not.toContain('adm=', '只传城市名，省名对不上和风天气词表时反而多一种失败模式');
		expect(kv.data.has(cacheKeyOf({ name: 'Nanjing', adm: '' }))).toBe(true);
	});

	test('定位结果同样吃缓存', async () => {
		await edgeWeather.fetch(request('/api/weather/', {}, INFO), {}, ENV);
		out.upstream.length = 0;

		const response = await edgeWeather.fetch(request('/api/weather/', {}, INFO), {}, ENV);

		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('hit');
		expect(out.upstream).toHaveLength(0);
	});

	test('没有 request.info 时在边缘回 400，不回源', async () => {
		const response = await call(request('/api/weather/'));

		expect(response.status).toBe(400);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('error');
		expect((await response.json()).error).toContain('定位城市');
		expect(out.origin).toHaveLength(0);
		expect(out.upstream).toHaveLength(0);
	});

	test('info 里只有国家、没有城市时同样在边缘回 400，不回源', async () => {
		const response = await edgeWeather.fetch(
			request('/api/weather/', {}, { ip_country_id: 'CN', ip_country_en: 'China' }),
			{},
			ENV,
		);

		expect(response.status).toBe(400);
		expect(out.origin).toHaveLength(0);
		expect(out.upstream).toHaveLength(0);
	});

	test('城市名非法时不用它', () => {
		expect(geoQueryOf({ info: { ip_city_en: 'Nanjing' } })).toEqual({
			name: 'Nanjing',
			adm: '',
		});
		expect(geoQueryOf({ info: { ip_city_en: 'a/b' } })).toBe(null);
		expect(geoQueryOf({ info: { ip_city_en: 'x'.repeat(65) } })).toBe(null);
		expect(geoQueryOf({ info: { ip_city_en: '   ' } })).toBe(null);
		expect(geoQueryOf({ info: {} })).toBe(null);
		expect(geoQueryOf({ info: 'not-an-object' })).toBe(null);
		expect(geoQueryOf({})).toBe(null);
		expect(geoQueryOf(undefined)).toBe(null);
	});
});

describe('失败处理与旁路', () => {
	test('没配函数变量时回 403，不回源也不查上游', async () => {
		kv = installKv();
		installFetch(defaultQweather);

		const response = await call(request(weatherPath), {});

		expect(response.status).toBe(403);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('error');
		expect((await response.json()).error).toContain('QW_API_HOST');
		expect(out.upstream).toHaveLength(0);
		expect(out.origin).toHaveLength(0);
		expect(kv.data.size).toBe(0);
	});

	test('和风天气城市查询失败时回 404「不存在」，不回源', async () => {
		installFetch(() => jsonResponse({ code: '404' }));

		const response = await call();

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			temp: '404',
			weat: '不存在',
			warning: '',
			brief_warn: '',
		});
		expect(out.origin).toHaveLength(0);
	});

	test('和风天气实时天气失败（temp 为空）时回 502，不回源', async () => {
		installFetch((url) => {
			if (url.includes('/geo/v2/city/lookup')) return jsonResponse(LOCATION_BODY);
			if (url.includes('/v7/weather/now')) return jsonResponse({ code: '200', now: {} });
			return jsonResponse(ALERT_BODY);
		});

		const response = await call();

		expect(response.status).toBe(502);
		expect((await response.json()).error).toContain('超过最大重试次数');
		expect(out.origin).toHaveLength(0);
	});

	test('和风天气返回非 200 或非 JSON 时由边缘作答，不回源', async () => {
		// 城市查询（第一个上游请求）失败：源站 cityLookup 出任何错都是 404，边缘照抄
		installFetch(() => new Response('boom', { status: 502 }));
		expect((await call()).status).toBe(404);
		expect(out.origin).toHaveLength(0);

		installFetch(() => new Response('not json', { status: 200 }));
		expect((await call()).status).toBe(404);
		expect(out.origin).toHaveLength(0);
	});

	test('预警接口失败不影响天气返回', async () => {
		installFetch((url) => {
			if (url.includes('/geo/v2/city/lookup')) return jsonResponse(LOCATION_BODY);
			if (url.includes('/v7/weather/now')) return jsonResponse(NOW_BODY);
			return new Response('nope', { status: 500 });
		});

		const response = await call();

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.temp).toBe('21');
		expect(body.warn).toBe('');
		expect(body.brief_warn).toBe('');
	});

	test('KV 读写抛异常时仍然返回天气', async () => {
		kv = installKv({ failGet: true, failPut: true });

		const response = await call();

		expect(response.status).toBe(200);
		expect((await response.json()).temp).toBe('21');
	});

	test('运行时没有 EdgeKV 全局时不缓存，但天气照常返回', async () => {
		delete globalThis.EdgeKV;

		const response = await call();

		expect(response.status).toBe(200);
		expect((await response.json()).temp).toBe('21');
	});

	test('KV 绑定到正确的存储空间', async () => {
		await call();
		expect(kv.namespaces.every((n) => n === 'astra')).toBe(true);
	});

	test('非天气路径与非 GET 方法一律透传', async () => {
		const paths = ['/', '/39/2023/1', '/api/weather/a/b/c', '/api/weather/a/b/c/d', '/web/config/2023'];
		for (const path of paths) {
			out.origin.length = 0;
			await edgeWeather.fetch(request(path), {}, ENV);
			expect(out.origin).toHaveLength(1);
		}
		out.origin.length = 0;
		await edgeWeather.fetch(request(weatherPath, { method: 'POST', body: '{}' }), {}, ENV);
		expect(out.origin).toHaveLength(1);

		expect(out.upstream).toHaveLength(0);
		expect(kv.data.size).toBe(0);
	});

	test('上游抛异常时回 502，既不回源也不把异常抛给客户端', async () => {
		installFetch(() => {
			throw new Error('upstream exploded');
		});

		const response = await call();

		expect(response.status).toBe(502);
		expect(response.headers.get('X-Astra-Edge-Weather')).toBe('error');
		expect(out.origin).toHaveLength(0);
	});
});

describe('上游请求', () => {
	test('中文城市名进入上游 URL 前被编码，且带上 API Key 头', async () => {
		await call();

		const lookup = out.upstream[0];
		expect(lookup.url).not.toContain('北京');
		expect(lookup.url).toContain(encodeURIComponent('北京'));
		expect(lookup.headers.get('X-QW-Api-Key')).toBe(QW_KEY);
	});

	test('预警用 5 位小数的经纬度，与源站一致', async () => {
		await call();

		const alert = out.upstream.find((u) => u.url.includes('/weatheralert/'));
		expect(alert.url.endsWith('/39.90499/116.40529')).toBe(true);
	});

	test('环境变量主机名非法时不发起上游请求，按未配置回 403', async () => {
		const response = await call(request(weatherPath), {
			QW_API_HOST: 'evil.example.com/x?',
			QW_API_KEY: QW_KEY,
		});

		expect(response.status).toBe(403);
		expect(out.upstream).toHaveLength(0);
		expect(out.origin).toHaveLength(0);
	});
});

describe('配置读取', () => {
	test('env 缺失时回退到 context，两个都没有则视为未配置', () => {
		expect(readConfig(ENV, {})).toEqual({ host: QW_HOST, key: QW_KEY });
		expect(readConfig({}, { QW_API_HOST: QW_HOST, QW_API_KEY: QW_KEY })).toEqual({
			host: QW_HOST,
			key: QW_KEY,
		});
		expect(readConfig({}, {})).toBe(null);
		expect(readConfig(undefined, undefined)).toBe(null);
		expect(readConfig({ QW_API_HOST: QW_HOST }, {})).toBe(null, '缺 API Key 不接管');
		expect(readConfig({ QW_API_KEY: QW_KEY }, {})).toBe(null, '缺主机名不接管');
	});
});

describe('响应体组装', () => {
	test('多条预警用中文分号拼接，描述里的换行被去掉（与源站一致）', () => {
		const body = JSON.parse(
			buildWeatherBody(
				{ name: '北京' },
				{ temp: '1', text: '晴', windDir: '风', windScale: '2' },
				[
					{ description: 'a\nb', headline: 'A' },
					{ description: 'c', headline: 'B' },
				],
			),
		);
		expect(body.warn).toBe('ab；c');
		expect(body.brief_warn).toBe('A；B');
	});

	test('预警数组里混入非对象项时跳过，不炸', () => {
		const body = JSON.parse(
			buildWeatherBody({ name: 'x' }, { temp: '1', text: '', windDir: '', windScale: '' }, [
				null,
				'junk',
				{ description: 'ok', headline: 'OK' },
			]),
		);
		expect(body.warn).toBe('ok');
	});
});
