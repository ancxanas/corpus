import { generateKeyPair, signNode } from "../core/sign.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { Node } from "../core/types.ts";
import { templateFor } from "../nodetypes/registry.ts";
import { SqliteNodeStore } from "../storage/node_store.ts";
import { FileBlockstore } from "../storage/blockstore.ts";
import { rebuildIndex } from "../storage/rebuild.ts";

const BASE_URL = Deno.env.get("CORPUS_BASE_URL") ?? "http://127.0.0.1:8000";

interface Flags {
  [key: string]: string;
}

const USAGE: Record<string, string> = {
  keygen: "usage: corpus keygen [--output FILE]",
  node:
    "usage: corpus node { create | template } --type T --key KEY [--file FILE]",
  verify:
    "usage: corpus verify --problem CID --solution CID --key KEY --env-hash HASH --suite FILE [--playground NAME]",
  get: "usage: corpus get --cid CID",
  search:
    "usage: corpus search [--type T] [--status S] [--severity S] [--framework F] [--search S] [--tag T]",
  rebuild: "usage: corpus rebuild [--data-dir DIR]",
};

const HELP: Record<string, string> = {
  keygen: `Generate an Ed25519 key pair.

${USAGE.keygen}
  --output FILE  write the key pair to FILE (default: stdout)`,
  node: `Author a node.

${USAGE.node}
Subcommands:
  create    sign and post a node from --file
  template  print a node template for --type`,
  "node create": `Sign and post a node.

${USAGE.node}
  --file FILE  path to the unsigned node JSON
  --key FILE   key file with secret_key and public_key
  --type T     plural or singular type, e.g. problems or Problem`,
  "node template": `Print a node template.

${USAGE.node}
  --type T  template type: problem or recipe
  --key FILE   key file with public_key (the template is pre-signed-ready)`,
  verify: `Post a Verification receipt.

${USAGE.verify}
  --problem CID    problem node CID
  --solution CID   recipe node CID
  --key FILE       key file with secret_key and public_key
  --env-hash HASH  environment hash of the playground
  --suite FILE     test suite JSON (total, passed, failed, cases)
  --playground NAME  playground id (default: sandbox-den)`,
  get: `Fetch a node by CID.

${USAGE.get}
  --cid CID  node CID`,
  search: `Search nodes.

${USAGE.search}
  --type T        filter by node type
  --status S      filter by effective status
  --severity S    filter by severity (problems only)
  --framework F   filter by framework name
  --search S      full-text keyword search
  --tag T         filter by payload tag`,
  rebuild: `Rebuild the index from stored blocks.

${USAGE.rebuild}
  --data-dir DIR  data directory (default: CORPUS_DATA_DIR or "data")`,
};

const TOP_HELP = `The Corpus CLI.

commands:
  keygen        generate an Ed25519 key pair
  node create   sign and post a node
  node template print a node template
  verify        post a Verification receipt
  get           fetch a node by CID
  search        search nodes
  rebuild       rebuild the index from stored blocks

base url: ${BASE_URL} (set CORPUS_BASE_URL to change)

run a command with --help for details, e.g. "corpus node create --help"`;

function parseFlags(args: string[]): { command: string[]; flags: Flags } {
  const command: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "";
      }
    } else {
      command.push(arg);
    }
  }
  return { command, flags };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

