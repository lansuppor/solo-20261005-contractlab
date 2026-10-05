# contractlab

本地 API 联调与契约工具：按 JSON 配置在本机提供可热更新的接口场景服务，让客户端在同一接口上连续获得预设响应，修改场景时服务不中断。

需要 Node.js 24，无外部运行依赖。

## 启动

```sh
node app.ts                    # 显示应用名与帮助
node app.ts --help             # 同上（-h 亦可）
node app.ts serve --config examples/scenario.json --port 8080
node app.ts serve --config examples/scenario.json --port 0   # 随机端口
```

- 仅监听 `127.0.0.1`；启动成功后打印实际地址，如 `contractlab: listening at http://127.0.0.1:51234`。
- 配置无效或端口被占用时启动失败，打印可定位原因（含 JSON 路径）并以状态码 1 退出，不留下监听。
- 不支持的命令行参数报错并以状态码 2 退出。
- `SIGINT` / `SIGTERM` 关闭监听、取消尚未发出的延迟响应并正常退出（状态码 0）。

## 配置格式

JSON 文件，顶层只有一个字段 `endpoints`（数组）。每个接口由 `method` + `path` 唯一标识：

```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/hello",
      "responses": [
        { "status": 200, "headers": { "content-type": "text/plain" }, "body": "first\n", "delayMs": 0 },
        { "status": 500, "body": "second\n", "delayMs": 100 }
      ]
    }
  ]
}
```

- `method`：`"GET"` 或 `"POST"`；`path`：以 `/` 开头的绝对路径，不含查询串。匹配按方法 + 路径精确进行，查询串不参与、各接口独立计数，不支持路径模板。
- `responses`：非空数组，按顺序消费。每项字段：
  - `status`（必填）：200–599 的整数；状态码 204、304 的正文必须为空。
  - `body`（必填）：字符串文本正文。
  - `headers`（可选，默认 `{}`）：字符串响应头；名与值不得含换行，不得设置服务器管理的 `content-length`、`transfer-encoding`、`connection`，同名头（忽略大小写）不得重复。
  - `delayMs`（可选，默认 0）：0–60000 毫秒的发送前延迟。
- 保留前缀 `/__contractlab/` 为管理入口，业务接口不得使用；重复接口、未知字段、非法取值都会在加载或重载时被拒绝。

## 请求与响应序列

```sh
curl -i http://127.0.0.1:8080/hello
```

- 请求完整接收后按当时配置匹配接口并立即预留下一项响应；同一接口按完整接收先后依次取项，不跳项，耗尽后持续复用末项。
- 预留后即使客户端断开也算已消费；响应在 `delayMs` 结束后才发出。
- 未完整接收就断开的请求不推进序列；未匹配的请求返回 404。
- 每个业务响应（含 404）携带响应头 `x-contractlab-config-version`，标识产生它的配置版本。

## 热重载与健康查询

```sh
curl -X POST http://127.0.0.1:8080/__contractlab/reload
curl http://127.0.0.1:8080/__contractlab/health
```

- 重载入本会重新读取启动时指定的同一文件。新配置全部有效才一次性替换所有接口、重置全部序列并将版本加 1，返回 `{"ok": true, "version": N}`。
- 读文件、解析或校验任一失败都返回 `422 {"ok": false, "version": N, "error": "..."}`，当前配置、版本与各接口序列位置保持不变，旧场景继续可用。
- 重载成功后进入的请求使用新版本；重载前已预留响应的请求仍按旧版本的状态码、响应头、正文与延迟完成，且不占用新序列位置。并发重载按请求完整接收的顺序逐个处理。
- 健康查询返回 `{"status": "ok", "version": N}`；管理操作不消费任何业务序列。

## 可观察的小实验

```sh
node app.ts serve --config examples/scenario.json --port 8080 &
curl -i http://127.0.0.1:8080/hello        # first，版本 1
curl -i http://127.0.0.1:8080/hello        # second（延迟 100ms）
curl -i http://127.0.0.1:8080/hello        # 500 third
curl -i http://127.0.0.1:8080/hello        # 仍是 third：耗尽后复用末项
curl -i 'http://127.0.0.1:8080/hello?x=1'  # 查询串不另开序列，仍取下一项

# 修改 examples/scenario.json 后：
curl -X POST http://127.0.0.1:8080/__contractlab/reload   # {"ok":true,"version":2}
curl -i http://127.0.0.1:8080/hello        # 从新序列第一项重新开始，版本头变为 2

# 把配置改坏（例如 status 改成 99）再重载：
curl -X POST http://127.0.0.1:8080/__contractlab/reload   # 422，error 指出 $.endpoints[...] 位置
curl -i http://127.0.0.1:8080/hello        # 旧场景照常响应，版本与序列位置未变
```
