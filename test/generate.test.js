import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/**
 * These run the real OpenRouter adapter against a mock of OpenRouter, by
 * pointing OPENROUTER_BASE_URL at a local server. That covers the request we
 * actually send and every failure branch, without a key or a network call.
 */

/** Starts a mock OpenRouter. `handler` returns [status, body]. */
async function mockOpenRouter(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(raw || "{}"),
      });
      const [status, body] = handler(requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function reply(category) {
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(category) } }] };
}

const goodCategory = {
  title: "Pokemon",
  clues: [
    { clue: "This Kanto starter evolves into Charizard.", answer: "Charmander" },
    { clue: "This yellow mouse is the mascot.", answer: "Pikachu" },
    { clue: "This legendary ice bird lives on the Seafoam Islands.", answer: "Articuno" },
    { clue: "This one was cloned from Mew.", answer: "Mewtwo" },
    { clue: "Eevee has this many evolutions in Gen II.", answer: "Five" },
  ],
};

/** Runs `fn` with the given env, restoring it afterwards. */
async function withEnv(env, fn) {
  const saved = {};
  const keys = [
    "AI_PROVIDER",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_PROFILE",
  ];
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------- selection

test("no credentials means no provider", async () => {
  const { activeProvider, hasCredentials } = await import("../lib/generate.js");
  await withEnv({}, () => {
    assert.equal(activeProvider(), null);
    assert.equal(hasCredentials(), false);
  });
});

test("an OpenRouter key alone selects OpenRouter", async () => {
  const { activeProvider, providerLabel } = await import("../lib/generate.js");
  await withEnv({ OPENROUTER_API_KEY: "sk-or-test" }, () => {
    assert.equal(activeProvider().id, "openrouter");
    assert.match(providerLabel(), /^OpenRouter \(/);
  });
});

test("an Anthropic key alone selects Anthropic", async () => {
  const { activeProvider } = await import("../lib/generate.js");
  await withEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }, () => {
    assert.equal(activeProvider().id, "anthropic");
  });
});

test("Anthropic wins when both keys are set", async () => {
  const { activeProvider } = await import("../lib/generate.js");
  await withEnv({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "b" }, () => {
    assert.equal(activeProvider().id, "anthropic");
  });
});

test("AI_PROVIDER overrides the tie", async () => {
  const { activeProvider } = await import("../lib/generate.js");
  await withEnv(
    { AI_PROVIDER: "openrouter", ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "b" },
    () => {
      assert.equal(activeProvider().id, "openrouter");
    },
  );
});

test("an unknown AI_PROVIDER is reported, not ignored", async () => {
  const { activeProvider, GenerationError } = await import("../lib/generate.js");
  await withEnv({ AI_PROVIDER: "hotdog" }, () => {
    assert.throws(() => activeProvider(), GenerationError);
  });
});

test("the default OpenRouter model is used when none is set", async () => {
  const { providerLabel } = await import("../lib/generate.js");
  await withEnv({ OPENROUTER_API_KEY: "k" }, () => {
    assert.match(providerLabel(), /google\/gemini/);
  });
  await withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "meta-llama/llama-4-scout" }, () => {
    assert.match(providerLabel(), /llama-4-scout/);
  });
});

// ---------------------------------------------------------------- the request

test("the request asks for a strict JSON schema and a capable endpoint", async () => {
  const { generateCategory } = await import("../lib/generate.js");
  const mock = await mockOpenRouter(() => [200, reply(goodCategory)]);

  await withEnv(
    { OPENROUTER_API_KEY: "sk-or-test", OPENROUTER_BASE_URL: mock.baseUrl },
    () => generateCategory("Pokemon"),
  );

  const sent = mock.requests[0];
  assert.equal(sent.url, "/api/v1/chat/completions");
  assert.equal(sent.auth, "Bearer sk-or-test");
  assert.equal(sent.body.response_format.type, "json_schema");
  assert.equal(sent.body.response_format.json_schema.strict, true);
  assert.equal(
    sent.body.provider.require_parameters,
    true,
    "without this, OpenRouter may route to an endpoint that ignores the schema",
  );
  // The schema must forbid extra keys, or strict mode is meaningless.
  assert.equal(sent.body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(sent.body.messages[0].role, "system");
  await mock.close();
});

test("answers already on the board are sent so they are not reused", async () => {
  const { generateCategory } = await import("../lib/generate.js");
  const mock = await mockOpenRouter(() => [200, reply(goodCategory)]);

  await withEnv(
    { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl },
    () => generateCategory("Pokemon", ["Paris", "Tokyo"]),
  );

  const userMessage = mock.requests[0].body.messages[1].content;
  assert.match(userMessage, /Paris/);
  assert.match(userMessage, /Tokyo/);
  await mock.close();
});

// ---------------------------------------------------------------- the response

test("a good reply becomes a category with dollar values by position", async () => {
  const { generateCategory } = await import("../lib/generate.js");
  const mock = await mockOpenRouter(() => [200, reply(goodCategory)]);

  const category = await withEnv(
    { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl },
    () => generateCategory("Pokemon"),
  );

  assert.equal(category.title, "Pokemon");
  assert.deepEqual(
    category.clues.map((c) => c.value),
    [100, 200, 300, 400, 500],
  );
  assert.equal(category.clues[0].answer, "Charmander");
  assert.equal(category.clues[0].revealed, false);
  assert.equal(category.clues[0].wager, null);
  await mock.close();
});

test("a reply wrapped in a markdown fence is still accepted", async () => {
  const { generateCategory } = await import("../lib/generate.js");
  const fenced = {
    choices: [
      {
        finish_reason: "stop",
        message: { content: "```json\n" + JSON.stringify(goodCategory) + "\n```" },
      },
    ],
  };
  const mock = await mockOpenRouter(() => [200, fenced]);

  const category = await withEnv(
    { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl },
    () => generateCategory("Pokemon"),
  );
  assert.equal(category.title, "Pokemon");
  await mock.close();
});

test("a malformed reply is retried once, then reported clearly", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  const tooFew = { title: "Short", clues: goodCategory.clues.slice(0, 3) };
  const mock = await mockOpenRouter(() => [200, reply(tooFew)]);

  await assert.rejects(
    withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
      generateCategory("Pokemon"),
    ),
    (err) => {
      assert.ok(err instanceof GenerationError);
      assert.match(err.message, /3 clues instead of 5/);
      return true;
    },
  );
  assert.equal(mock.requests.length, 2, "a bad reply should be retried exactly once");
  await mock.close();
});

