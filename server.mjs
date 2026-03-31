import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import * as z from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3000);
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || "/workspace");
const MAX_READ_BYTES = Number(process.env.MAX_READ_BYTES || 200_000);
const MAX_LIST_ENTRIES = Number(process.env.MAX_LIST_ENTRIES || 200);

const ALLOWED_PROGRAMS = new Set(
  (process.env.ALLOWED_PROGRAMS ||
    "pwd,ls,cat,grep,find,sed,head,tail,wc,git,node,npm,npx,python3,pytest,go,make")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function safeResolve(userPath = ".") {
  const resolved = path.resolve(WORKSPACE_ROOT, userPath);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`Путь вне рабочей директории запрещён: ${userPath}`);
  }
  return resolved;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function makeServer() {
  const server = new McpServer(
    {
      name: "workspace-mcp",
      version: "1.0.0"
    },
    {
      instructions:
        'Инструменты этого сервера работают только внутри /workspace. ' +
        'Перед записью в файл сначала читай его, если это поможет избежать перезаписи. ' +
        'Для запуска команд используй run_cmd. Команды выполняются без shell и только из allowlist.'
    }
  );

  server.registerTool(
    "pwd_ls",
    {
      title: "Показать папку",
      description: "Показывает абсолютный путь и содержимое папки внутри /workspace",
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        path: z.string().optional().describe("Относительный путь внутри /workspace, по умолчанию .")
      }
    },
    async ({ path: relPath }) => {
      try {
        const target = safeResolve(relPath || ".");
        const stat = await fs.stat(target);

        if (!stat.isDirectory()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Указанный путь не является директорией." }]
          };
        }

        const entries = await fs.readdir(target, { withFileTypes: true });
        const items = entries
          .slice(0, MAX_LIST_ENTRIES)
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "dir" : e.isFile() ? "file" : "other"
          }));

        const result = {
          workspaceRoot: WORKSPACE_ROOT,
          currentPath: target,
          items,
          truncated: entries.length > MAX_LIST_ENTRIES
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка pwd_ls: ${err.message}` }]
        };
      }
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Прочитать файл",
      description: "Читает текстовый файл внутри /workspace",
      annotations: {
        readOnlyHint: true
      },
      inputSchema: {
        path: z.string().describe("Относительный путь к файлу внутри /workspace")
      }
    },
    async ({ path: relPath }) => {
      try {
        const filePath = safeResolve(relPath);
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
                text: `Файл слишком большой (${stat.size} байт). Увеличь MAX_READ_BYTES или читай меньшие файлы.`
              }
            ]
          };
        }

        const content = await fs.readFile(filePath, "utf8");
        const result = {
          path: filePath,
          size: stat.size,
          content
        };

        return {
          content: [{ type: "text", text: content }],
          structuredContent: result
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка read_file: ${err.message}` }]
        };
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Записать файл",
      description: "Создаёт или перезаписывает текстовый файл внутри /workspace",
      inputSchema: {
        path: z.string().describe("Относительный путь к файлу внутри /workspace"),
        content: z.string().describe("Содержимое файла"),
        overwrite: z.boolean().default(true).describe("Разрешить перезапись существующего файла")
      }
    },
    async ({ path: relPath, content, overwrite }) => {
      try {
        const filePath = safeResolve(relPath);
        const exists = await pathExists(filePath);

        if (exists && !overwrite) {
          return {
            isError: true,
            content: [{ type: "text", text: "Файл уже существует, а overwrite=false." }]
          };
        }

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");

        const result = {
          ok: true,
          path: filePath,
          bytesWritten: Buffer.byteLength(content, "utf8")
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Ошибка write_file: ${err.message}` }]
        };
      }
    }
  );

  server.registerTool(
    "run_cmd",
    {
      title: "Запустить команду",
      description:
        "Запускает разрешённую программу внутри /workspace без shell. " +
        "Команда должна быть в allowlist.",
      inputSchema: {
        program: z.string().describe("Имя программы, например git или npm"),
        args: z.array(z.string()).default([]).describe("Аргументы программы"),
        timeoutSec: z.number().int().min(1).max(120).default(30).describe("Таймаут в секундах")
      }
    },
    async ({ program, args, timeoutSec }) => {
      try {
        if (!ALLOWED_PROGRAMS.has(program)) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `Программа "${program}" не разрешена. ` +
                  `Разрешены: ${Array.from(ALLOWED_PROGRAMS).join(", ")}`
              }
            ]
          };
        }

        const { stdout, stderr } = await execFileAsync(program, args, {
          cwd: WORKSPACE_ROOT,
          timeout: timeoutSec * 1000,
          maxBuffer: 1024 * 1024
        });

        const result = {
          ok: true,
          cwd: WORKSPACE_ROOT,
          program,
          args,
          stdout: stdout || "",
          stderr: stderr || ""
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      } catch (err) {
        const result = {
          ok: false,
          cwd: WORKSPACE_ROOT,
          program,
          args,
          code: err.code ?? null,
          signal: err.signal ?? null,
          stdout: err.stdout || "",
          stderr: err.stderr || "",
          message: err.message
        };

        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result
        };
      }
    }
  );

  return server;
}

const app = createMcpExpressApp({ host: "0.0.0.0" });

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    name: "workspace-mcp",
    workspaceRoot: WORKSPACE_ROOT,
    allowedPrograms: Array.from(ALLOWED_PROGRAMS)
  });
});

app.post("/mcp", async (req, res) => {
  const server = makeServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", async () => {
      try {
        await transport.close();
      } catch {}
      try {
        await server.close();
      } catch {}
    });
  } catch (err) {
    console.error("MCP error:", err);

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

app.get("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.delete("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").send("Method Not Allowed");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on 0.0.0.0:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log(`Allowed programs: ${Array.from(ALLOWED_PROGRAMS).join(", ")}`);
});
