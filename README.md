# contractlab

本地 API 联调与契约工具。当前提供一个**可热更新的本地接口场景服务**（在本机启动 HTTP 服务，让客户端在同一接口上连续获得预设响应；修改场景文件后通过管理入口重新加载，重载期间服务不中断），以及一个**离线兼容报告**命令（比较旧、新两份场景文件，判断沿用旧接口约定的客户端是否仍能调用新版）。

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

# 离线兼容报告：比较旧、新两份场景文件，不启动服务
node app.ts compare --old ./v1.json --new ./v2.json
node app.ts compare -o ./v1.json -n ./v2.json
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
| `requestBody` | 可选，**仅 POST**；请求正文结构规则（见下节）。不配置时保持原有正文处理方式（不校验） |

序列每项字段：

| 字段 | 校验规则 |
| --- | --- |
| `status` | 整数，200–599 |
| `headers` | 字符串键值对象（必填，无自定义头时写 `{}`）；头名称须合法；值不得含换行/控制字符，只能使用 Latin-1 字符；不得设置 `Connection`、`Keep-Alive`、`Content-Length`、`Transfer-Encoding`。可声明 `X-Contractlab-Version`（含大小写变体），发送时其值被忽略，版本头始终由服务器填写 |
| `body` | 文本字符串；状态码为 **204 / 304** 时必须为空字符串 |
| `delay` | 整数毫秒，0–60000 |

未知字段（任何层级）、重复接口（方法+路径相同）、类型错误等都会导致整份配置被拒绝。

## 请求正文结构规则（`requestBody`）

POST 接口可附加 `requestBody`，在请求**完整接收后**先校验正文，再决定是否预留响应。规则是递归的 JSON 对象，`type` 必填，未知字段一律拒绝（GET 接口声明此规则同样拒绝）：

```json
{ "type": "object",
  "fields": { "<字段名>": { "type": "...", "required": true } },
  "additionalProperties": false }
{ "type": "array", "items": { "type": "..." } }
{ "type": "string" }   { "type": "number" }   { "type": "integer" }
{ "type": "boolean" }  { "type": "null" }
```

- `object`：`fields` 声明字段（可省略，默认无声明字段）；字段规则 = 任意规则 + 可选 `"required": true`，未标记必填的字段可缺省；`additionalProperties` 可省略，**默认 `false`（拒绝未声明字段）**。
- `array`：**必须**声明 `items` 元素规则。
- `number` 只接受有限数字；`integer` 只接受整数。除此之外不引入其他约束种类（无长度、范围、格式等）。
- 非法规则（含未知字段、GET 上声明、数组缺 `items` 等）在启动或 reload 时整份拒绝，错误信息给出配置位置，如 `endpoints[0].requestBody.fields["a"] 含未知字段 "minLength"`。

示例：

```json
{
  "method": "POST",
  "path": "/api/order",
  "requestBody": {
    "type": "object",
    "fields": {
      "id":    { "type": "integer", "required": true },
      "note":  { "type": "string" },
      "tags":  { "type": "array", "items": { "type": "string" } },
      "buyer": { "type": "object", "required": true,
                 "fields": { "name": { "type": "string", "required": true } } }
    }
  },
  "responses": [ { "status": 200, "headers": {}, "body": "ok", "delay": 0 } ]
}
```

### 校验流程与 400 差异报告

对声明了规则的接口，请求完整接收后依次检查：

1. **媒体类型**：`Content-Type` 忽略大小写须为 `application/json`（可带参数，如 `; charset=utf-8`）；缺失或不符 → 400；
2. **解析**：正文非空、合法 UTF-8、合法 JSON，否则 → 400；
3. **结构**：按规则递归比对，有任何差异 → 400。

任一失败都返回 **HTTP 400** 与 JSON 差异报告，**不发送场景响应、不消费响应序列**（下一次合格请求仍取得本应取到的项）。报告区分解析与结构问题：

```json
{
  "error": "invalid_request_body",
  "stage": "parse",
  "message": "请求正文不是合法 JSON：...",
  "problems": []
}
```