test("a reply that is good on the second try is accepted", async () => {
  const { generateCategory } = await import("../lib/generate.js");
  const bad = { title: "Short", clues: goodCategory.clues.slice(0, 2) };
  const mock = await mockOpenRouter((n) => [200, reply(n === 1 ? bad : goodCategory)]);

  const category = await withEnv(
    { OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl },
    () => generateCategory("Pokemon"),
  );
  assert.equal(category.title, "Pokemon");
  assert.equal(mock.requests.length, 2);
  await mock.close();
});

test("non-JSON content is reported as such", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  const prose = { choices: [{ finish_reason: "stop", message: { content: "Sure! Here you go." } }] };
  const mock = await mockOpenRouter(() => [200, prose]);

  await assert.rejects(
    withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
      generateCategory("Pokemon"),
    ),
    (err) => {
      assert.ok(err instanceof GenerationError);
      assert.match(err.message, /did not return valid JSON/);
      return true;
    },
  );
  await mock.close();
});

test("a truncated reply is reported rather than half-used", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  const cut = { choices: [{ finish_reason: "length", message: { content: "{" } }] };
  const mock = await mockOpenRouter(() => [200, cut]);

  await assert.rejects(
    withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
      generateCategory("Pokemon"),
    ),
    (err) => {
      assert.match(err.message, /cut off/);
      return true;
    },
  );
  await mock.close();
});

test("an error carried inside a 200 body is still an error", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  const mock = await mockOpenRouter(() => [200, { error: { message: "upstream exploded" } }]);

  await assert.rejects(
    withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
      generateCategory("Pokemon"),
    ),
    (err) => {
      assert.ok(err instanceof GenerationError);
      assert.match(err.message, /upstream exploded/);
      return true;
    },
  );
  await mock.close();
});

// ---------------------------------------------------------------- HTTP failures

const httpCases = [
  [401, /rejected the API key/i],
  [402, /out of credit/i],
  [404, /does not know the model/i],
  [429, /Rate limited/i],
  [500, /returned 500/i],
];

for (const [status, expected] of httpCases) {
  test(`HTTP ${status} is turned into something the host can act on`, async () => {
    const { generateCategory, GenerationError } = await import("../lib/generate.js");
    const mock = await mockOpenRouter(() => [status, { error: { message: "nope" } }]);

    await assert.rejects(
      withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
        generateCategory("Pokemon"),
      ),
      (err) => {
        assert.ok(err instanceof GenerationError, "should be a GenerationError");
        assert.match(err.message, expected);
        return true;
      },
    );
    await mock.close();
  });
}

// ---------------------------------------------------------------- guards

test("a blank theme never reaches the network", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  const mock = await mockOpenRouter(() => [200, reply(goodCategory)]);

  await assert.rejects(
    withEnv({ OPENROUTER_API_KEY: "k", OPENROUTER_BASE_URL: mock.baseUrl }, () =>
      generateCategory("   "),
    ),
    GenerationError,
  );
  assert.equal(mock.requests.length, 0);
  await mock.close();
});

test("with no provider configured the error says what to set", async () => {
  const { generateCategory, GenerationError } = await import("../lib/generate.js");
  await assert.rejects(
    withEnv({}, () => generateCategory("Pokemon")),
    (err) => {
      assert.ok(err instanceof GenerationError);
      assert.match(err.message, /ANTHROPIC_API_KEY or OPENROUTER_API_KEY/);
      return true;
    },
  );
});
