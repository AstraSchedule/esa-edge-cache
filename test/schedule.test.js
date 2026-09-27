import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import edgeCache, {
	classPathOf,
	keyOfScheduleParts,
	purgeKeysOf,
	scheduleBoundaryOf,
	versionOfScheduleBody,
} from '../src/index.js';

const HOST = 'class.getastra.cn';
const SCHEDULE_KEY = keyOfScheduleParts(HOST, ['39', '2023', '1']);
const NOW = () => Math.floor(Date.now() / 1000);

/** 内存 KV，记录 delete 以便断言失效范围 */
function installKv(options = {}) {
	const data = new Map(options.seed || []);
	const deleted = [];
	class FakeEdgeKV {
		constructor(config) {
			this.namespace = config && config.namespace;
		}
		async get(key) {
			if (options.failGet) throw new Error('kv get failed');
			return data.has(key) ? data.get(key) : undefined;
		}
		async put(key, value) {
			if (options.failPut) throw new Error('kv put failed');
			data.set(key, String(value));
			return undefined;
		}
		async delete(key) {
			deleted.push(key);
			return data.delete(key);
		}
	}
	globalThis.EdgeKV = FakeEdgeKV;
	return { data, deleted };
}

/** 拦截回源：记录请求，按 handler 返回响应 */
function installFetch(handler) {
	const calls = [];
	globalThis.fetch = async (input) => {
		const req = input instanceof Request ? input : new Request(input);
		calls.push(req.url);
		const res = await handler(req);
		return res === undefined ? new Response('origin', { status: 200 }) : res;
	};
	return calls;
}

function scheduleRequest(path = '/39/2023/1', search = '?version=v1', init = {}) {
	return new Request('https://' + HOST + path + search, { method: 'GET', ...init });
}

