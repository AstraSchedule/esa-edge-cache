import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import edgeCache, {
	classPathOf,
	keyOfScheduleParts,
	parseScheduleVersion,
	purgeKeysOf,
	sameScheduleIdentity,
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

	test('版本串只按前两段判身份，第三段忽略', () => {
		expect(parseScheduleVersion('100:3:200')).toEqual({ dataVersion: 100, week: 3 });
		expect(parseScheduleVersion('100:3')).toEqual({ dataVersion: 100, week: 3 });
		expect(parseScheduleVersion('100')).toEqual({ dataVersion: 100, week: 0 });
		expect(parseScheduleVersion('100:0')).toBeNull();
		expect(parseScheduleVersion('100:abc')).toBeNull();
		expect(parseScheduleVersion('abc:3')).toBeNull();
		expect(parseScheduleVersion('')).toBeNull();
		expect(sameScheduleIdentity('100:3:5', '100:3:999')).toBe(true);
		expect(sameScheduleIdentity('100:3', '100:3:999')).toBe(true);
		expect(sameScheduleIdentity('100:4:5', '100:3:5')).toBe(false);
		expect(sameScheduleIdentity('100:3:5', 'v1')).toBe(false);
		expect(sameScheduleIdentity('', '')).toBe(false);
	});

	test('从响应体取 version', () => {
		expect(versionOfScheduleBody('{"version":"1:2:3"}')).toBe('1:2:3');
		expect(versionOfScheduleBody('not json')).toBe('');
		expect(versionOfScheduleBody('{"version":123}')).toBe('');
	});
});

/** 命中用例的公共摆设法：种一条 KV，并让「回源」必然失败——真回源了就说明没命中 */
async function scheduleHitCase({ seedVersion, requestVersion }) {
	const kv = installKv({
		seed: [[SCHEDULE_KEY, JSON.stringify({ v: seedVersion, e: NOW() + 3600 })]],
	});
	const calls = installFetch(() => new Response('should not happen', { status: 500 }));
	const res = await edgeCache.fetch(
		scheduleRequest('/39/2023/1', `?version=${encodeURIComponent(requestVersion)}`),
		{},
		{},
	);
	return { res, calls, kv };
}

/** 回源用例的公共摆设法：种一条 KV（可注入失败模式），源站按 originVersion 回 200 */
async function scheduleMissCase({ seed, search, originVersion = '100:3:200', kvOptions = {} }) {
	const kv = installKv({ ...kvOptions, seed });
	const calls = installFetch(() => scheduleBody(originVersion));
	const res = await edgeCache.fetch(scheduleRequest('/39/2023/1', search), {}, {});
	return { res, calls, kv };
}