```json
{
  "error": "invalid_request_body",
  "stage": "structure",
  "message": "请求正文与接口约定存在 2 处差异",
  "problems": [
    { "pointer": "/tags/1",  "expected": "string",           "actual": "number"  },
    { "pointer": "/a~1b~0c", "expected": "string（必填字段）", "actual": "missing" }
  ]
}
```

- `problems` 列出**全部**独立差异；`pointer` 是 RFC 6901 JSON Pointer（字段名中的 `~`、`/` 分别转义为 `~0`、`~1`，根为 `""`），数组错误含元素下标。
- 缺失字段指向该字段本身；未声明的额外字段指向其自身；父节点类型不符只报告该节点，不再产生子节点错误。
- 合法的 JSON `null` 与字段缺失分开判断（`"paid": null` 不是缺失）。
- 400 报告与场景响应一样携带准确的 `X-Contractlab-Version`。

校验规则、响应序列与版本号取自请求完整接收时的**同一配置快照**；校验通过才预留响应项，合格请求仍按完整接收顺序取项、耗尽后复用末项。reload 成功一次性替换规则与响应（版本 +1、序列重置）；reload 失败保留旧规则、旧版本与消费位置；已预留的延迟响应继续使用旧快照。

## 离线兼容报告（compare）

不启动监听、不修改任何文件，直接比较两份本地场景文件，判断**沿用旧接口约定的客户端是否仍能调用新版**：

```sh
node app.ts compare --old ./v1.json --new ./v2.json
```

- 两份文件都使用与 `serve` 完全相同的配置格式，**全部读取、解析并严格校验通过后**才输出报告；任一文件失败（读取、JSON 解析、未知字段、非法规则等）都在 **stderr** 指明文件与可定位原因（如 `endpoints[0].requestBody.fields["a"] 含未知字段 "__proto__"`），以状态码 **2** 退出，不输出部分报告。
- 兼容方向固定为 **旧 → 新**：旧配置能按“方法 + 字面路径”匹配且通过正文检查的每一种请求，在新配置中仍须匹配并通过。查询串不参与匹配；**新增接口不破坏兼容，删除旧接口不兼容**；响应状态、头、正文、延迟与序列差异不影响结论。
- 旧接口未配置 `requestBody` 而新版启用时，因原先允许任意正文与媒体类型，判为**不兼容**；移除规则则更宽松，判为兼容。
- 双方都配置规则时，比较的是**规则所接受 JSON 值集合的包含关系**（L(旧) ⊆ L(新)），而非文本比较或抽样：覆盖必填/可选字段、未声明字段策略（`additionalProperties`）、嵌套数组与全部类型；`integer` 放宽为 `number` 兼容，反向不兼容；新增可选字段也可能限制旧版允许的额外字段；数组元素收紧以非空数组反例体现。

报告以 JSON 写往 **stdout**：整体结论 + 每个旧接口的结论。每个不兼容接口给出至少一处原因和一份**可复用的完整请求反例**（方法、路径、必要请求头、原始正文）——该请求被旧配置匹配并通过检查，却在新配置中找不到接口或被正文检查拒绝。正文差异用 RFC 6901 指针定位（根为 `""`），接口删除以方法 + 路径定位：

```json
{
  "compatible": false,
  "oldFile": "/abs/v1.json",
  "newFile": "/abs/v2.json",
  "endpoints": [
    {
      "method": "POST",
      "path": "/api/user",
      "compatible": false,
      "reasons": [
        { "pointer": "/name", "message": "新规则要求必填字段 \"name\"，旧规则允许缺省该字段" }
      ],
      "example": {
        "method": "POST",
        "path": "/api/user",
        "headers": { "Content-Type": "application/json" },
        "body": "{\"id\":0}"
      }
    }
  ]
}
```

退出码：兼容 **0**，不兼容 **1**，参数/读取/解析/校验失败 **2**。

## 响应序列语义