function scheduleBody(version) {
	return new Response(JSON.stringify({ version, daily_class: [] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	delete globalThis.EdgeKV;
});
afterEach(() => {
	delete globalThis.EdgeKV;
});

describe('路径与键', () => {
	test('只认恰好三段的班级路径', () => {
		expect(classPathOf('/39/2023/1')).toEqual({ school: '39', grade: '2023', class: '1' });
		expect(classPathOf('/web/config/a/b')).toBeNull();
		expect(classPathOf('/api/weather/北京')).toBeNull();
		expect(classPathOf('/39/2023')).toBeNull();
		expect(classPathOf('/39/2023/1/extra')).toBeNull();
		expect(classPathOf('/')).toBeNull();
	});

	test('键带 host 与 s1. 前缀，各段 base64url', () => {
		expect(SCHEDULE_KEY.startsWith('s1.')).toBe(true);
		expect(SCHEDULE_KEY).toBe(
			's1.' +
				Buffer.from(HOST).toString('base64url') +
				'.' +
				Buffer.from('39').toString('base64url') +
				'.' +
				Buffer.from('2023').toString('base64url') +
				'.' +
				Buffer.from('1').toString('base64url'),
		);
	});

	test('purge scope 只接受三段，非法项跳过', () => {
		expect(purgeKeysOf(HOST, '39/2023/1')).toEqual([SCHEDULE_KEY]);
		expect(purgeKeysOf(HOST, '39/2023/1, 39/2023/2 , 39/2023')).toEqual([
			SCHEDULE_KEY,
			keyOfScheduleParts(HOST, ['39', '2023', '2']),
		]);
		expect(purgeKeysOf(HOST, '')).toEqual([]);
		expect(purgeKeysOf(HOST, 'web/users')).toEqual([]);
	});

	test('版本串第三段是变化点，缺失则为 0', () => {
		expect(scheduleBoundaryOf('100:3:200')).toBe(200);
		expect(scheduleBoundaryOf('100:3')).toBe(0);
		expect(scheduleBoundaryOf('')).toBe(0);
		expect(scheduleBoundaryOf('100:3:abc')).toBe(0);
	});

	test('从响应体取 version', () => {
		expect(versionOfScheduleBody('{"version":"1:2:3"}')).toBe('1:2:3');
		expect(versionOfScheduleBody('not json')).toBe('');
		expect(versionOfScheduleBody('{"version":123}')).toBe('');
	});
});

describe('读路径', () => {
	test('KV 命中且未过变化点 → 304，不回源', async () => {
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'v1', e: NOW() + 3600 })]] });
		const calls = installFetch(() => new Response('should not happen', { status: 500 }));

		const res = await edgeCache.fetch(scheduleRequest(), {}, {});

		expect(res.status).toBe(304);
		expect(calls.length).toBe(0);
		expect(kv.deleted.length).toBe(0);
	});

	test('版本不同 → 回源，并按响应体刷新 KV', async () => {
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'old', e: NOW() + 3600 })]] });
		const calls = installFetch(() => scheduleBody('100:3:200'));

		const res = await edgeCache.fetch(scheduleRequest(), {}, {});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		// 按响应体的 version 刷新，变化点取版本串第三段
		expect(kv.data.get(SCHEDULE_KEY)).toBe(JSON.stringify({ v: '100:3:200', e: 200 }));
	});

	test('越过变化点 → 即使版本相同也回源', async () => {
		installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'v1', e: NOW() - 1 })]] });
		const calls = installFetch(() => scheduleBody('v1'));

		const res = await edgeCache.fetch(scheduleRequest('', '?version=v1'), {}, {});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});

	test('源站返回 304 时，用客户端版本把 KV 补上', async () => {
		const kv = installKv({});
		installFetch(() => new Response(null, { status: 304 }));

		const res = await edgeCache.fetch(scheduleRequest('/39/2023/1', '?version=100:3:200'), {}, {});

		expect(res.status).toBe(304);
		expect(kv.data.get(SCHEDULE_KEY)).toBe(JSON.stringify({ v: '100:3:200', e: 200 }));
	});

	test('不带 version 参数不接管（交回源）', async () => {
		installKv({});
		const calls = installFetch(() => new Response('origin', { status: 200 }));

		const res = await edgeCache.fetch(scheduleRequest('/39/2023/1', ''), {}, {});

		expect(await res.text()).toBe('origin');
		expect(calls.length).toBe(1);
	});

	test('KV 抛异常时仍正常回源', async () => {
		installKv({ failGet: true });
		const calls = installFetch(() => scheduleBody('100:3:200'));

		const res = await edgeCache.fetch(scheduleRequest(), {}, {});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});
});

describe('写路径的缓存失效', () => {
	test('按 X-Astra-Purge-Scopes 删除对应键', async () => {
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'v1', e: NOW() + 3600 })]] });
		const calls = installFetch(
			() =>
				new Response(JSON.stringify({ status: 200 }), {
					status: 200,
					headers: { 'X-Astra-Purge-Scopes': '39/2023/1' },
				}),
		);
		const req = new Request('https://' + HOST + '/web/config/39/2023/1/schedule', { method: 'PUT' });

		const res = await edgeCache.fetch(req, {}, {});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		expect(kv.deleted).toEqual([SCHEDULE_KEY]);
	});

	test('没有失效头时不删除、不报错、正常返回', async () => {
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'v1', e: NOW() + 3600 })]] });
		installFetch(() => new Response(JSON.stringify({ status: 200 }), { status: 200 }));
		const req = new Request('https://' + HOST + '/web/users', { method: 'POST' });

		const res = await edgeCache.fetch(req, {}, {});

		expect(res.status).toBe(200);
		expect(kv.deleted).toEqual([]);
		expect(kv.data.has(SCHEDULE_KEY)).toBe(true);
	});

	test('失效头里是非法 scope 时同样不报错', async () => {
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: 'v1', e: NOW() + 3600 })]] });
		installFetch(
			() => new Response('{}', { status: 200, headers: { 'X-Astra-Purge-Scopes': 'ALL,,/web/x' } }),
		);
		const req = new Request('https://' + HOST + '/web/config/copy', { method: 'POST' });

		const res = await edgeCache.fetch(req, {}, {});

		expect(res.status).toBe(200);
		expect(kv.deleted).toEqual([]);
	});
});
