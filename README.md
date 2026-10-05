# contractlab

本地 API 联调与契约工具。当前提供一个**可热更新的本地接口场景服务**：在本机启动 HTTP 服务，让客户端在同一接口上连续获得预设响应；修改场景文件后通过管理入口重新加载，重载期间服务不中断。

- 运行环境：Node.js 24（可直接运行 TypeScript，无需构建、无外部运行依赖）
- 仅监听 `127.0.0.1`

## 用法

```sh
# 应用名与帮助（无参数、--help、-h 等价）
node app.ts
node app.ts --help
node app.ts -h

# 启动场景服务
node app.ts serve --config ./scenes.json --port 8080
node app.ts serve -c ./scenes.json -p 0     # 端口 0：由操作系统分配，启动日志输出实际地址
```

不支持的命令行参数会报错并以状态码 **2** 退出。

## 场景配置格式

配置为一个 UTF-8 JSON 文件，顶层只有 `endpoints`（非空数组）。每个接口由 **方法（GET/POST）+ 绝对路径**唯一标识；查询串不参与匹配，不支持路径模板（路径必须是字面值）。路径前缀 `/__contractlab/` 为管理入口保留，业务接口不得使用（`/__contractlab` 本身同样保留）。

```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/order",
      "responses": [
        {
          "status": 200,
          "headers": { "Content-Type": "application/json; charset=utf-8" },
          "body": "{\"id\":1,\"state\":\"created\"}",
          "delay": 50
        },
        {
          "status": 200,
          "headers": {},
          "body": "{\"id\":1,\"state\":\"paid\"}",
          "delay": 0
        },
        {
          "status": 500,
          "headers": {},
          "body": "{\"error\":\"boom\"}",
          "delay": 0
        }
      ]
    },
    {
      "method": "POST",
      "path": "/api/echo",
      "responses": [
        { "status": 201, "headers": {}, "body": "accepted", "delay": 0 }
      ]
    }
  ]
}
```

每个接口字段：

| 字段 | 说明 |
| --- | --- |
| `method` | `"GET"` 或 `"POST"` |
| `path` | 以 `/` 开头的绝对路径（字面值）；不含 `?`、`#`、`{`、`}`、空白与控制字符 |
| `responses` | **非空**响应序列数组 |
| `requestBody` | **可选**，仅 `POST` 接口：请求正文结构规则（见下节）；不配置则保持原有正文处理方式（任意正文均可） |

序列每项字段：

| 字段 | 校验规则 |
| --- | --- |
| `status` | 整数，200–599 |
| `headers` | 字符串键值对象（必填，无自定义头时写 `{}`）；头名称须合法；值不得含换行/控制字符，只能使用 Latin-1 字符；不得设置 `Connection`、`Keep-Alive`、`Content-Length`、`Transfer-Encoding` |
| `body` | 文本字符串；状态码为 **204 / 304** 时必须为空字符串 |
| `delay` | 整数毫秒，0–60000 |

未知字段（任何层级）、重复接口（方法+路径相同）、类型错误等都会导致整份配置被拒绝。

## 请求正文结构规则（`requestBody`，可选）

`POST` 接口可附加 `requestBody`，在请求**完整接收后**校验正文；`GET` 接口声明该字段会被拒绝。规则是递归的 JSON 对象，每个节点必须带 `type`，可取：

| `type` | 含义 | 附加字段 |
| --- | --- | --- |
| `"object"` | JSON 对象 | `fields`：对象，字段名 → 子规则（可省略，默认 `{}`）；`additionalFields`：布尔，是否允许未声明字段（默认 `false`，即拒绝） |
| `"array"` | JSON 数组 | `items`：元素规则（**必填**） |
| `"string"` | 字符串 | 无 |
| `"number"` | 有限数字 | 无 |
| `"integer"` | 整数 | 无 |
| `"boolean"` | 布尔值 | 无 |
| `"null"` | JSON `null` | 无 |

对象字段的子规则可额外带 `required: true` 标记必填；未标记必填的字段可缺省。`required` 只允许出现在对象字段声明位置。不引入其他约束种类（没有长度、取值范围等）。

```json
{
  "method": "POST",
  "path": "/api/order",
  "requestBody": {
    "type": "object",
    "fields": {
      "id":   { "type": "integer", "required": true },
      "note": { "type": "string" },
      "tags": { "type": "array", "items": { "type": "string" } },
      "meta": { "type": "object", "additionalFields": true, "fields": {} }
    }
  },
  "responses": [ { "status": 200, "headers": {}, "body": "ok", "delay": 0 } ]
}
```

非法规则（未知 `type`、数组缺 `items`、未知字段、`required` 位置错误等）与未知配置字段一样，在**启动或重载时**被拒绝，错误信息给出配置中的位置（如 `endpoints[0].requestBody.fields["id"].type ...`）。不含 `requestBody` 的旧场景文件无需修改即可直接使用。

### 校验流程与 400 差异报告

启用规则的接口在请求完整接收后依次检查：

1. **媒体类型**：`Content-Type` 忽略大小写匹配 `application/json`（可带 `; charset=utf-8` 等参数）；缺失或不符 → 400；
2. **JSON 解析**：按 UTF-8 解析正文；空正文或非法 JSON → 400；
3. **结构比对**：按规则递归比对；任何不符 → 400。

失败响应为 JSON 报告，并携带当前版本的 `X-Contractlab-Version` 头；**不发送场景响应、不消费响应序列**（下一次合格请求仍取得应有的那一项）：

