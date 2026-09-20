import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import edgeCache, {
	base64url,
	classIdOf,
	entryKeyOf,
	genKeyOf,
	parseExpire,
	readMeta,
} from '../src/index.js';

const HOST = 'class.getastra.cn';
const CLASS_PATH = '/39/2023/1';
const VERSION = '1758300000:12:1758384000';
// 相对当前时间取未来时刻：过期判定用的是边缘节点的真实时钟，写死时间戳会在将来变成「已过期」
const EXPIRE = Math.floor(Date.now() / 1000) + 3600;

/** 记录 KV 操作的内存实现，模拟 ESA 边缘 KV（get/put/delete + namespace 绑定） */
function installKv(options = {}) {
	const data = new Map();
	const calls = [];
	const namespaces = [];
	class FakeEdgeKV {
		constructor(config) {
			namespaces.push(config && config.namespace);
			this.namespace = config && config.namespace;
		}
		async get(key) {
			calls.push({ op: 'get', key });
			if (options.failGet) {
				throw new Error('kv get failed');
			}
			return data.has(key) ? data.get(key) : undefined;
		}
		async put(key, value) {
			calls.push({ op: 'put', key, value });
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
	return { data, calls, namespaces };
}

/** 安装假的源站，返回记录下来的请求列表 */
function installOrigin(handler) {
	const requests = [];
	globalThis.fetch = async (request) => {
		requests.push({
			url: request.url,
			method: request.method,
			headers: request.headers,
		});
		return handler(request, requests.length);
	};
	return requests;
}

function scheduleResponse(version = VERSION, expire = EXPIRE) {
	return new Response(JSON.stringify({ version, week_number: 12 }), {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'X-Astra-Schedule-Version': version,
			'X-Astra-Schedule-Expire': String(expire),
		},
	});
}

function getRequest(query = '?version=' + encodeURIComponent(VERSION), init = {}) {
	return new Request('https://' + HOST + CLASS_PATH + query, init);
}

const future = () => Math.floor(Date.now() / 1000) + 600;
const past = () => Math.floor(Date.now() / 1000) - 600;

let kv;
let origin;

beforeEach(() => {
	kv = installKv();
	origin = installOrigin(() => scheduleResponse());
});

afterEach(() => {
	delete globalThis.EdgeKV;
	delete globalThis.fetch;
});

describe('班级路径识别', () => {
	test('三段路径识别为班级，其余一律不处理', () => {
		expect(classIdOf('/39/2023/1')).toBe('39/2023/1');
		expect(classIdOf('/某某中学/2023级/1班')).toBe('某某中学/2023级/1班');
		expect(classIdOf('/')).toBe(null);
		expect(classIdOf('/39/2023')).toBe(null);
		expect(classIdOf('/39/2023/1/schedule')).toBe(null);
		expect(classIdOf('/web/config/2023')).toBe(null);
		expect(classIdOf('/api/weather/beijing')).toBe(null);
	});
});

describe('KV 键', () => {
	test('键只用 ESA 允许的字符：字母、数字、-、_ 和 .', () => {
		const key = entryKeyOf(HOST, '某某中学/2023级/1班');
		expect(key.startsWith('s1.' + HOST + '.')).toBe(true);
		expect(/^[0-9A-Za-z._-]+$/.test(key)).toBe(true);
		expect(key.length).toBeLessThanOrEqual(512);
	});

	test('base64url 与 UTF-8 编码正确（中文班级路径）', () => {
		const input = '某某中学/2023级/1班';
		const expected = Buffer.from(input, 'utf8')
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(base64url(input)).toBe(expected);
		expect(/^[0-9A-Za-z_-]+$/.test(base64url(input))).toBe(true);
	});

	test('世代键按 host 隔离', () => {
		expect(genKeyOf(HOST)).toBe('g1.' + HOST);
		expect(genKeyOf('AAA.GetAstra.CN')).toBe('g1.aaa.getastra.cn');
	});
});

describe('读取路径', () => {
	test('KV 未命中时回源，并把源站返回的元信息写入 KV', async () => {
		const response = await edgeCache.fetch(getRequest());

		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
		const stored = kv.data.get(entryKeyOf(HOST, '39/2023/1'));
		expect(JSON.parse(stored)).toMatchObject({ v: VERSION, e: EXPIRE, g: '' });
	});

	test('命中且未过期时直接回 304，不再回源', async () => {
		await edgeCache.fetch(getRequest());
		origin.length = 0;

		const response = await edgeCache.fetch(getRequest());

		expect(response.status).toBe(304);
		expect(response.headers.get('X-Astra-Edge-Cache')).toBe('hit');
		expect(response.headers.get('X-Astra-Schedule-Version')).toBe(VERSION);
		expect(origin).toHaveLength(0);
	});

	test('客户端版本不同则回源', async () => {
		await edgeCache.fetch(getRequest());
		origin.length = 0;

		const response = await edgeCache.fetch(
			getRequest('?version=' + encodeURIComponent('1:1:2')),
		);

		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('条目已过期（越过 expire）则回源', async () => {
		await edgeCache.fetch(
			new Request('https://' + HOST + CLASS_PATH + '?version=' + VERSION),
		);
		kv.data.set(
			entryKeyOf(HOST, '39/2023/1'),
			JSON.stringify({ v: VERSION, e: past(), g: '' }),
		);
		origin.length = 0;

		const response = await edgeCache.fetch(getRequest());

		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('源站返回 304 时用客户端版本刷新 KV 的过期时间', async () => {
		const expireAt = future();
		origin = installOrigin(
			() =>
				new Response(null, {
					status: 304,
					headers: { 'X-Astra-Schedule-Expire': String(expireAt) },
				}),
		);

		const response = await edgeCache.fetch(getRequest());

		expect(response.status).toBe(304);
		const stored = JSON.parse(kv.data.get(entryKeyOf(HOST, '39/2023/1')));
		expect(stored.v).toBe(VERSION);
		expect(stored.e).toBe(expireAt);

		origin.length = 0;
		expect((await edgeCache.fetch(getRequest())).status).toBe(304);
		expect(origin).toHaveLength(0);
	});

	test('源站没给元信息头时不缓存，下次仍然回源', async () => {
		origin = installOrigin(
			() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
		);

		expect((await edgeCache.fetch(getRequest())).status).toBe(200);
		expect(kv.data.size).toBe(0);

		origin.length = 0;
		expect((await edgeCache.fetch(getRequest())).status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('源站 5xx 不写入 KV', async () => {
		origin = installOrigin(
			() =>
				new Response('boom', {
					status: 500,
					headers: { 'X-Astra-Schedule-Expire': String(future()) },
				}),
		);

		expect((await edgeCache.fetch(getRequest())).status).toBe(500);
		expect(kv.data.size).toBe(0);
	});
});

describe('写入路径与失效', () => {
	test('写请求成功后推进世代，使同域名下所有班级的缓存失效', async () => {
		await edgeCache.fetch(getRequest());
		expect(kv.data.has(genKeyOf(HOST))).toBe(false);

		origin = installOrigin(() => new Response('ok', { status: 200 }));
		const put = await edgeCache.fetch(
			new Request('https://' + HOST + '/web/config/2023/1/1/schedule', {
				method: 'PUT',
				body: '{}',
			}),
		);
		expect(put.status).toBe(200);
		expect(kv.data.has(genKeyOf(HOST))).toBe(true);

		// 版本号没变，但世代变了：必须回源
		origin = installOrigin(() => scheduleResponse());
		const after = await edgeCache.fetch(getRequest());
		expect(after.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('写请求失败（4xx）不推进世代，缓存继续有效', async () => {
		await edgeCache.fetch(getRequest());

		origin = installOrigin(() => new Response('bad request', { status: 400 }));
		await edgeCache.fetch(
			new Request('https://' + HOST + '/web/config/2023/1/1/schedule', {
				method: 'PUT',
				body: '{}',
			}),
		);

		expect(kv.data.has(genKeyOf(HOST))).toBe(false);
		origin = installOrigin(() => scheduleResponse());
		expect((await edgeCache.fetch(getRequest())).status).toBe(304);
		expect(origin).toHaveLength(0);
	});

	test('客户端 PUT 班级课表同样推进世代', async () => {
		await edgeCache.fetch(getRequest());
		origin = installOrigin(() => new Response('ok', { status: 200 }));

		await edgeCache.fetch(
			new Request('https://' + HOST + CLASS_PATH, { method: 'PUT', body: '{}' }),
		);

		expect(kv.data.has(genKeyOf(HOST))).toBe(true);
	});
});

describe('降级与旁路', () => {
	test('请求带 Origin（浏览器跨域）时不走 304 快路径', async () => {
		await edgeCache.fetch(getRequest());
		origin.length = 0;

		const response = await edgeCache.fetch(
			getRequest(undefined, { headers: { Origin: 'https://njx.getastra.cn' } }),
		);

		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('班级 GET 之外的路径一律透传', async () => {
		const paths = ['/', '/39/2023', '/api/weather/beijing', '/web/config/2023/1/1/schedule'];
		for (const path of paths) {
			origin.length = 0;
			await edgeCache.fetch(new Request('https://' + HOST + path));
			expect(origin).toHaveLength(1);
		}
		expect(kv.data.size).toBe(0);
	});

	test('没有 version 参数时透传', async () => {
		await edgeCache.fetch(new Request('https://' + HOST + CLASS_PATH));
		expect(origin).toHaveLength(1);
		expect(kv.data.size).toBe(0);
	});

	test('KV 读写抛异常时降级为回源，不影响响应', async () => {
		kv = installKv({ failGet: true, failPut: true });
		const response = await edgeCache.fetch(getRequest());
		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('运行时没有 EdgeKV 全局时降级为回源', async () => {
		delete globalThis.EdgeKV;
		const response = await edgeCache.fetch(getRequest());
		expect(response.status).toBe(200);
		expect(origin).toHaveLength(1);
	});

	test('KV 绑定到正确的存储空间', async () => {
		await edgeCache.fetch(getRequest());
		expect(kv.namespaces.every((n) => n === 'astra')).toBe(true);
	});
});

describe('元信息解析', () => {
	test('parseExpire 只接受正整数秒', () => {
		expect(parseExpire('1758384000')).toBe(1758384000);
		expect(parseExpire('0')).toBe(0);
		expect(parseExpire('-1')).toBe(0);
		expect(parseExpire('abc')).toBe(0);
		expect(parseExpire('')).toBe(0);
		expect(parseExpire(null)).toBe(0);
		expect(parseExpire(undefined)).toBe(0);
	});

	test('源站版本串格式非法或缺少 expire 时 readMeta 返回 null', () => {
		const bad = (version, expire) =>
			new Response('{}', {
				status: 200,
				headers: {
					...(version === null ? {} : { 'X-Astra-Schedule-Version': version }),
					...(expire === null ? {} : { 'X-Astra-Schedule-Expire': expire }),
				},
			});

		expect(readMeta(bad(VERSION, '1758384000'), VERSION)).toEqual({
			v: VERSION,
			e: 1758384000,
		});
		// 版本串必须是纯 ASCII 且符合约定字符集（HTTP 头本身也不能承载非 ASCII 值）
		expect(readMeta(bad('bad version!', '1758384000'), VERSION)).toBe(null);
		expect(readMeta(bad('v/1', '1758384000'), VERSION)).toBe(null);
		expect(readMeta(bad('x'.repeat(129), '1758384000'), VERSION)).toBe(null);
		expect(readMeta(bad('', '1758384000'), VERSION)).toBe(null);
		expect(readMeta(bad(VERSION, null), VERSION)).toBe(null);
		expect(readMeta(bad(VERSION, 'abc'), VERSION)).toBe(null);
		expect(readMeta(new Response('{}', { status: 500 }), VERSION)).toBe(null);
	});
});

// 自审中发现的两个缺陷的回归用例：
// 1) 用「非 HEAD 就失效」会让跨域预检 OPTIONS 打掉整个域名的缓存；
// 2) 用 url.host 而非 url.hostname 会把非默认端口的冒号带进 KV 键。
describe('回归：只读方法与键字符集', () => {
	test('跨域预检 OPTIONS 返回 2xx 不推进世代，缓存继续有效', async () => {
		await edgeCache.fetch(getRequest());

		origin = installOrigin(() => new Response(null, { status: 204 }));
		await edgeCache.fetch(
			new Request('https://' + HOST + CLASS_PATH, { method: 'OPTIONS' }),
		);

		expect(kv.data.has(genKeyOf(HOST))).toBe(false);
		origin = installOrigin(() => scheduleResponse());
		expect((await edgeCache.fetch(getRequest())).status).toBe(304);
		expect(origin).toHaveLength(0);
	});

	test('HEAD 请求不推进世代', async () => {
		await edgeCache.fetch(getRequest());

		origin = installOrigin(() => new Response(null, { status: 200 }));
		await edgeCache.fetch(new Request('https://' + HOST + CLASS_PATH, { method: 'HEAD' }));

		expect(kv.data.has(genKeyOf(HOST))).toBe(false);
		origin = installOrigin(() => scheduleResponse());
		expect((await edgeCache.fetch(getRequest())).status).toBe(304);
		expect(origin).toHaveLength(0);
	});

	test('请求带非默认端口时键里不含冒号', async () => {
		await edgeCache.fetch(
			new Request('https://' + HOST + ':8443' + CLASS_PATH + '?version=' + VERSION),
		);

		const keys = [...kv.data.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).not.toContain(':');
		expect(keys[0]).toBe(entryKeyOf(HOST, '39/2023/1'));
	});

	test('源站给出的过期时刻已经过去时不写入 KV', async () => {
		origin = installOrigin(() => scheduleResponse(VERSION, past()));

		const response = await edgeCache.fetch(getRequest());

		expect(response.status).toBe(200);
		expect(kv.data.size).toBe(0);
	});
});