describe('读路径', () => {
	test('同数据版本/教学周、第三段不同但未到变化点 → 304，不回源', async () => {
		// 线上故障的核心用例：同一个班的多台设备各带自己那天生成的第三段，
		// 源站只会答 304，边缘必须也能就地答 304，不能再回源
		const { res, calls, kv } = await scheduleHitCase({
			seedVersion: '100:3:1791388800',
			requestVersion: '100:3:1791129600',
		});

		expect(res.status).toBe(304);
		expect(res.headers.get('X-Astra-Edge-Schedule')).toBe('hit');
		expect(calls.length).toBe(0);
		expect(kv.deleted.length).toBe(0);
	});

	test('版本串完全相同也命中 304', async () => {
		const { res, calls } = await scheduleHitCase({
			seedVersion: '100:3:200',
			requestVersion: '100:3:200',
		});

		expect(res.status).toBe(304);
		expect(calls.length).toBe(0);
	});

	test('客户端不带第三段（纯 dataVersion:week）同样命中', async () => {
		const { res, calls } = await scheduleHitCase({
			seedVersion: '100:3:1791388800',
			requestVersion: '100:3',
		});

		expect(res.status).toBe(304);
		expect(calls.length).toBe(0);
	});

	test('教学周不同 → 回源', async () => {
		const { res, calls } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '100:5:1791388800', e: NOW() + 3600 })]],
			search: '?version=100:3:1791388800',
			originVersion: '100:5:1791388800',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});

	test('数据版本不同 → 回源（带 version=0），并按响应体刷新 KV', async () => {
		const { res, calls, kv } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '99:3:1791388800', e: NOW() + 3600 })]],
			search: '?version=100:3:1791129600',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		// 源站已不用第三段判定：透传客户端版本只会换回没有响应体的 304，学不到新变化点
		expect(new URL(calls[0]).searchParams.get('version')).toBe('0');
		// 按响应体的 version 刷新，变化点取版本串第三段
		expect(kv.data.get(SCHEDULE_KEY)).toBe(JSON.stringify({ v: '100:3:200', e: 200 }));
	});

	test('版本串无法解析 → 一律回源，不猜身份', async () => {
		const { res, calls } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '100:3:200', e: NOW() + 3600 })]],
			search: '?version=v1',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});

	test('越过变化点 → 即使数据版本/教学周相同也回源', async () => {
		const { res, calls } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '100:3:200', e: NOW() - 1 })]],
			search: '?version=100:3:200',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});

	test('版本串没有变化点段时写软过期，不写「永不过期」', async () => {
		const kv = installKv({});
		installFetch(() => scheduleBody('100:3'));

		const first = await edgeCache.fetch(scheduleRequest(), {}, {});

		expect(first.status).toBe(200);
		const stored = JSON.parse(kv.data.get(SCHEDULE_KEY));
		expect(stored.v).toBe('100:3');
		// 没有变化点 ≠ 永不过期：到期时刻必须有界且非 0
		expect(stored.e).toBeGreaterThan(NOW());
		expect(stored.e).toBeLessThanOrEqual(NOW() + 600);

		// 软过期未到之前，同一版本仍然命中 304
		const second = await edgeCache.fetch(scheduleRequest('/39/2023/1', '?version=100:3'), {}, {});
		expect(second.status).toBe(304);
		expect(second.headers.get('X-Astra-Edge-Schedule')).toBe('hit');
	});

	test('软过期到点后回源复核，不再替客户端答 304', async () => {
		const { res, calls } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '100:3', e: NOW() - 1 })]],
			search: '?version=100:3',
			originVersion: '100:3',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
	});

	test('源站回 304 时不改写 KV（不用请求者的私有第三段覆盖共享槽）', async () => {
		const expired = NOW() - 1;
		const kv = installKv({ seed: [[SCHEDULE_KEY, JSON.stringify({ v: '100:3:200', e: expired })]] });
		installFetch(() => new Response(null, { status: 304 }));

		const res = await edgeCache.fetch(scheduleRequest('/39/2023/1', '?version=100:3:999'), {}, {});

		expect(res.status).toBe(304);
		expect(res.headers.get('X-Astra-Edge-Schedule')).toBe('revalidated');
		// 槽里仍是原来那一条：回源带的是 version=0，正常路径下源站不会回 304
		expect(kv.data.get(SCHEDULE_KEY)).toBe(JSON.stringify({ v: '100:3:200', e: expired }));
	});

	test('旧版本写下的「没有到期时刻」条目（e=0）不再信任，回源一次并补上到期时刻', async () => {
		const { res, calls, kv } = await scheduleMissCase({
			seed: [[SCHEDULE_KEY, JSON.stringify({ v: '1772129866:31', e: 0 })]],
			search: '?version=1772129866:31',
			originVersion: '1772129866:31:1791388800',
		});

		expect(res.status).toBe(200);
		expect(calls.length).toBe(1);
		expect(kv.data.get(SCHEDULE_KEY)).toBe(
			JSON.stringify({ v: '1772129866:31:1791388800', e: 1791388800 }),
		);
	});

	test('不带 version 参数不接管（交回源）', async () => {
		installKv({});
		const calls = installFetch(() => new Response('origin', { status: 200 }));

		const res = await edgeCache.fetch(scheduleRequest('/39/2023/1', ''), {}, {});

		expect(await res.text()).toBe('origin');
		expect(calls.length).toBe(1);
	});

	test('KV 抛异常时仍正常回源', async () => {
		const { res, calls } = await scheduleMissCase({
			search: '?version=v1',
			kvOptions: { failGet: true },
		});

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