```json
{
  "error": "request body rejected",
  "phase": "structure",
  "problems": [
    { "pointer": "/id", "expected": "integer", "actual": "string" },
    { "pointer": "/tags/1", "expected": "string", "actual": "number" },
    { "pointer": "/extra", "expected": "undeclared field (absent)", "actual": "boolean" }
  ]
}
```

- `phase` 区分问题阶段：`content-type`（媒体类型）、`parse`（空正文/非法 JSON）、`structure`（结构不符）。
- 结构问题列出**全部**独立差异，`pointer` 为 JSON Pointer（RFC 6901，字段名中的 `~`、`/` 转义为 `~0`、`~1`；数组差异含元素下标）。
- 缺失字段的指针指向该字段本身（`actual: "missing"`）；额外字段指向其自身；父节点类型错误只报告该节点，不再产生子节点错误；合法 JSON `null` 是“存在的值”，与字段缺失分开判断。
- 校验规则、响应序列与版本取自请求完整接收时的同一配置快照；校验通过后才预留响应。重载语义与响应序列一致：成功重载一次性替换规则与响应、版本 +1、序列重置；失败保留旧规则、旧版本与消费位置。

## 响应序列语义

- 请求**被完整接收后**才按当时配置匹配接口并立即预留序列下一项；同一接口按完整接收的先后顺序取项：第 1 次请求取第 1 项，第 2 次取第 2 项，不跳项、不提前复用。
- 序列耗尽后**持续复用末项**。
- 查询串差异（如 `/api/order?a=1` 与 `/api/order?b=2`）命中同一接口，共享同一条序列；不同接口各自独立计数。
- 请求未完整接收即断开（如只发了半个 POST body）：**不推进序列**。
- 一旦已预留，客户端随后断开仍算消费；响应会在延迟结束后尝试发送（发送失败被忽略）。
- 未匹配的请求返回 `404`，不消费任何序列。
- 每个业务响应都带响应头 `X-Contractlab-Version: <版本号>`（404、正文校验 400 等框架响应同样携带）。配置的 `headers` 中允许出现同名头（任意大小写），文件可正常加载，但发送时忽略其值，响应只携带服务器给出的唯一版本头。

## 管理入口（不消费业务序列）

| 入口 | 说明 |
| --- | --- |
| `GET /__contractlab/health` | 健康查询，返回 `{"status":"ok","version":N}` |
| `POST /__contractlab/reload` | 重新读取启动时指定的**同一文件** |

`reload` 的返回：

- 成功：`{"ok":true,"version":N}` —— 新配置**全部有效**时才一次性原子替换全部接口、重置全部序列、版本号 +1；
- 失败：`{"ok":false,"version":N,"error":"...原因..."}` —— 读文件、JSON 解析或校验失败时，配置、版本与各序列的消费位置**保持不变**，旧场景继续可用。

并发 reload 按 HTTP 请求的接收顺序依次处理；请求要么看到旧配置、要么看到新配置，不会看到混合状态。

版本切换的在途语义：请求预留响应时持有当时那一项的完整快照（状态码、响应头、正文、延迟、版本）。即使预留之后、延迟结束之前发生了成功 reload，该请求仍按**旧版本**响应（头中版本号也是旧的），且完成时不会推进新版本的序列；reload 成功后新进入的请求才使用新版本并从各自序列第 1 项开始。

## 本机观察示例

```sh
# 1) 启动
node app.ts serve -c ./scenes.json -p 8080

# 2) 连续请求观察顺序：created -> paid -> boom -> boom -> ...
curl -sS -i http://127.0.0.1:8080/api/order
curl -sS -i http://127.0.0.1:8080/api/order
curl -sS -i 'http://127.0.0.1:8080/api/order?anything=ignored'

# 3) 健康查询（不消费序列）
curl -sS http://127.0.0.1:8080/__contractlab/health

# 4) 修改 scenes.json 后热更新，观察返回中的版本号
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload

# 5) 改成非法 JSON 再 reload：ok=false、version 不变，旧接口仍可请求
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload
curl -sS -i http://127.0.0.1:8080/api/order
```

### 观察正文校验

假设配置中有上文 `/api/order` 的 `requestBody` 规则：

```sh
# 1) 结构差异：400 + 逐项差异报告（JSON Pointer、期望/实际），不消费序列
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' \
  -d '{"id":"oops","tags":["a",1],"extra":true}'

# 2) 媒体类型缺失/不符、空正文、非法 JSON：同样 400，phase 分别为 content-type / parse
curl -sS -i -X POST http://127.0.0.1:8080/api/order -d '{"id":1}'
curl -sS -i -X POST http://127.0.0.1:8080/api/order -H 'Content-Type: application/json' -d 'not-json'

# 3) 合格请求仍按完整接收顺序取得序列第 1 项（之前的 400 没有消费）
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{"id":1,"tags":["a"]}'

# 4) 规则热更新：修改 scenes.json 中的 requestBody（如 id 改为 string），reload 后新规则立即生效
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"id":"now-a-string"}'

# 5) 把规则改坏（如 "type":"strig"）再 reload：ok=false、version 不变，
#    旧规则继续生效，旧序列消费位置不变
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"id":"still-checked-by-old-rule"}'
```

## 启动失败与进程信号

- 配置无效：不创建监听，进程以状态码 1 退出，stderr 给出可定位的原因（含 JSON 指针式位置，如 `endpoints[0].responses[1].status ...`）。
- 端口被占用：同样启动失败、不留下监听。
- 收到 `SIGINT`（Ctrl-C）或 `SIGTERM`：关闭监听、取消所有尚未发出的延迟响应、断开连接后正常退出（状态码 0）。
