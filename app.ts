import { serve } from './server.ts';

const name: string = 'contractlab';

const help: string = `${name}

Usage:
  node app.ts [--help]
  node app.ts serve --config <file> --port <port>

本地 API 联调与契约工具。
serve 按 JSON 配置在 127.0.0.1 上提供可热更新的接口场景服务（--port 0 表示随机端口）。
详见 README.md。`;

function parseServeArgs(rest: string[]): { configPath: string; port: number } | string {
  let configPath: string | undefined;
  let portText: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag !== '--config' && flag !== '--port') {
      return `unknown argument ${arg}`;
    }
    if (value === undefined) {
      i += 1;
      if (i >= rest.length) return `${flag} requires a value`;
      value = rest[i];
    }
    if (flag === '--config') {
      if (configPath !== undefined) return 'duplicate --config';
      configPath = value;
    } else {
      if (portText !== undefined) return 'duplicate --port';
      portText = value;
    }
  }
  if (configPath === undefined || configPath === '') return 'serve requires --config <file>';
  if (portText === undefined) return 'serve requires --port <port>';
  if (!/^\d+$/.test(portText)) return `--port must be an integer between 0 and 65535, got ${JSON.stringify(portText)}`;
  const port = Number(portText);
  if (port > 65535) return `--port must be between 0 and 65535, got ${port}`;
  return { configPath, port };
}

const args: string[] = process.argv.slice(2);

if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
  console.log(help);
} else if (args[0] === 'serve') {
  const rest = args.slice(1);
  if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
    console.log(help);
  } else {
    const parsed = parseServeArgs(rest);
    if (typeof parsed === 'string') {
      console.error(`${name}: ${parsed}; use --help`);
      process.exitCode = 2;
    } else {
      try {
        await serve(parsed.configPath, parsed.port);
      } catch (err) {
        console.error(`${name}: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
  }
} else {
  console.error(`${name}: unknown arguments; use --help`);
  process.exitCode = 2;
}
