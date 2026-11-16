import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { createOpenAICompatible } from "../src/llm/openai-compatible.js";

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;

const servers: Array<{ close(): void }> = [];
after(() => {
	for (const s of servers) s.close();
});

async function fakeProvider(handler: Handler) {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			const body = JSON.parse(raw) as Record<string, unknown>;
			requests.push({ ...body, path: req.url, auth: req.headers.authorization });
			handler(body, req, res);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`, requests };
}

const reply = (res: ServerResponse, content: unknown, status = 200) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content } }] } : content));
};

test("client compatible OpenAI : requête, en-têtes et réponse", async () => {
	const { url, requests } = await fakeProvider((_b, _q, res) => reply(res, "Bonjour"));
	const llm = createOpenAICompatible({
		baseUrl: url,
		apiKey: "cle",
		model: "mistral/mistral-small",
	});
	assert.equal(await llm.complete("Salut", { json: true, maxTokens: 50 }), "Bonjour");
	assert.equal(requests[0].path, "/v1/chat/completions");
	assert.equal(requests[0].auth, "Bearer cle");
	assert.equal(requests[0].model, "mistral/mistral-small");
	assert.equal(requests[0].max_tokens, 50);
	assert.deepEqual(requests[0].response_format, { type: "json_object" });
});

test("client compatible OpenAI : mode JSON refusé → désactivé et requête rejouée", async () => {
	const { url, requests } = await fakeProvider((body, _q, res) =>
		body.response_format
			? reply(res, { error: "response_format is not supported" }, 400)
			: reply(res, [{ text: "ok" }]),
	);
	const llm = createOpenAICompatible({ baseUrl: url, apiKey: "k", model: "m" });
	assert.equal(await llm.complete("x", { json: true }), "ok");
	assert.equal(await llm.complete("y", { json: true }), "ok");
	assert.equal(requests.length, 3, "un seul refus, puis plus de mode JSON");
});

test("client compatible OpenAI : retry sur 429, pas sur 401", async () => {
	let calls = 0;
	const { url } = await fakeProvider((_b, _q, res) => {
		calls++;
		if (calls === 1) reply(res, { error: "rate limit" }, 429);
		else reply(res, "enfin");
	});
	const llm = createOpenAICompatible({ baseUrl: url, apiKey: "k", model: "m" }, { baseDelayMs: 1 });
	assert.equal(await llm.complete("x"), "enfin");

	const denied = await fakeProvider((_b, _q, res) => reply(res, { error: "bad key" }, 401));
	const llm2 = createOpenAICompatible(
		{ baseUrl: denied.url, apiKey: "k", model: "m" },
		{ baseDelayMs: 1 },
	);
	await assert.rejects(llm2.complete("x"), { statusCode: 401 });
	assert.equal(denied.requests.length, 1);
});

test("configuration : fournisseur compatible OpenAI", () => {
	assert.equal(loadConfig({}).llm, undefined);
	const config = loadConfig({
		LLM_BASE_URL: "https://api.edenai.run/v3",
		LLM_API_KEY: "k",
		LLM_MODEL: "m",
	});
	assert.deepEqual(config.llm, { baseUrl: "https://api.edenai.run/v3", apiKey: "k", model: "m" });
	assert.throws(() => loadConfig({ LLM_BASE_URL: "https://x.test" }), /LLM_API_KEY/);
	assert.throws(
		() => loadConfig({ LLM_BASE_URL: "pas-une-url", LLM_API_KEY: "k", LLM_MODEL: "m" }),
		/URL/,
	);
});
