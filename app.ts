const name: string = 'contractlab';
const args: string[] = process.argv.slice(2);

if (args.length > 0 && !(args.length === 1 && ['--help', '-h'].includes(args[0]))) {
  console.error(name + ': unknown arguments; use --help');
  process.exitCode = 2;
} else {
  console.log(name + '\n\nUsage: node app.ts [--help]\n\n本地 API 联调与契约工具。当前仅提供帮助信息。');
}