- 请求**被完整接收后**才按当时配置匹配接口并立即预留序列下一项；同一接口按完整接收的先后顺序取项：第 1 次请求取第 1 项，第 2 次取第 2 项，不跳项、不提前复用。
- 序列耗尽后**持续复用末项**。
- 查询串差异（如 `/api/order?a=1` 与 `/api/order?b=2`）命中同一接口，共享同一条序列；不同接口各自独立计数。
- 请求未完整接收即断开（如只发了半个 POST body）：**不推进序列**。
- 一旦已预留，客户端随后断开仍算消费；响应会在延迟结束后尝试发送（发送失败被忽略）。
- 未匹配的请求返回 `404`，不消费任何序列。
- 每个业务响应都带响应头 `X-Contractlab-Version: <版本号>`（404 等框架响应同样携带）。

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

## 本机观察：正文校验

```sh
# 1) 合格请求按序取项（媒体类型忽略大小写、可带参数）
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: Application/JSON; charset=utf-8' \
  -d '{"id":1,"buyer":{"name":"ann"}}'

# 2) 结构差异：400 + 全部差异的 JSON Pointer 报告，不消费序列
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' \
  -d '{"id":"oops","tags":["a",2],"extra":1}'

# 3) 解析问题：缺/错媒体类型、空正文、非法 JSON 都是 400 + "stage":"parse"
curl -sS -i -X POST http://127.0.0.1:8080/api/order -H 'Content-Type: application/json' -d '{bad'

# 4) 拒绝不消费：下一条合格请求仍取得它本应取到的响应项
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"id":2,"buyer":{"name":"bob"}}'

# 5) 修改 scenes.json 中的 requestBody 后 reload：新规则立即生效、版本 +1
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload

# 6) 把规则改非法（如数组缺 items）再 reload：ok=false，旧规则继续拦截
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload
curl -sS -i -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"id":"still-old-rule"}'
```

## 启动失败与进程信号

- 配置无效：不创建监听，进程以状态码 1 退出，stderr 给出可定位的原因（含 JSON 指针式位置，如 `endpoints[0].responses[1].status ...`）。
- 端口被占用：同样启动失败、不留下监听。
- 收到 `SIGINT`（Ctrl-C）或 `SIGTERM`：关闭监听、取消所有尚未发出的延迟响应、断开连接后正常退出（状态码 0）。

## 自动化回归测试

离线兼容报告（compare）配有自动化回归测试，使用 Node.js 24 内置测试运行器，无外部依赖：

```sh
npm test        # 等价于 node --test "test/*.test.ts"
```

- `test/rule-matrix.test.ts` —— 规则包含关系矩阵：对一组确定性的小型递归规则对（交叉覆盖全部标量类型、integer/number 双向变化、必填/可选字段、additionalProperties 两种策略、对象与数组嵌套），用**独立**参考实现（`test/helpers.ts` 中的 `accepts()`，仅依据本文档语义编写，不调用产品的校验、比较或反例构造函数）在有限代表值域上穷举被旧规则接受的值，据此判断旧→新包含关系，再核对真实 compare 命令的逐接口结论、整体结论与退出码。代表值域区分整数与非整数、字段缺失与 null、空与非空数组、已声明字段与未声明额外字段，足以见证本矩阵每对规则的接受差异；这只是针对所测规则对的充分见证域，**不声称有限检查能证明任意递归规则的包含关系**。
- `test/scenarios.test.ts` —— 典型变更场景（双方允许额外字段但新版新增可选字段限制取值、必填字段嵌套收紧、删除带正文规则的 POST 接口、启用/移除正文规则、新增接口、仅修改响应，以及空字段名、`__proto__`、含斜杠/波浪号的字段名）：断言结论与原因的 JSON Pointer 转义和定位（不固定自然语言措辞、原因排序或反例正文取值），并把报告给出的完整请求反例**原样重放**到分别加载旧、新配置的真实本机服务——旧服务必须返回场景成功响应，新服务必须返回与变更相符的 400（正文校验）或 404（接口不存在）。
- `test/compare-errors.test.ts` —— 任一输入文件读取、JSON 解析或递归配置校验失败时退出码 2、stderr 可定位、stdout 无部分报告。

测试使用独立临时文件与端口 0（以实际监听地址继续请求），不依赖固定端口、外网或固定等待时间；子进程卡住会在有限时间内使测试失败，成功与失败均关闭子进程并清理临时文件。
