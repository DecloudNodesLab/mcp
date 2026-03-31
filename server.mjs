import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "/workspace");
const MAX_READ_BYTES = Number(process.env.MAX_READ_BYTES || 200000);
const MAX_LIST_ENTRIES = Number(process.env.MAX_LIST_ENTRIES || 200);

const OIDC_ISSUER = process.env.OIDC_ISSUER || "";
const OIDC_JWKS_URI = process.env.OIDC_JWKS_URI || "";
const OIDC_EXPECTED_AUDIENCE = process.env.OIDC_EXPECTED_AUDIENCE || "";

const ALLOWED_PROGRAMS = new Set(
  (process.env.ALLOWED_PROGRAMS ||
    "pwd,ls,cat,grep,find,sed,head,tail,wc,git,node,npm,npx,python3,pytest,go,make")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);

const jwks = OIDC_JWKS_URI ? createRemoteJWKSet(new URL(OIDC_JWKS_URI)) : null;

function safeResolve(relativePath = ".") {
  const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`Путь вне /workspace запрещён: ${relativePath}`);
  }
  return resolved;
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function jsonText(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function createServer() {
  const server = new McpServer(
    {
      name: "workspace-mcp",
      version: "1.0.0"
    },
    {
      capabilities: {
        logging: {}
      },
      instructions:
        "Этот MCP-сервер работает только внутри /workspace. " +
        "Файлы читать и писать только там. Команды выполнять только через run_cmd."
    }
  );

  server.tool(
    "pwd_ls",
    "Показать текущую папку и список файлов внутри /workspace",
    {
      path: z.string().optional().describe("Относительный путь внутри /workspace")
    },
    async ({ path: relativePath }) => {
      try {
        const target = safeResolve(relativePath || ".");
        const stat = await fs.stat(target);

        if (!stat.isDirectory()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Указанный путь не является директорией." }]
          };
        }

        const entries = await fs.readdir(target, { withFileTypes: true });
        const items = entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"
        }));

        return {
          content: jsonText({
            workspaceRoot: WORKSPACE_ROOT,
            currentPath: target,
            items,
            truncated: entries.length > MAX_LIST_ENTRIES
          })
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка pwd_ls: ${error.message}` }]
        };
      }
    }
  );

  server.tool(
    "read_file",
    "Прочитать текстовый файл внутри /workspace",
    {
      path: z.string().describe("Относительный путь к файлу внутри /workspace")
    },
    async ({ path: relativePath }) => {
      try {
        const filePath = safeResolve(relativePath);
        const stat = await fs.stat(filePath);

        if (!stat.isFile()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Указанный путь не является файлом." }]
          };
        }

        if (stat.size > MAX_READ_BYTES) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Файл слишком большой: ${stat.size} байт. Увеличь MAX_READ_BYTES.`
              }
            ]
          };
        }

        const content = await fs.readFile(filePath, "utf8");

        return {
          content: [{ type: "text", text: content }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка read_file: ${error.message}` }]
        };
      }
    }
  );

  server.tool(
    "write_file",
    "Создать или перезаписать текстовый файл внутри /workspace",
    {
      path: z.string().describe("Относительный путь к файлу внутри /workspace"),
      content: z.string().describe("Новое содержимое файла"),
      overwrite: z.boolean().default(true).describe("Разрешить перезапись существующего файла")
    },
    async ({ path: relativePath, content, overwrite }) => {
      try {
        const filePath = safeResolve(relativePath);
        const exists = await fileExists(filePath);

        if (exists && !overwrite) {
          return {
            isError: true,
            content: [{ type: "text", text: "Файл уже существует, overwrite=false." }]
          };
        }

        await ensureDirectory(path.dirname(filePath));
        await fs.writeFile(filePath, content, "utf8");

        return {
          content: jsonText({
            ok: true,
            path: filePath,
            bytesWritten: Buffer.byteLength(content, "utf8")
          })
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка write_file: ${error.message}` }]
        };
      }
    }
  );

  server.tool(
    "run_cmd",
    "Запустить разрешённую команду без shell внутри /workspace",
    {
      program: z.string().describe("Имя программы, например git или npm"),
      args: z.array(z.string()).default([]).describe("Аргументы программы"),
      cwd: z.string().optional().describe("Относительный рабочий каталог внутри /workspace"),
      timeoutSec: z.number().int().min(1).max(120).default(30).describe("Таймаут в секундах")
    },
    async ({ program, args, cwd, timeoutSec }) => {
      try {
        if (!ALLOWED_PROGRAMS.has(program)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Программа "${program}" не разрешена. Разрешены: ${[
                  ...ALLOWED_PROGRAMS
                ].join(", ")}`
              }
            ]
          };
        }

        const targetCwd = safeResolve(cwd || ".");
        const stat = await fs.stat(targetCwd);
        if (!stat.isDirectory()) {
          return {
            isError: true,
            content: [{ type: "text", text: "cwd не является директорией." }]
          };
        }

        const { stdout, stderr } = await execFileAsync(program, args, {
          cwd: targetCwd,
          timeout: timeoutSec * 1000,
          maxBuffer: 2 * 1024 * 1024,
          shell: false
        });

        return {
          content: jsonText({
            ok: true,
            cwd: targetCwd,
            program,
            args,
            stdout: stdout || "",
            stderr: stderr || ""
          })
        };
      } catch (error) {
        return {
          isError: true,
          content: jsonText({
            ok: false,
            program,
            args,
            code: error.code ?? null,
            signal: error.signal ?? null,
            stdout: error.stdout || "",
            stderr: error.stderr || "",
            message: error.message
          })
        };
      }
    }
  );

  return server;
}

async function requireBearerAuth(req, res, next) {
  try {
    if (!OIDC_ISSUER || !OIDC_JWKS_URI || !jwks) {
      return res.status(500).json({ error: "OIDC не настроен" });
    }

    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Нет Bearer токена" });
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: OIDC_ISSUER
    });

    if (OIDC_EXPECTED_AUDIENCE) {
      const aud = payload.aud;
      const azp = payload.azp;

      const audOk = Array.isArray(aud)
        ? aud.includes(OIDC_EXPECTED_AUDIENCE)
        : aud === OIDC_EXPECTED_AUDIENCE;

      const azpOk = azp === OIDC_EXPECTED_AUDIENCE;

      if (!audOk && !azpOk) {
        return res.status(403).json({
          error: "Токен не предназначен для этого клиента",
          expectedAudience: OIDC_EXPECTED_AUDIENCE
        });
      }
    }

    req.authUser = {
      sub: payload.sub,
      preferred_username: payload.preferred_username,
      email: payload.email
    };

    next();
  } catch (error) {
    return res.status(401).json({
      error: "Невалидный токен",
      message: error.message
    });
  }
}

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"]
  })
);

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    name: "workspace-mcp",
    workspaceRoot: WORKSPACE_ROOT,
    oidcIssuer: OIDC_ISSUER,
    audienceCheckEnabled: Boolean(OIDC_EXPECTED_AUDIENCE),
    allowedPrograms: [...ALLOWED_PROGRAMS]
  });
});

app.post("/mcp", requireBearerAuth, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/mcp", (req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.delete("/mcp", (req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`workspace-mcp listening on 0.0.0.0:${PORT}`);
  console.log(`workspace root: ${WORKSPACE_ROOT}`);
  console.log(`allowed programs: ${[...ALLOWED_PROGRAMS].join(", ")}`);
});