function usageError(message: string): never {
  console.error(`error: ${message}`);
  console.error("run with --help for usage");
  Deno.exit(2);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch (e) {
    fail(`cannot reach the server at ${BASE_URL}: ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const errors = (body as {
      errors?: Array<
        { title?: string; detail?: string; source?: { pointer?: string } }
      >;
    })?.errors ?? [];
    const details = errors
      .map((e) => {
        const pointer = e.source?.pointer ? ` (${e.source.pointer})` : "";
        return `${e.title}${e.detail ? `: ${e.detail}` : ""}${pointer}`;
      })
      .join("; ");
    fail(
      `request to ${path} failed (${res.status}): ${details || res.statusText}`,
    );
  }
  return body;
}

function loadJson(file: string): unknown {
  try {
    return JSON.parse(Deno.readTextFileSync(file));
  } catch (e) {
    fail(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function loadSecretKey(file: string): string {
  const keys = loadJson(file) as { secret_key?: string };
  if (!keys.secret_key) {
    fail(`no secret_key in ${file}`);
  }
  return keys.secret_key;
}

function cmdKeygen(flags: Flags): void {
  const pair = generateKeyPair();
  const out = { public_key: pair.publicKeyHex, secret_key: pair.secretKeyHex };
  if (flags.output) {
    Deno.writeTextFileSync(flags.output, JSON.stringify(out, null, 2));
    console.log(`keys written to ${flags.output}`);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
}

async function cmdNodeCreate(flags: Flags): Promise<void> {
  const file = flags.file;
  const keyFile = flags.key;
  const type = flags.type;
  if (!file || !keyFile || !type) {
    usageError("node create requires --file, --type, --key");
  }
  const node = loadJson(file) as never;
  const secret = loadSecretKey(keyFile);
  const signed = signNode(node, secret);
  const body = await api("/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({ data: { type, attributes: signed } }),
  });
  console.log(`stored ${(body as { meta: { cid: string } }).meta.cid}`);
}

function cmdNodeTemplate(flags: Flags): void {
  const type = flags.type;
  const keyFile = flags.key;
  if (!type || !keyFile) {
    usageError("node template requires --type and --key");
  }
  const keys = loadJson(keyFile) as { public_key?: string };
  if (!keys.public_key) {
    fail(`no public_key in ${keyFile}`);
  }
  const module = templateFor(type);
  if (!module?.template) {
    fail(`no template for type '${type}'`);
  }
  console.log(JSON.stringify(module.template(keys.public_key), null, 2));
}

async function cmdVerify(flags: Flags): Promise<void> {
  const problemCid = flags.problem;
  const solutionCid = flags.solution;
  const keyFile = flags.key;
  const envHash = flags["env-hash"];
  const suiteFile = flags.suite;
  const playground = flags.playground ?? "sandbox-den";
  if (!problemCid || !solutionCid || !keyFile || !envHash || !suiteFile) {
    usageError(
      "verify requires --problem, --solution, --key, --env-hash, --suite",
    );
  }
  const suite = loadJson(suiteFile) as {
    total: number;
    passed: number;
    failed: number;
    cases: Array<
      { name: string; expected: string; actual: string; result: string }
    >;
  };
  const keys = loadJson(keyFile) as {
    secret_key?: string;
    public_key?: string;
  };
  if (!keys.secret_key || !keys.public_key) {
    fail(`key file ${keyFile} must have secret_key and public_key`);
  }
  const secret = keys.secret_key;
  const publicKey = keys.public_key;
  const node: Node = {
    osk: {
      version: "0.3.0",
      node_type: "Verification",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: new Date().toISOString(),
      },
      attribution: { author_type: "agent", public_key: publicKey },
    },
    payload: {
      verification: {
        target: {
          problem_id: { "/": problemCid },
          solution_id: { "/": solutionCid },
        },
        execution: {
          playground,
          environment_hash: envHash,
          test_suite: suite,
        },
        timestamp: new Date().toISOString(),
      },
    },
  };
  const signed = signNode(node, secret);
  const body = await api("/verifications", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: { type: "verifications", attributes: signed },
    }),
  });
  console.log(`stored ${(body as { meta: { cid: string } }).meta.cid}`);
}

async function cmdGet(flags: Flags): Promise<void> {
  const cid = flags.cid;
  if (!cid) {
    usageError("get requires --cid");
  }
  const body = await api(`/nodes/${cid}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdSearch(flags: Flags): Promise<void> {
  const params = new URLSearchParams();
  if (typeof flags.search === "string") {
    params.set("search", flags.search);
  }
  for (const key of ["type", "status", "severity", "framework", "tag"]) {
    const value = flags[key];
    if (typeof value === "string") {
      if (key === "type") {
        params.set("filter[node_type]", value);
      } else if (key === "status") {
        params.set("filter[effective_status]", value);
      } else {
        params.set(`filter[${key}]`, value);
      }
    }
  }
  const body = await api(`/nodes?${params.toString()}`) as {
    data: Array<
      {
        id: string;
        type: string;
        meta: { effective_status: string; confidence_score: number };
        attributes?: { payload?: Record<string, { title?: string }> };
      }
    >;
    meta: { total: number };
  };
  console.log(`total: ${body.meta.total}`);
  for (const item of body.data) {
    const payload = item.attributes?.payload ?? {};
    const title = Object.values(payload)[0]?.title ?? "";
    console.log(
      `${item.type}  ${item.id}  ${title}  ${item.meta.effective_status}  conf=${item.meta.confidence_score}`,
    );
  }
}

async function cmdRebuild(flags: Flags): Promise<void> {
  const root = flags["data-dir"] ?? Deno.env.get("CORPUS_DATA_DIR") ?? "data";
  const index = new SqliteNodeStore(`${root}/corpus.db`);
  await index.init();
  const blockstore = new FileBlockstore({ dir: `${root}/blocks` });
  const count = await rebuildIndex(blockstore, index);
  console.log(`index rebuilt from ${count} blocks`);
  await index.close();
}

function printHelp(name: string): void {
  console.log(HELP[name] ?? TOP_HELP);
  Deno.exit(0);
}

const allArgs = Deno.args[0] === "--" ? Deno.args.slice(1) : Deno.args;
const sub = allArgs[0];
const rest = allArgs.slice(1);
const { command, flags } = parseFlags(rest);

if (
  sub === undefined || sub === "--help" || sub === "-h" || sub === "help"
) {
  console.log(TOP_HELP);
  Deno.exit(sub === undefined ? 2 : 0);
}

const wantsHelp = flags.help !== undefined || command.includes("-h");

switch (sub) {
  case "keygen":
    if (wantsHelp) {
      printHelp("keygen");
    }
    cmdKeygen(flags);
    break;
  case "node":
    if (wantsHelp) {
      printHelp("node");
    }
    if (command[0] === "create") {
      if (flags.help !== undefined || command.slice(1).includes("-h")) {
        printHelp("node create");
      }
      await cmdNodeCreate(flags);
    } else if (command[0] === "template") {
      if (flags.help !== undefined || command.slice(1).includes("-h")) {
        printHelp("node template");
      }
      cmdNodeTemplate(flags);
    } else {
      usageError("node requires a subcommand: create or template");
    }
    break;
  case "verify":
    if (wantsHelp) {
      printHelp("verify");
    }
    await cmdVerify(flags);
    break;
  case "get":
    if (wantsHelp) {
      printHelp("get");
    }
    await cmdGet(flags);
    break;
  case "search":
    if (wantsHelp) {
      printHelp("search");
    }
    await cmdSearch(flags);
    break;
  case "rebuild":
    if (wantsHelp) {
      printHelp("rebuild");
    }
    await cmdRebuild(flags);
    break;
  default:
    usageError(`unknown command '${sub}'`);
}
