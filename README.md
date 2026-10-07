# contractlab

本地 API 联调与契约工具。当前提供一个**可热更新的本地接口场景服务**（在本机启动 HTTP 服务，让客户端在同一接口上连续获得预设响应；修改场景文件后通过管理入口重新加载，重载期间服务不中断），一个**离线兼容报告**命令（比较旧、新两份场景文件，判断沿用旧接口约定的客户端是否仍能调用新版），一个 **OpenAPI 请求正文约定导入**命令（把本地 OpenAPI 3.0 文档中的请求正文约定转换为场景文件的 `requestBody` 规则），一个**离线批量请求校验**命令（把保存的请求记录快照对照指定场景逐条重新检查），一个**本机请求重放与响应差异报告**命令（把快照中的请求逐条重放到本机指定端口，比较实际响应与记录中的计划响应；可选比较策略为指定接口启用响应正文 JSON 语义比较），以及一个**离线响应分支可达性诊断**命令（不发送任何请求，离线判断声明了 `branches` 的 POST 接口中每一分支与兜底是否会被合格请求选中，发现永远不会被首先选中的分支）。

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

# OpenAPI 请求正文约定导入：输出可直接用于 serve / compare 的新场景 JSON
node app.ts import --openapi ./api.json --config ./scenes.json > scenes.new.json
node app.ts import -s ./api.json -c ./scenes.json > scenes.new.json

# 离线批量请求校验：把请求记录快照对照指定场景逐条重新检查
node app.ts verify --requests ./snapshot.json --config ./scenes.json
node app.ts verify -r ./snapshot.json -c ./scenes.json

# 本机请求重放：把快照中的请求逐条重放到 127.0.0.1 的指定端口并比较响应
node app.ts replay --requests ./snapshot.json --port 8080 --timeout 5000
node app.ts replay -r ./snapshot.json -p 8080 -t 5000

# 可选：按比较策略为指定接口启用响应正文 JSON 语义比较（其余接口仍按字节比较）
node app.ts replay -r ./snapshot.json -p 8080 -t 5000 --strategy ./compare-strategy.json
node app.ts replay -r ./snapshot.json -p 8080 -t 5000 -s ./compare-strategy.json

# 离线响应分支可达性诊断：不启动服务、不发送请求，判断每一分支与兜底是否可达
node app.ts reach --config ./scenes.json --path /api/order
node app.ts reach -c ./scenes.json -p /api/order
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
| `responses` | **非空**响应序列数组；声明了 `branches` 时它是**无分支命中的兜底序列** |
| `requestBody` | 可选，**仅 POST**；请求正文结构规则（见下节）。不配置时保持原有正文处理方式（不校验） |
| `branches` | 可选，**仅 POST 且必须已声明 `requestBody`**；按请求正文值选择响应的有序分支（见下节） |

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
{ "type": "string", "enum": ["created", "paid"] }   // 标量节点可附 enum
```

- `object`：`fields` 声明字段（可省略，默认无声明字段）；字段规则 = 任意规则 + 可选 `"required": true`，未标记必填的字段可缺省；`additionalProperties` 可省略，**默认 `false`（拒绝未声明字段）**。
- `array`：**必须**声明 `items` 元素规则。
- `number` 只接受有限数字；`integer` 只接受整数。除此之外不引入其他约束种类（无长度、范围、格式等）。
- **可空约定**：任意规则节点（根、字段、数组元素）可附**布尔** `nullable`。省略或 `false` 行为不变；`true` 在原接受集合上加入 `null`（`"type": "null"` 本就只接受 `null`，附加 `nullable` 不改变这一点）。**必填字段即使可空也不能缺失**；`null` 被接受时不产生任何子节点差异，非 `null` 值仍须通过该节点的全部原约束。可空规则中的非法子规则（未知字段、数组缺 `items`、`nullable` 非布尔等）仍在启动或 reload 时整份拒绝。
- **枚举约定**：标量节点（`string` / `number` / `integer` / `boolean` / `null`，含根、字段与数组元素）可附 `enum` **非空数组**；`object` / `array` 节点**禁止** `enum`（按未知字段拒绝）。每个候选项须符合节点类型（`number` 限有限数字、`integer` 限整数），**不做类型转换**；含 `null` 项要求节点为 `nullable: true` 或 `type: "null"`。顺序与重复值不影响语义；数字按数值相等（`0` 与 `-0` 等价）。有 `enum` 时接受集合为**类型及可空集合与枚举集合的交集**：**可空不越过枚举**（`null` 须列入 `enum` 才被接受），必填字段仍不得缺失，无 `enum` 时行为不变。非法枚举（空数组、非数组、候选类型不符、`null` 项无可空等）在启动或 reload 时整份拒绝并定位，如 `endpoints[0].requestBody.fields["a"].enum[1] 必须是 integer（与节点类型一致，不做类型转换），收到 0.5`。
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

可空约定（`nullable: true`）与枚举约定（`enum`）只作用于第 3 步的结构比对：**不放宽**媒体类型、UTF-8 与 JSON 解析检查；空正文仍是解析失败，**不等于 `null`**（`null` 指正文解析出的 JSON 字面量 `null`）。

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
  "message": "请求正文与接口约定存在 3 处差异",
  "problems": [
    { "pointer": "/tags/1",  "expected": "string",           "actual": "number"  },
    { "pointer": "/a~1b~0c", "expected": "string（必填字段）", "actual": "missing" },
    { "pointer": "/state",   "expected": "枚举 [\"created\",\"paid\"] 之一", "actual": "\"archived\"" }
  ]
}
```

- `problems` 列出**全部**独立差异；`pointer` 是 RFC 6901 JSON Pointer（字段名中的 `~`、`/` 分别转义为 `~0`、`~1`，根为 `""`），数组错误含元素下标。
- 缺失字段指向该字段本身；未声明的额外字段指向其自身；父节点类型不符只报告该节点，不再产生子节点错误。
- 枚举拒绝沿用同一 structure 报告：`expected` 为 `枚举 [<候选值 JSON>] 之一`（列全候选值），`actual` 为实际值的 JSON 表示；**类型错误不重复报枚举错误**（类型不符只报类型差异一条）。
- 合法的 JSON `null` 与字段缺失分开判断（`"paid": null` 不是缺失）。
- 400 报告与场景响应一样携带准确的 `X-Contractlab-Version`。

校验规则、响应序列与版本号取自请求完整接收时的**同一配置快照**；校验通过才预留响应项，合格请求仍按完整接收顺序取项、耗尽后复用末项。reload 成功一次性替换规则与响应（版本 +1、序列重置）；reload 失败保留旧规则、旧版本与消费位置；已预留的延迟响应继续使用旧快照。

## 按请求正文选择响应分支（`branches`）

声明了 `requestBody` 的 POST 接口还可以配置**有序响应分支**：请求通过媒体类型、UTF-8、JSON 与结构全部校验后，按正文值命中某一分支，返回该支自己的响应序列；都不命中时使用接口 `responses` 兜底序列。**GET 接口与未声明 `requestBody` 的 POST 接口禁止配置分支**（启动或 reload 时整份拒绝）。

```json
{
  "method": "POST",
  "path": "/api/order",
  "requestBody": {
    "type": "object",
    "fields": { "state": { "type": "string" }, "amount": { "type": "number" } },
    "additionalProperties": false
  },
  "responses": [
    { "status": 200, "headers": {}, "body": "default", "delay": 0 }
  ],
  "branches": [
    {
      "id": "paid",
      "when": { "/state": "paid" },
      "responses": [
        { "status": 201, "headers": {}, "body": "paid-1", "delay": 0 },
        { "status": 201, "headers": {}, "body": "paid-2", "delay": 0 }
      ]
    },
    {
      "id": "paid-big",
      "when": { "/state": "paid", "/amount": 100 },
      "responses": [
        { "status": 202, "headers": {}, "body": "paid-big", "delay": 0 }
      ]
    }
  ]
}
```

每个分支字段：

| 字段 | 校验规则 |
| --- | --- |
| `id` | **非空字符串**，且在同一接口的分支间**唯一**（仅用于记录与定位，不发给客户端） |
| `when` | **非空**对象：键为 RFC 6901 JSON Pointer，值为等值条件；**全部条件都满足**才命中该支 |
| `responses` | **非空**响应序列数组，规则与接口级 `responses` 每项完全相同 |

### 条件（`when`）

- 键是 **RFC 6901 JSON Pointer**：`""` 表示请求正文的根值；`"/state"` 取对象自有字段；`"/items/0"` 取数组下标。字段名中的 `~`、`/` 分别写作 `~0`、`~1`（如字段 `a/b` 的指针是 `/a~1b`）。**空字段名**（指针 `/`）、名为 **`__proto__`** 的字段都按普通自有字段处理，转义语义与结构报告一致。
- 数组下标只接受 `0` 或非零开头的十进制整数（`01`、`-`、越界下标都取不到值）。
- 值只能是**字符串、有限数字、布尔或 `null`**（对象、数组、`NaN`/`Infinity` 不合法；JSON 中也写不出 `NaN`）。
- **取值不存在或无法遍历（在标量/`null` 上继续深入、下标越界、字段缺失）即该条件不匹配**；**字段缺失不同于显式 `null`**——条件值 `null` 只命中指针处确实是 JSON `null` 的请求，命不中缺失字段。
- 比较为**严格相等、不做类型转换**（`"1"` ≠ `1`，`true` ≠ `"true"`）；数字按数值相等，**`0` 与 `-0` 相等**。

### 选择、优先级与计数

- 请求必须先**通过全部正文校验**（否则返回 400，不进入分支选择、不消费任何序列），然后用接收时的同一配置快照，按 `branches` 声明顺序选**第一个全部条件满足的分支**；多支同时命中时**取第一支**（如上例中 `state:"paid", amount:100` 命中排在前面的 `paid`）；都不命中取接口 `responses` 兜底。
- **每个分支与兜底各有独立计数、各自的响应序列**：同一序列按请求**完整接收顺序**取下一项，耗尽后持续复用末项；命中不同分支（或兜底）的请求互不挤占对方位置。查询串不参与匹配，命中同一接口的请求仍共享这些计数。
- 分支选择只决定返回哪条序列，**不改写请求字节**。
- **400（正文拒绝）、404（未匹配）、413（超上限）以及未收完整的请求不消费任何序列**；一旦已预留某支/兜底项，客户端随后断开仍消费该选中项（与无分支时一致）。

### 与其他能力的关系

- **请求记录**：场景请求在记录中区分分支、兜底与未选择（见“本地请求记录”），`sequencePosition`/`sequenceLength` 对应**选中的那一条序列**；计划响应与真正写上线的内容一致。
- **reload**：成功时原子替换规则、分支与全部响应，版本 +1 并重置兜底与各分支的**全部**计数；失败保留旧配置、版本与消费位置。reload 前已预留的旧延迟响应保留其原选中项与版本，完成时**不推进**新配置的任何序列。
- **compare / verify**：仍只依据接口存在性与正文接受条件（`requestBody`）下结论，**分支变化不影响结论**——compare 不比较分支与响应，verify 不选择分支、不推进序列。
- **import**：原样保留接口的 `branches`（分支、顺序与响应都不动），仅替换 `requestBody` 规则与保留 `responses`；若导入的 OpenAPI 操作未声明 `requestBody`（会移除正文规则）而该接口声明了分支，则**分支前提失效，整份拒绝**（退出 2、stderr 定位到文件与操作、stdout 为空）。

非法分支配置（GET 或无正文规则的接口配置分支、空/非数组 `branches`、重复或空 `id`、空 `when`、非法指针或条件值、非法响应项、任何层级的未知字段）都会在启动或 reload 时**整份拒绝**并定位，如 `endpoints[0].branches[1].when["/a~2"] 的指针 "/a~2" 非法：第 0 段含非法转义（仅支持 ~0 与 ~1）`。

## 离线兼容报告（compare）

不启动监听、不修改任何文件，直接比较两份本地场景文件，判断**沿用旧接口约定的客户端是否仍能调用新版**：

```sh
node app.ts compare --old ./v1.json --new ./v2.json
```

- 两份文件都使用与 `serve` 完全相同的配置格式，**全部读取、解析并严格校验通过后**才输出报告；任一文件失败（读取、JSON 解析、未知字段、非法规则等）都在 **stderr** 指明文件与可定位原因（如 `endpoints[0].requestBody.fields["a"] 含未知字段 "__proto__"`），以状态码 **2** 退出，不输出部分报告。
- 兼容方向固定为 **旧 → 新**：旧配置能按“方法 + 字面路径”匹配且通过正文检查的每一种请求，在新配置中仍须匹配并通过。查询串不参与匹配；**新增接口不破坏兼容，删除旧接口不兼容**；响应状态、头、正文、延迟与序列差异不影响结论。
- 旧接口未配置 `requestBody` 而新版启用时，因原先允许任意正文与媒体类型，判为**不兼容**；移除规则则更宽松，判为兼容。
- 双方都配置规则时，比较的是**规则所接受 JSON 值集合的包含关系**（L(旧) ⊆ L(新)），而非文本比较或抽样：覆盖必填/可选字段、未声明字段策略（`additionalProperties`）、嵌套数组与全部类型；`integer` 放宽为 `number` 兼容，反向不兼容；新增可选字段也可能限制旧版允许的额外字段；数组元素收紧以非空数组反例体现。可空约定同样按集合语义判定：旧规则接受 `null`（`nullable: true` 或 `type: null`）而新规则不接受即不兼容，反例正文为 `null`（嵌套时反例仍包含必要的父对象与其他必填字段）；**可空不能掩盖非 `null` 约束的变化**——例如 `integer` 换成 `nullable` 的 `number` 兼容，而 `number` 换成 `nullable` 的 `integer` 仍以非整数反例判为不兼容。枚举同样按集合语义精确判定：接受集合为“类型及可空集合”与枚举集合的交集，覆盖枚举增删、枚举与非枚举规则的交叉比较（如 `number` 枚举全为整数时兼容非枚举 `integer`，含非整数则以该枚举值为反例判不兼容）与可空变化（`null` 须列入枚举才算被接受）；不兼容时反例取旧规则接受、新规则拒绝的具体值（嵌套时保留必要的父对象与必填字段）。

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

## OpenAPI 请求正文约定导入（import）

不启动监听、不联网、不修改任何输入文件：读取本地 **OpenAPI 3.0 JSON** 与**现有场景配置**，按“方法 + 字面路径”为每个场景接口选择文档操作，仅用操作声明的请求正文约定**替换**接口的 `requestBody`（保留接口顺序、`responses` 原文与 **`branches` 响应分支——分支、顺序与响应原样保留**），把可直接用于 `serve` / `compare` 的新场景 JSON 写往 **stdout**：

```sh
node app.ts import --openapi ./api.json --config ./scenes.json > scenes.new.json
```

### 操作选择与替换规则

- 场景中的**每个**接口都必须在文档 `paths` 中找到**同字面路径、同方法**的操作，否则整份拒绝；未被场景选中的操作与不可达的定义不参与转换（其中的错误不影响结果）。
- **GET** 操作声明 `requestBody` → 拒绝；**POST** 操作未声明 `requestBody` → **移除**该接口的旧规则（但若该接口声明了 `branches` 响应分支，移除正文规则会使分支前提失效，**整份拒绝**）。
- **POST** 操作声明 `requestBody` 时：`required` 必须为 `true`；`content` 仅允许且必须包含 `application/json` 一种媒体类型，且带 `schema`；否则拒绝。`requestBody` 本身也可以是本文件内 `$ref`。

### schema 转换规则

- 基础 schema 必须声明 `type`，仅支持 `object` / `array` / `string` / `number` / `integer` / `boolean`；递归支持 `properties`、`required`、`items` 与**布尔** `additionalProperties`。
- `required` 中的名称必须在**同层** `properties` 中声明；数组必须声明 `items`。
- `additionalProperties` 缺省按 OpenAPI 语义为**允许**，并在输出规则中**显式写出**（`"additionalProperties": true`）。
- 基础 schema（含递归字段、`items` 与本文件内 `$ref` 的目标）可声明**布尔** `nullable`：`true` 在转换结果的接受集合上加入 `null`（输出规则显式写出 `"nullable": true`），`false` 或省略不变；**非布尔值拒绝**。无 `type` 的 `allOf` 组合节点仍只允许 `nullable: false` 或省略；引用节点仍只能含 `$ref`。
- 基础**标量** schema（`string` / `number` / `integer` / `boolean`，含递归字段、`items` 与本文件内 `$ref` 的目标）可声明 `enum` **非空数组**，语义与场景规则一致：逐项符合类型（不做类型转换）、`null` 项要求 `nullable: true`、顺序与重复值不影响语义；`object` / `array` schema 与 `allOf` 组合节点**禁止** `enum`（按未支持关键字拒绝）。
- `title` / `description` / `example` 可忽略；其余未支持关键字、非法值一律拒绝。
- 字段名中的空名、`__proto__`、斜杠与波浪号原样保留。
- `$ref` 仅支持**本文件内**引用（`#` 开头的 JSON Pointer，按 `~0`/`~1` 转义解析）：共享引用允许；目标缺失、外部引用、循环引用拒绝并定位引用链；引用节点只含 `$ref` 一个字段。

### 纯对象 allOf

组合节点仅允许 `allOf` 及上述注释字段；分支可以是 `$ref` 或**任意深度的嵌套组合**（嵌套 allOf 会被展平为其全部对象叶分支），最终都必须组合为对象。转换结果是各分支**接受集合的交集**，而非简单字段合并，且按**所选操作最终请求正文的整体接受集合**一次判定：

- 结论与**分支顺序、嵌套分组、本文件内 `$ref`** 无关：等价写法要么同样成功且输出规则（接受集合）一致，要么同样拒绝；不会因为“中间两支先相交、暂时无法表达”就提前拒绝——只要再叠加其余分支后整体交集可表达，就必须成功。
- 同名字段**递归共同生效**（对象内部、数组元素都递归相交；`number` ∩ `integer` 取 `integer`；标量 `enum` 取候选交集——双方都带枚举取共同候选，只有一方带枚举时该方候选须符合另一方的类型约束，如 `number` 枚举 `[1, 0.5]` ∩ `integer` 取枚举 `[1]`）；必填取**并集**。
- 字段可出现的条件是：在**每个**分支中都已声明，或该分支允许额外字段——被某分支（`additionalProperties: false` 且未声明）禁止出现的字段不会留在结果中。
- 结果的 `additionalProperties` 为各分支的合取（任一分支拒绝则拒绝）。
- **可空交集**：交集含 `null` 当且仅当**全部**分支都接受 `null`（`nullable: true`）；非 `null` 部分按结构求交。非 `null` 部分为空而全部分支可空时，交集恰为 `{null}`，输出 `{"type": "null"}`；任一分支不可空则按整体空交集拒绝；非空但无法表达时同样拒绝（可空不能补救）。例如两个可空对象分支都要求 `x`、分别约束 `string` 与 `integer`：非 `null` 交集为空但双方都可空，**成功导入为仅接受 `null`**（`{"type": "null"}`）；任一分支不可空则以空交集拒绝。
- 拒绝时区分三种情形并在 stderr 给出**输入文件、可定位的操作或定义位置、冲突字段或元素及原因**：
  - **字段禁止出现**：可选字段被某分支禁止，结果中不声明它即可精确表达（可成功）；
  - **整体空交集**：如必填字段被另一分支禁止出现、必填同名字段类型或枚举候选相交为空；
  - **非空但无法表达**：交集里仍有值，但现有规则种类表达不了——如可选字段交集为空而所有分支都允许额外字段（无法表达“仅禁止该字段、其他字段任意”）、数组元素交集为空（交集仅剩空数组）。
- 字段即便在交集中最终被禁止出现，其在所选可达定义里的**非法值、未知关键字、引用错误仍照常拒绝**，不会因字段消失而被忽略；未选操作与不可达定义中的问题仍不影响导入。

例如三个开放对象分支都声明可选 `box`，其中 `box` 的前两支开放、`x` 分别为 `string` / `integer`，第三支 `box` 不声明内部字段且 `additionalProperties: false`：前两支的 `box` 交集本不可表达，但加入第三支后整体交集恰为“`box` 可省略或为空对象、`box` 中任何字段都拒绝，外层仍允许额外字段”，**必须成功导入**；删除第三支则因非空但无法表达而拒绝。对象交集位于**数组元素**时遵循同样规则（元素只接受空对象）。

调用方式不变：

```sh
node app.ts import --openapi ./api.json --config ./scenes.json > scenes.new.json
```

修复边界：仅改写 allOf 交集的判定方式（由“逐对折叠、中途拒绝”改为“展平叶分支后对全部分支整体求交”），**不新增规则种类**，也不改变必填并集、额外字段合取、`number` ∩ `integer` 取 `integer`、操作选择、`$ref` 解析与其余命令（serve / compare）的任何行为。

### 输出与退出码

全部输入（场景配置须通过与 `serve` 完全相同的严格校验）与所选可达定义**全部有效后**才输出；成功退出 **0**。参数、读取、JSON 解析、场景校验或转换失败退出 **2**：stderr 指明文件与操作或定义位置（如 `paths["/api/order"].post.requestBody.content["application/json"].schema -> #/components/schemas/Order.properties["id"]`），stdout 为空。

## 离线批量请求校验（verify）

不启动监听、不发送请求、不修改任何文件：读取 `GET /__contractlab/requests` 的**完整 JSON 快照文件**与一份**场景配置**，把快照中保存的实际请求对照该场景**逐条重新检查**，报告写往 **stdout**：

```sh
node app.ts verify --requests ./snapshot.json --config ./scenes.json
```

### 判定规则

- 按**输入顺序**保留原编号（`id`）逐条判定；结论仅依据记录中的原始请求（方法、`target`、原始请求头、无损正文）与所给场景**重新计算**——不信任记录里的配置版本、匹配/校验结论、计划响应与发送状态；`pending` / `sent` / `interrupted` 记录同样处理。
- 匹配与在线一致：**方法 + `target` 去掉查询串后的字面路径**；`target` 推导出的路径与记录 `path` 不符视为**输入错误**；非 GET/POST 方法的记录一律为**未匹配**。
- 仅对配置了 `requestBody` 的接口依次检查**媒体类型 → UTF-8 → JSON → 结构**（与在线完全相同的差异报告）；其余记录**不解析正文**。`Content-Type` 名称不分大小写，**重复头取在线顺序第一项**；媒体类型忽略大小写并允许参数。
- 正文按记录编码**无损还原**（`utf-8` 文本或 `base64`）并核对 `bodyBytes`；启用正文规则时，base64 还原出的非法 UTF-8 属于**请求解析拒绝**（`stage: "parse"`），不是输入文件错误。
- **命中接口且通过适用检查即为接受**：场景响应的状态码（包括 500）与请求是否被接受无关；不预留响应、不推进序列、不等待延迟。

### 报告与退出码

报告含总数、通过数、拒绝数与逐条结果；逐条结论区分四种：

| `outcome` | 含义 |
| --- | --- |
| `unmatched` | 未匹配（无此“方法 + 字面路径”接口，或方法非 GET/POST） |
| `no_body_check` | 命中接口，但该接口未配置正文规则（不解析正文） |
| `passed` | 命中接口且通过正文校验 |
| `rejected` | 命中接口但正文被拒绝（`rejection` 附完整的解析/结构差异报告，含全部 RFC 6901 指针、期望与实际值） |

```json
{
  "requestsFile": "/abs/snapshot.json",
  "configFile": "/abs/scenes.json",
  "total": 2,
  "accepted": 1,
  "rejected": 1,
  "results": [
    { "id": 1, "outcome": "passed", "endpoint": "POST /api/order" },
    {
      "id": 2,
      "outcome": "rejected",
      "endpoint": "POST /api/order",
      "rejection": {
        "error": "invalid_request_body",
        "stage": "structure",
        "message": "请求正文与接口约定存在 1 处差异",
        "problems": [ { "pointer": "/id", "expected": "integer", "actual": "string" } ]
      }
    }
  ]
}
```

退出码：**空快照或全部接受 0**；**存在请求拒绝（未匹配或正文拒绝）1**，此时仍报告全部记录；参数/读取/解析/校验失败 **2**。

### 输入要求（失败即整份拒绝）

两份输入**全部读取、解析与校验通过后**才输出任何报告。场景配置仍按与 `serve` 相同的严格校验；快照必须能**无损重建**每个请求，下列情况均属输入失败（退出 2，stderr 指明文件与位置如 `records[0].request.body`，stdout 为空，不猜补缺失字节）：

- 重建所需字段缺失或类型错误（`id`、`request.method/target/path/rawHeaders/bodyBytes/body`）；
- `count` 与 `records` 数量不符、记录编号重复；
- `rawHeaders` 不成对（名称、值交替）或元素非字符串；
- `body.encoding` 不是 `"utf-8"` / `"base64"`、base64 内容非法；
- `body.encoding` 为 `"utf-8"` 但 `content` 含**孤立代理项**（lone surrogate）：按 UTF-8 重新编码会被替换字符改写，即使替换后的字节数恰好与 `bodyBytes` 吻合也不再是原始字节；
- 还原字节长度与 `bodyBytes` 不符（快照已丢字节）。

记录中的版本、匹配/校验结论、计划响应、发送状态等字段不被信任、不参与判定，也不要求其存在。

## 本机请求重放与响应差异报告（replay）

不启动监听、不修改任何文件：读取 `GET /__contractlab/requests` 的**完整 JSON 快照文件**，把其中每条记录的原始请求按输入顺序**逐条重放**到 `127.0.0.1` 的指定端口，并把实际响应与记录中的**计划响应**比较，报告写往 **stdout**：

```sh
node app.ts replay --requests ./snapshot.json --port 8080 --timeout 5000
```

- `--port`：目标端口，`127.0.0.1` 上的**有效非零**端口（1–65535）。
- `--timeout`：**每条请求**的总超时，正整数毫秒。自开始连接覆盖完整收发，**持续来数据也不延长**。

### 重放规则

- 按**输入顺序**保留原编号（`id`）逐条重放：**前一条结束才发下一条**；每次执行每条**只尝试一次**，**不跟随重定向**（3xx 按其实际状态与正文参与比较）。
- **仅重放 GET/POST**；`target` 须为以 `/` 开头的合法 HTTP 请求目标，**原样发送**（保留查询串与百分号编码，不归一化路径）；`path` 须与去掉查询串的 `target` 一致。**禁止重放 `/__contractlab` 本身及 `/__contractlab/` 前缀路径**。
- 正文按记录编码**无损还原**（`utf-8` 文本或 `base64`）后原样发送：BOM、空白与非法 UTF-8 字节都原样到达，不改写 JSON。
- 请求头：**保留业务头的大小写、重复项与在线顺序**；剥离原 `Host`、`Expect`、HTTP 逐跳与分帧头（`Connection`、`Keep-Alive`、`Content-Length`、`Transfer-Encoding`、`TE`、`Trailer`、`Upgrade`、`Proxy-Authenticate`、`Proxy-Authorization`，以及 `Connection` 头指名的头），并按目标与实际字节数**重建 `Host` 与 `Content-Length`**。每条请求使用独立连接，响应结束后关闭。
- **参数与全部记录（含可发送的头名称和值）有效后才连接**：参数或快照失败退出 **2**，stderr 给出原因（快照错误定位文件与字段），stdout 为空且**不发任何请求**。
- 已发送的请求可能已被目标处理：replay 不重载、清空或回滚目标状态。

### 比较与报告

仅比较**状态码**与**正文**（默认按正文原始字节，计划正文按 UTF-8 编码作为参考；可用 `--strategy` 为指定接口改按 JSON 语义比较，见下节）；**不比较响应头**，也不依据记录的配置版本与发送状态判定——`pending` / `sent` / `interrupted` 均可重放，400/404/500 同样按内容比较。

- 连接失败、超过总超时或**响应中途断开**记为**通信失败**：关闭连接后继续后续记录；部分响应不算完整。
- 报告含总数、相同数、差异数、通信失败数与逐条结果。逐条结论：

| `outcome` | 含义 |
| --- | --- |
| `same` | 状态码与正文原始字节均与计划响应一致；`response` 保留实际状态与无损正文 |
| `different` | 状态或正文不同；`differences` 指出 `status` / `body` 哪项不同，`planned` 与 `response` 分别给出计划与实际的状态及无损正文 |
| `failed` | 通信失败；`reason` 给出原因 |

```json
{
  "requestsFile": "/abs/snapshot.json",
  "port": 8080,
  "timeoutMs": 5000,
  "total": 2,
  "same": 1,
  "different": 1,
  "failed": 0,
  "results": [
    {
      "id": 1,
      "outcome": "same",
      "response": { "status": 200, "body": { "encoding": "utf-8", "content": "seq-ok" } }
    },
    {
      "id": 2,
      "outcome": "different",
      "differences": { "status": false, "body": true },
      "planned": { "status": 201, "body": { "encoding": "utf-8", "content": "echo-ok" } },
      "response": { "status": 201, "body": { "encoding": "utf-8", "content": "echo-CHANGED" } }
    }
  ]
}
```

退出码：**空快照或全部相同 0**；**存在差异或通信失败 1**；参数/读取/解析/校验失败 **2**。

### 输入要求（在 verify 的快照校验之上）

replay 沿用与 verify 完全相同的快照完整校验（含孤立代理项拒绝），每条记录另须满足：

- `request.method` 为 `GET` 或 `POST`；
- `request.target` 是以 `/` 开头、不含空白/控制字符的合法 HTTP 请求目标，且不指向管理入口；
- `plannedResponse` 存在，`plannedResponse.status` 为 200–599 的整数，`plannedResponse.body` 为文本字符串（不含孤立代理项）；
- 剥离逐跳/分帧头后保留的业务头，其名称与值必须可发送（合法头名称；值不含换行/控制字符、仅 Latin-1）。

任一不满足即整份拒绝：退出 2，stderr 指明文件与字段（如 `records[0].plannedResponse.status`），stdout 为空，不发出任何请求。

### 响应正文 JSON 语义比较（`--strategy`，可选）

默认（不提供 `--strategy`）时全部接口按正文原始字节比较，命令、报告与退出码完全不变。提供比较策略文件后，策略按 **GET/POST 方法 + 去掉查询串后的字面路径**为接口选择 **JSON 语义比较**；未选中的接口仍按字节比较：

```sh
node app.ts replay -r ./snapshot.json -p 8080 -t 5000 --strategy ./compare-strategy.json
```

策略为一个 UTF-8 JSON 文件，顶层只有 `endpoints`（数组）。每个接口由 **方法 + 字面路径**唯一标识（与场景配置的路径规则相同），可附 `ignore` 忽略指针数组与 `align` 数组业务键对齐：

```json
{
  "endpoints": [
    { "method": "GET", "path": "/api/order", "ignore": ["/timestamp", "/items/1"] },
    { "method": "POST", "path": "/api/echo" },
    { "method": "GET", "path": "/api/users", "align": [{ "pointer": "/items", "key": "id" }] }
  ]
}
```

- `ignore` 可省略；每项是 **RFC 6901 JSON Pointer**（`""` 表示根），支持空字段名（指针 `/`）、`__proto__` 字段与 `~0`/`~1` 转义，语义与正文校验报告一致。
- **重复接口（方法+路径相同）、非法策略（未知字段、非法方法/路径等）或非法指针都整份拒绝**；重复或父子重叠的忽略项不改变结果。
- 忽略指针处的**值、存在性与子树**不参与比较：**不删除数组项、不移动下标**；两侧都无目标时无影响；祖先类型不同仍照常报告（如忽略 `/a/b` 而一侧 `a` 是对象、另一侧是数字，`/a` 的类型差异照报）。
- **策略、整份快照及所选记录的计划正文全部校验通过后才连接**：所选记录的计划正文须为 **UTF-8 JSON**（两侧解析仅可剥离**单个**开头 BOM，空正文非法），**忽略规则不豁免解析**。输入失败退出 **2**，stderr 定位文件与字段（如 `records[0].plannedResponse.body`），stdout 为空且**零请求**。

### 数组业务键对齐（`align`，可选）

接口可附 `align` 数组，为**互不嵌套**的数组位置各指定一个**元素自有字段**作业务键，避免列表排序变化造成误报：

```json
{ "method": "GET", "path": "/api/users", "align": [{ "pointer": "/items", "key": "id" }] }
```

- `pointer` 是 **RFC 6901 指针**（`""` 表示根，即整个正文为数组），支持 `~0`/`~1` 转义；`key` 是元素自有字段名（字符串，支持空名与 `__proto__`）。**重复位置、嵌套位置（含根与其他位置共存）或非法配置整份拒绝**（退出 2）。
- **位置不存在允许**；存在时该侧该位置**须为数组**，元素**须为对象**，键**须存在且为字符串、有限数字或布尔值**——严格按类型比较（`1` ≠ `"1"`）、`0` 与 `-0` 等价、不做类型转换、**`null` 不能作键**，且同一数组内**唯一**。
- **两侧数组按键配对，顺序不影响结论**；同键元素**递归比较全部未忽略差异**，未配置对齐的数组仍按下标比较。**只在一侧出现的键报告整个元素，不深入**；数组本身在一侧缺失按原节点差异处理（普通 `bodyDifferences`）。
- 对齐数组内的 `ignore` 指针**以计划原下标定位**，再作用于配对元素（包括缺失元素）；**新增键不能被其他下标的忽略项遮蔽**；忽略整数组或祖先仍生效；**忽略不改变配对身份，也不豁免键完整性与唯一性校验**。
- **计划侧**对齐位置存在但不合法（不是数组、元素非对象、键缺失/非法/重复）属于输入失败：退出 **2**，stderr 定位文件、记录与正文位置（如 `records[1].plannedResponse.body 的对齐位置 "/items"……正文位置 "/items/2"`），stdout 为空且**零请求**。**实际完整响应**中的对齐数组类型、元素或键非法记 **different**（附 `alignmentErrors` 说明位置与原因，该位置回退为按下标比较）并继续后续记录，不算通信失败。

JSON 模式下 `different` 记录在 `bodyDifferences` 之上可增加：

- `alignedDifferences`：对齐数组内的元素差异明细。每项给出 `array`（对齐数组位置）、`keyField` 与 `key`（业务键）、**存在侧在原始正文中的 RFC 6901 位置**（`plannedPointer` / `actualPointer`，该侧不存在时省略）、`planned` / `actual` 值及**双方独立存在性标记** `plannedExists` / `actualExists`——**缺失不以 `null` 或字符串 `"missing"` 表示**（该侧不存在时值字段为 `null`，由存在性标记区分）。
- `alignmentErrors`：实际响应中对齐位置非法的 `{ "pointer", "reason" }` 列表。

```json
{
  "id": 3,
  "outcome": "different",
  "differences": { "status": false, "body": true },
  "alignedDifferences": [
    { "array": "/items", "keyField": "id", "key": 2,
      "plannedPointer": "/items/1/state", "actualPointer": "/items/0/state",
      "plannedExists": true, "actualExists": true, "planned": "paid", "actual": "created" },
    { "array": "/items", "keyField": "id", "key": 3,
      "plannedPointer": "/items/2",
      "plannedExists": true, "actualExists": false, "planned": { "id": 3 }, "actual": null }
  ],
  "planned": { "status": 200, "body": { "encoding": "utf-8", "content": "{\"items\":[{\"id\":1},{\"id\":2,\"state\":\"paid\"},{\"id\":3}]}" } },
  "response": { "status": 200, "body": { "encoding": "utf-8", "content": "{\"items\":[{\"id\":2,\"state\":\"created\"},{\"id\":1}]}" } }
}
```

不提供 `align` 时，字节比较与原 JSON 语义比较行为完全不变；正文始终保留无损表示，不改写或排序正文。

JSON 语义（**不依赖媒体类型**）：

- **对象**只看自有字段，忽略键顺序与排版（空白）；**数组**按原下标比较，顺序有意义，多出或缺失的元素在其下标报告，不另报长度。
- **标量不转换类型**（`"1"` ≠ `1`）；数字按解析数值比较，`0` 与 `-0` 等价；**缺失与 `null` 不同**。
- **状态码始终精确比较**，不比较响应头；`same` / `different` / `failed` 与统计、退出码含义不变。

JSON 模式下 `different` 记录的报告在原有字段（`differences`、计划与实际响应的**无损表示**）之上增加：

- 两侧均可解析时附 `bodyDifferences`：全部未忽略的独立正文差异，每项给出 RFC 6901 `pointer`（根为 `""`）与 `planned` / `actual` 值，**节点缺失记为 `"missing"`**；节点缺失或类型不同只报该节点，不再深入子节点。
- 实际完整响应**非 UTF-8 或非 JSON** 时记正文差异并附 `bodyError` 说明原因，随后继续后续记录；通信失败仍为 `failed`。

```json
{
  "id": 2,
  "outcome": "different",
  "differences": { "status": false, "body": true },
  "bodyDifferences": [
    { "pointer": "/items/2", "planned": { "id": 3 }, "actual": "missing" },
    { "pointer": "/state", "planned": "paid", "actual": "created" }
  ],
  "planned": { "status": 200, "body": { "encoding": "utf-8", "content": "{\"state\":\"paid\",\"items\":[1,2,{\"id\":3}]}" } },
  "response": { "status": 200, "body": { "encoding": "utf-8", "content": "{\"items\":[1,2],\"state\":\"created\"}" } }
}
```

重放行为本身不变：原请求字节、逐条一次重放、每条总超时、不跟随重定向、目标状态不回滚；完整输出后空快照或全部相同退出 **0**，有差异或通信失败退出 **1**。

## 离线响应分支可达性诊断（reach）

不启动监听、不发送任何请求、不修改任何文件：读取一份本地场景配置（按与 `serve` 完全相同的严格校验），针对一个 **POST 接口的字面路径**，离线判断该接口声明了 `branches` 后**每一分支与兜底序列是否会被合格请求首先选中**，帮助发现永远不会被选中的分支。报告以 JSON 写往 **stdout**：

```sh
node app.ts reach --config ./scenes.json --path /api/order
```

### 诊断范围（超出即拒绝，退出 2）

- 目标必须是配置中存在的 **POST** 接口，且**声明了非空 `branches`**；GET 接口、未声明分支的接口、路径不存在都明确拒绝（stderr 列出可选的 POST 接口）。
- 该接口的根 `requestBody` 必须是 **`object`**（可附 `"nullable": true`，此时正文 `null` 也参与兜底判断）；根为标量/数组超出诊断范围。
- 每个 `when` 键是一条 **RFC 6901 指针**，可为**一段或多段**（如 `/buyer/state`、`/a/b/x`），单段条件继续支持。逐段走查时：
  - **每一段**都必须是“所在对象”**已声明的自有字段**（任一层指向未声明字段都拒绝）；
  - **中间节点必须是 `object`**——根指针 `""`、穿过数组（数组下标，如 `/tags/0`）、穿过标量字段都拒绝；
  - **终点必须是现有标量规则**（`string`/`number`/`integer`/`boolean`/`null` 及其 `enum`/`nullable` 形态）；对象/数组终点拒绝。
- 其余字段（未被任何条件引用的字段、对象/数组子树）仍完全按现有**递归规则**参与“合格正文”的构造与判定；`additionalProperties`、类型、枚举、必填/可选、可空与嵌套约束语义不变。
- 各层的**空字段名**（指针 `/buyer/`）、名为 **`__proto__`** 的字段、`~0`/`~1` 转义都按与正文校验、分支选择相同的原语义处理（普通自有字段）。

### 嵌套条件的精确语义

判定针对**完整正文接受集合**进行（不是抽样），并严格区分以下事实：

- **共享祖先的条件作用于同一个对象**：`/buyer/state` 与 `/buyer/note` 中的 `buyer` 是同一字段，叶字段不会被当成彼此独立的顶层维度。同一分支内多个深层条件也必须落在同一条祖先链与同一个祖先对象上。
- 一个对象字段相对其父对象有**三种须分开的状态**：**缺失**（仅可选时可能）、显式 **`null`**（仅可空时可能）、**存在且非 `null`**。可选祖先**缺失**、或可空祖先为 **`null`** 时，所有“穿过它”的叶条件都取不到值而**不匹配**。
- **后代必填只在父对象存在且非 `null` 时才生效**：祖先缺失时不提其后代必填；祖先为 `null` 时不深入子树。**叶值 `null`、祖先 `null` 与祖先缺失是三种不同正文**，类型、枚举与额外字段规则在各层全部生效。

典型例：`buyer` 可选且可空，内部 `state` 必填、枚举为 `a`、`b`，另有顶层必填布尔 `flag`；前两支分别匹配 `/buyer/state` 为 `a`、`b`，后支匹配 `/flag` 为 `true`。

- `buyer` **可选且可空**时，`{"flag":true}`（`buyer` 缺失）或 `{"flag":true,"buyer":null}` 都是合格正文且不命中前两支，**后支可达**；
- 把 `buyer` 改为**必填且不可空**后，任何 `flag:true` 的合格正文其 `/buyer/state` 必为 `a` 或 `b`，必先命中前两支之一，**后支被前两支共同遮挡**。

### 三种结论（按 `branches` 配置顺序逐支报告）

| `status` | 含义 |
| --- | --- |
| `reachable` | 存在通过正文检查的请求正文，且该正文**首先命中此支**；附完整请求样例 |
| `covered` | 存在满足此支全部条件的合格正文，但它们**全部被前序分支首先命中**；`coveredBy` 指出共同覆盖它的前序分支（不要求最小集合） |
| `contradictory` | 条件与正文规则矛盾，**不存在**满足条件的合格正文；`reasons` 用 RFC 6901 指针定位到具体条件并说明原因 |

遮挡按**前序分支命中区域的并集**精确判定，而不是只检查某一支是否包含此支，也不做抽样：例如必填 `state` 枚举为 `a`、`b`，`flag` 为布尔字段，前两支分别匹配 `a`、`b`，后一支仅匹配 `/flag == true`，则该支被前两支的并集共同遮挡（任一带 `flag:true` 的合格正文其 `state` 必为 `a` 或 `b`，必先命中前两支之一），`coveredBy` 同时列出这两支。

- 判定精确依据现有 **类型、`enum`、`nullable`、必填/可选与额外字段**语义，覆盖任意深度的对象嵌套：**祖先缺失、祖先 `null`、叶值缺失与叶值 `null` 分开**、`0` 与 `-0` 等价、**不做类型转换**；同一指针上要求两个不同常量的条件自相矛盾。
- **根可空时 JSON `null` 也参与兜底判断**：若没有任何对象正文能落到兜底但根接受 `null`（`null` 上字段指针取不到值、不命中任何分支），兜底仍判为可达，样例正文就是 `null`。同理，深层条件在其可选祖先缺失或可空祖先为 `null` 时不命中，可让兜底或后序分支可达。
- **兜底单独报告** `reachable` / `covered`：存在不命中任何分支的合格正文（含根 `null`）即可达；兜底不可达**仅作信息**，不改变退出码。

### 样例与报告

每个可达分支与可达兜底都给出一份**完整请求样例**（`method`、`path`、必要请求头 `Content-Type: application/json`、原始 JSON `body`），补全**必要的对象祖先与其中全部必填（兄弟）字段**；该样例必须**通过正文检查并实际选中所报分支或兜底**（见回归测试中对真实服务与请求记录的核对）。不可达结果不给样例，改为定位规则或条件并说明原因：

```json
{
  "configFile": "/abs/scenes.json",
  "method": "POST",
  "path": "/api/order",
  "branches": [
    {
      "id": "is-a",
      "status": "reachable",
      "example": {
        "method": "POST",
        "path": "/api/order",
        "headers": { "Content-Type": "application/json" },
        "body": "{\"state\":\"a\"}"
      }
    },
    {
      "id": "flag-only",
      "status": "covered",
      "coveredBy": ["is-a", "is-b"],
      "message": "存在满足本支全部条件的合格正文，但它们首先命中的都是前序分支；前序分支 [\"is-a\",\"is-b\"] 的命中区域并集已覆盖本支……"
    },
    {
      "id": "impossible",
      "status": "contradictory",
      "reasons": [
        { "pointer": "/state", "message": "条件值 \"c\" 不在该字段枚举 [\"a\",\"b\"] 之中……" }
      ]
    }
  ],
  "fallback": {
    "status": "reachable",
    "example": { "method": "POST", "path": "/api/order", "headers": { "Content-Type": "application/json" }, "body": "{\"state\":\"a\"}" }
  },
  "unreachableBranches": 2
}
```

退出码：分支全部可达 **0**；**存在不可达分支（covered 或 contradictory）1**；兜底不可达仅作信息、不影响退出码；参数、读取、解析、配置校验、接口选择或范围错误 **2**（stderr 指明文件与相关位置，stdout 为空）。整份场景配置按现有严格校验**全部通过后**才输出任何 JSON。

## 响应序列语义

- 请求**被完整接收后**才按当时配置匹配接口并立即预留序列下一项；同一接口按完整接收的先后顺序取项：第 1 次请求取第 1 项，第 2 次取第 2 项，不跳项、不提前复用。
- 序列耗尽后**持续复用末项**。
- 配置了响应分支（`branches`）的接口，**每个命中分支与兜底各有独立序列与计数**：请求完整接收并通过正文校验后按正文值选支（首支命中、否则兜底），只在**选中的那一条序列**上按完整接收顺序取项；命中不同分支或兜底的请求交错到达时各自推进、互不挤占。查询串差异（如 `/api/order?a=1` 与 `/api/order?b=2`）命中同一接口，共享这些计数；不同接口各自独立计数。
- 请求未完整接收即断开（如只发了半个 POST body）：**不推进序列**。
- 一旦已预留，客户端随后断开仍算消费；响应会在延迟结束后尝试发送（发送失败被忽略）。
- 未匹配的请求返回 `404`，不消费任何序列。
- 每个业务响应都带响应头 `X-Contractlab-Version: <版本号>`（404 等框架响应同样携带）。

## 管理入口（不消费业务序列）

| 入口 | 说明 |
| --- | --- |
| `GET /__contractlab/health` | 健康查询，返回 `{"status":"ok","version":N}` |
| `POST /__contractlab/reload` | 重新读取启动时指定的**同一文件** |
| `GET /__contractlab/requests` | 查询本次进程内的请求记录（一致快照，不推进序列） |
| `POST /__contractlab/requests/clear` | 清空当时全部请求记录（不取消响应、不改配置/版本/序列） |

管理范围为 `/__contractlab` 本身及 `/__contractlab/` 前缀：其中所有请求（含未知子路径、错误方法）都**不记录、不消费业务序列**。

`reload` 的返回：

- 成功：`{"ok":true,"version":N}` —— 新配置**全部有效**时才一次性原子替换全部接口（含规则、响应分支与全部响应序列）、重置兜底与各分支的**全部**计数、版本号 +1；
- 失败：`{"ok":false,"version":N,"error":"...原因..."}` —— 读文件、JSON 解析或校验失败时，配置、版本与各序列的消费位置**保持不变**，旧场景继续可用。

并发 reload 按 HTTP 请求的接收顺序依次处理；请求要么看到旧配置、要么看到新配置，不会看到混合状态。

版本切换的在途语义：请求预留响应时持有当时那一项的完整快照（状态码、响应头、正文、延迟、版本）。即使预留之后、延迟结束之前发生了成功 reload，该请求仍按**旧版本**响应（头中版本号也是旧的），且完成时不会推进新版本的序列；reload 成功后新进入的请求才使用新版本并从各自序列第 1 项开始。

## 本地请求记录

接口联调时用于查明请求**为何被拒绝、使用了哪版配置、计划与实际发送的是哪项响应**。记录只保存在本次服务进程内存中，不写文件，进程退出即消失。

- `GET /__contractlab/requests` 返回机器可读 JSON：`{"note":"…调用说明…","count":N,"records":[…]}`。返回的是调用时刻的**一致快照**，查询本身不记录、不推进任何序列。
- `POST /__contractlab/requests/clear` 清空**当时**全部记录（含待发送项），返回 `{"ok":true,"removed":N}`；不取消任何在途响应，不改变配置、版本或序列。清空前已完整接收的请求随后完成或失败都**不得重新出现**；清空后才完整接收的请求正常记录。

### 何时创建、何时不创建

对管理范围**之外**、**完整接收**且**未超过正文上限**（100 MiB）的每个请求记录一次，涵盖：场景响应、正文拒绝 **400**、未匹配 **404**。

- 请求未收完整即断开（如只发了半个 POST body）：**不创建记录、不消费序列**。
- 正文超过上限：回复 **413**，**不创建记录、不消费序列**。
- 编号按“完整接收”顺序分配进程内唯一递增整数，与接口的序列消费位置**互不相关**；清空与 reload（成功或失败）后编号都**不复用、不重置**，记录也都保留。

### 记录的内容

每条记录可还原请求、接收时的判定与计划响应：

| 字段 | 含义 |
| --- | --- |
| `id` | 进程内单调递增编号（清空/重载不复用） |
| `receivedAt` | 完整接收时刻（ISO 8601，UTC） |
| `request.method` | 请求方法 |
| `request.target` | **含查询串**的原始请求目标（如 `/api/order?a=1&b=%E4%B8%AD`）；查询串仍不参与匹配 |
| `request.path` | 不含查询串的路径（匹配所用） |
| `request.rawHeaders` | 收到的请求头，按在线顺序成对保留（名称大小写、重复头均不折叠） |
| `request.bodyBytes` | 请求正文原始字节数 |
| `request.body` | 正文原始字节的无损表示（见下），**不是**解析后的 JSON |
| `configVersion` | 完整接收时选用的配置版本；在途请求不随之后的 reload 改变 |
| `matched` / `endpoint` | 是否命中接口；命中时为 `方法 路径`，未命中也记录请求的目标键 |
| `bodyValidationPassed` | `true` 通过 / `false` 拒绝（400）/ `null` 未校验（GET 或未声明规则） |
| `bodyRejection` | 400 时**实际返回**的差异报告（`error/stage/message/problems`）；其余为 `null` |
| `branchSelection` | 场景请求的分支选择：`null` 未选择（400/404）；`{"kind":"fallback"}` 使用兜底 `responses`（无分支接口的场景请求也是它）；`{"kind":"branch","id":"<支 id>"}` 命中指定分支。verify/compare 不使用此字段 |
| `sequencePosition` | 场景请求在**选中序列**中的消费位置（0 起）；末项复用记同一位置；**400 与 404 为 `null`** |
| `sequenceLength` | **选中序列**（命中分支或兜底）的长度；400/404 为 `null` |
| `plannedResponse` | 接收完成时定下的计划响应（见下） |
| `delivery` | 写出状态：`pending` / `sent` / `interrupted`（见下） |

正文原始字节 `request.body`：

- `{"encoding":"utf-8","content":"…"}`：正文是合法 UTF-8，`content` 为原文（空正文为 `""`）；开头 BOM 与空白原样保留，将 `content` 重新按 UTF-8 编码即得原始字节；
- `{"encoding":"base64","content":"…"}`：正文不是合法 UTF-8，`content` 为原始字节的 base64，可无损还原。字段同时说明所用编码，记录从不以解析后的 JSON 代替原始字节；两种编码还原出的字节数都与 `bodyBytes` 一致。

`plannedResponse` 是接收完成那一刻定下、且与真正写上线的字节共用同一份数据的不可变快照（reload 不影响在途请求）：

- `kind`：`scene`（场景响应）或 `framework`（400/404 等框架响应）；
- `status`：状态码；
- `headers`：**应用层响应头**——配置头/框架头加上服务器填写的准确 `X-Contractlab-Version`（以及默认 `Content-Type`），不含 `Content-Length`、`Connection`、`Date`、`Transfer-Encoding` 等传输层自动头；
- `body`：配置/框架给出的响应正文文本（400 即实际差异报告 JSON）。

### 写出状态 `delivery`

- `pending`：已完整接收、计划响应待发送。延迟期间查询即可看到请求及其计划响应。
- `sent`：服务器已**完成写出**响应头与正文（`finish`）。仅表示服务器侧写出完成，**不表示客户端已收到**；此后连接正常关闭不会把状态改回中断。
- `interrupted`：写出完成前连接断开，或写入/发送失败。已预留（消费成立）后断开仍标中断，但**消费保留**：下一次请求取得序列的下一项，末项复用规则不变。400/404 这类无延迟响应在写出前断开同样记为中断。

### 示例

```json
{
  "id": 3,
  "receivedAt": "2026-10-06T08:30:00.123Z",
  "request": {
    "method": "POST",
    "target": "/api/order?source=curl",
    "path": "/api/order",
    "rawHeaders": ["Host", "127.0.0.1:8080", "Content-Type", "application/json", "Content-Length", "20"],
    "bodyBytes": 20,
    "body": { "encoding": "utf-8", "content": "{\"id\":\"x\",\"extra\":1}" }
  },
  "configVersion": 2,
  "matched": true,
  "endpoint": "POST /api/order",
  "bodyValidationPassed": false,
  "bodyRejection": {
    "error": "invalid_request_body",
    "stage": "structure",
    "message": "请求正文与接口约定存在 2 处差异",
    "problems": [
      { "pointer": "/extra", "expected": "未声明的字段（不允许）", "actual": "number" },
      { "pointer": "/id", "expected": "integer", "actual": "string" }
    ]
  },
  "sequencePosition": null,
  "sequenceLength": null,
  "plannedResponse": {
    "kind": "framework",
    "status": 400,
    "headers": { "X-Contractlab-Version": "2", "Content-Type": "application/json; charset=utf-8" },
    "body": "{\"error\":\"invalid_request_body\",…}\n"
  },
  "delivery": "sent"
}
```

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

## 本机观察：响应分支

```sh
# 设接口 /api/order 有兜底 "default"，分支 paid（/state == "paid"，序列 paid-1、paid-2），
# 分支 paid-big（/state == "paid" 且 /amount == 100，排在 paid 之后）
# 1) 命中 paid：取 paid-1
curl -sS -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"state":"paid"}'
# 2) 两支条件都满足时取排在前面的 paid：继续取 paid-2（不会取 paid-big）
curl -sS -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"state":"paid","amount":100}'
# 3) 无分支命中：取兜底序列
curl -sS -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"state":"new"}'
# 4) 缺失字段不同于 null，且指针取不到值不命中：/amount 缺失，仍只按 /state 判定
# 5) 查看记录：branchSelection 区分 branch/fallback，sequencePosition/Length 对应选中序列
curl -sS http://127.0.0.1:8080/__contractlab/requests
```

## 本机观察：请求记录

```sh
# 1) 场景请求（含带查询串）、一次 400 拒绝、一次 404（查询串保留在 target 中）
curl -sS http://127.0.0.1:8080/api/order
curl -sS -X POST http://127.0.0.1:8080/api/order \
  -H 'Content-Type: application/json' -d '{"id":"x"}'
curl -sS http://127.0.0.1:8080/api/order?ignored=yes -o /dev/null
curl -sS http://127.0.0.1:8080/no/such -o /dev/null

# 2) 查看记录：一致快照 JSON（查询不消费、不记录）
curl -sS http://127.0.0.1:8080/__contractlab/requests

# 3) 延迟响应在发出前即为 pending：先发起延迟请求，再立即查询
curl -sS http://127.0.0.1:8080/api/order -o /tmp/resp.out &
curl -sS http://127.0.0.1:8080/__contractlab/requests   # delivery 为 pending

# 4) reload（成功或失败）后记录仍在；在途请求钉住旧版本，新请求用新版本
curl -sS -X POST http://127.0.0.1:8080/__contractlab/reload
curl -sS http://127.0.0.1:8080/__contractlab/requests

# 5) 清空：移除当时全部记录（含 pending），不取消响应、不改配置/版本/序列
curl -sS -X POST http://127.0.0.1:8080/__contractlab/requests/clear
```

## 启动失败与进程信号

- 配置无效：不创建监听，进程以状态码 1 退出，stderr 给出可定位的原因（含 JSON 指针式位置，如 `endpoints[0].responses[1].status ...`）。
- 端口被占用：同样启动失败、不留下监听。
- 收到 `SIGINT`（Ctrl-C）或 `SIGTERM`：关闭监听、取消所有尚未发出的延迟响应、断开连接后正常退出（状态码 0）。

## 自动化回归测试

离线兼容报告（compare）、OpenAPI 导入（import）、请求记录、离线批量请求校验（verify）、本机请求重放（replay）与离线分支可达性诊断（reach）均配有自动化回归测试，使用 Node.js 24 内置测试运行器，无外部依赖：

```sh
npm test        # 等价于 node --test "test/*.test.ts"
```

- `test/rule-matrix.test.ts` —— 规则包含关系矩阵：对一组确定性的小型递归规则对（交叉覆盖全部标量类型、integer/number 双向变化、必填/可选字段、additionalProperties 两种策略、对象与数组嵌套），用**独立**参考实现（`test/helpers.ts` 中的 `accepts()`，仅依据本文档语义编写，不调用产品的校验、比较或反例构造函数）在有限代表值域上穷举被旧规则接受的值，据此判断旧→新包含关系，再核对真实 compare 命令的逐接口结论、整体结论与退出码。代表值域区分整数与非整数、字段缺失与 null、空与非空数组、已声明字段与未声明额外字段，足以见证本矩阵每对规则的接受差异；这只是针对所测规则对的充分见证域，**不声称有限检查能证明任意递归规则的包含关系**。
- `test/scenarios.test.ts` —— 典型变更场景（双方允许额外字段但新版新增可选字段限制取值、必填字段嵌套收紧、删除带正文规则的 POST 接口、启用/移除正文规则、新增接口、仅修改响应，以及空字段名、`__proto__`、含斜杠/波浪号的字段名）：断言结论与原因的 JSON Pointer 转义和定位（不固定自然语言措辞、原因排序或反例正文取值），并把报告给出的完整请求反例**原样重放**到分别加载旧、新配置的真实本机服务——旧服务必须返回场景成功响应，新服务必须返回与变更相符的 400（正文校验）或 404（接口不存在）。
- `test/request-log.test.ts` —— 进程内请求记录：真实本机服务 + 真实 HTTP/原始套接字请求，覆盖记录字段（方法、含查询串 target、保序保大小写含重复头的 rawHeaders、UTF-8/非法 UTF-8 的 base64 无损正文、接收时版本、匹配与校验结论、400 实际差异报告、消费位置与末项复用、场景/框架计划响应含准确版本头），写出生命周期（延迟期间 pending、完成 sent 且不随后续关连接回退、写出前断开 interrupted 且消费保留），清空（移除含 pending 的全部记录、不取消响应、不改配置/版本/序列、旧记录不再出现、编号不复用），reload（成功/失败均保留记录、在途请求钉住旧版本与旧计划、新请求用新版本、编号不重置），管理范围不记录、查询不推进序列，以及未收完整断开与超出上限（413）均不创建记录、不消费序列。
- `test/compare-errors.test.ts` —— 任一输入文件读取、JSON 解析或递归配置校验失败时退出码 2、stderr 可定位、stdout 无部分报告。
- `test/import.test.ts` —— OpenAPI 导入：基本转换（替换/移除规则、保留接口顺序与 responses、additionalProperties 缺省显式输出、特殊字段名保留）、本文件内 $ref（共享引用、指针转义、缺失目标、外部引用、循环链定位）、纯对象 allOf 交集（同名字段递归相交、number∩integer、必填并集、额外字段限制、空交集与无法表达的拒绝）、**嵌套 allOf 整体交集**（三分支原例的 flat 全排列 / 嵌套分组 / $ref 等 13 种等价写法接受集合一致；删除第三支以无法表达拒绝；必填冲突定位到嵌套叶分支；被禁止字段中的非法值/未知关键字仍拒绝；数组元素版规则一致），以及把成功输出写入临时文件用**真实本机 serve**核对允许（省略/空 box、数组空对象元素）与拒绝（box 内任意字段、数组非空字段元素）的正文、用 compare 验证可用性；此外覆盖操作选择错误（缺少操作、GET 声明正文、required/content/schema 不符）、未支持关键字与非法值，以及未选中操作与不可达定义不参与转换；失败一律退出 2、stderr 可定位（文件 + 操作/定义位置 + 冲突字段/元素）、stdout 为空。
- `test/verify.test.ts` —— 离线批量请求校验：由真实本机服务产生 `GET /__contractlab/requests` 快照（真实 HTTP/原始套接字请求，含重复媒体类型头、非法 UTF-8、BOM、无正文规则接口、404、非 GET/POST 方法），用 verify 对照场景逐条重判，并把**相同原始请求字节回放**到加载目标配置的另一台真实服务核对在线/离线接受结论一致（场景 500 不算请求拒绝）；覆盖规则变化（同一快照对照修改规则/删除接口的新场景结论翻转）、记录无损性（BOM 保留、bodyBytes 一致、utf-8 文本含孤立代理项即使替换后长度吻合也拒绝）、空快照与全部接受退出 0、存在拒绝退出 1，以及全部输入失败形态（缺字段、类型错误、计数不符、重复编号、头数组不成对、path 与 target 不符、非法编码、长度不符、场景非法、文件缺失）退出 2 且 stdout 无部分报告。
- `test/replay.test.ts` —— 本机请求重放与响应差异报告：真实快照重放到相同/变更配置的真实本机服务（全部相同退出 0、状态/正文差异分别指出退出 1、400/404 按内容比较、编号按输入顺序保留、完整响应保留状态与无损正文、BOM 与非法 UTF-8 字节无损到达目标）；重放请求构造（业务头保序保大小写含重复项、剥离 Host/Expect/逐跳/分帧头与 Connection 指名头、按目标与实际字节数重建 Host/Content-Length、target 原样含查询串与百分号编码、逐条串行不并发）；通信失败（连接拒绝后继续后续记录、总超时覆盖完整收发且持续来数据不延长、响应中途断开不算完整）退出 1；不跟随重定向（302 按内容比较）；输入校验（非 GET/POST、管理入口路径、非法 target、缺失/非法计划响应、孤立代理项、不可发送的头名称/值、非法端口/超时参数）退出 2、stderr 定位、stdout 为空且不发任何请求；空快照退出 0。
- `test/replay-json.test.ts` —— replay 的可选 JSON 语义响应比较（`--strategy`）：混合接口（策略选中的接口忽略排版/键序/动态字段，未选中接口仍按字节比较）、忽略数组项不删除不移位、特殊字段名（根指针、空字段名、`__proto__`、`~0`/`~1` 转义）、重复与父子重叠忽略项不改变结果、缺失≠null、0 与 -0 等价、数组多出/缺失元素按下标报告、祖先类型不同仍报告；实际响应非 UTF-8/非 JSON 记正文差异（附原因与无损正文）并继续后续记录；状态码始终精确比较；策略非法（重复接口、未知字段、非法指针）、所选记录计划正文非 JSON（含空正文、双 BOM）等输入失败退出 2、stderr 定位文件与字段、stdout 为空且零请求；不提供策略时行为与字节比较完全不变。
- `test/replay-align.test.ts` —— replay 的数组业务键对齐（策略 `align`）：真实本机服务覆盖重排后字段变化的双方原正文位置、纯重排不误报、增删键按整个元素报告（双方独立存在性标记，缺失≠null/`"missing"`）、数组本身缺失按原节点差异、忽略与对齐交互（计划原下标定位、缺失元素、新键不被遮蔽、忽略整数组、忽略不豁免键校验）、混合键类型（`1`≠`"1"`、`0` 与 `-0` 等价、布尔键）、特殊字段（空键名、`__proto__` 键名、`~0`/`~1` 位置转义、根指针对齐）；非法配置（重复/嵌套位置、非法指针与键）退出 2；计划末条对齐非法时零请求退出 2 并定位记录与正文位置；实际响应对齐非法记 different（`alignmentErrors` 位置+原因、该位置回退下标比较）并继续后续记录。
- `test/nullable.test.ts` —— 请求正文可空约定（`nullable`）：真实本机服务覆盖根可空与嵌套可空（字段、数组元素）、必填可空字段仍不得缺失、`null` 不产生子节点差异、非 `null` 仍检查全部原约束、空正文不等于 `null`、可空不放宽媒体类型、拒绝沿用差异报告且不消费序列、非法可空规则整份拒绝、reload 成功原子替换/失败保留旧状态；verify 与在线对相同请求字节结论一致；compare 的可空包含关系（加宽兼容、移除可空不兼容、可空不掩盖非 `null` 变化）与根/嵌套 `null` 反例（含必要父对象与必填字段）的真实服务重放；import 的 `nullable: true` 转换（根/字段/`items`/本文件内 `$ref`）、非布尔与 allOf 组合节点拒绝、可空对象交集仅剩 `null` 时输出 `type: null`（任一分支不可空则空交集拒绝）及导入结果的真实 serve 核对。
- `test/enum.test.ts` —— 请求正文标量枚举（`enum`）：真实本机服务覆盖根/字段/数组元素枚举的接受与拒绝、数字按数值相等（`0` 与 `-0` 等价、不做类型转换）、可空不越过枚举（`null` 须列入候选）、必填枚举字段不得缺失、类型错误不重复报枚举错误、枚举拒绝沿用 structure 差异报告（RFC 6901 指针、候选值、实际值）且不消费序列、媒体类型不放宽；非法枚举（object/array 节点、空数组、候选类型不符、`null` 项无可空）整份拒绝并定位；reload 成功替换/失败保留旧状态；verify 与在线结论一致；compare 的枚举包含关系（枚举增删、枚举与非枚举交叉——`number` 枚举全为整数时兼容非枚举 `integer`、可空与枚举交集）与不兼容反例的真实服务重放；import 的标量 `enum` 转换（根/字段/`items`/本文件内 `$ref`）、非法枚举拒绝、纯对象 allOf 的枚举交集（同名字段候选交集、`number`∩`integer` 带枚举、空交集仅剩 `null` 输出 `type: null`、可选字段空交集的闭合省略与开放拒绝、数组元素空交集无法表达、分支换序结论一致、可达非法枚举不因字段被禁止而忽略）及导入结果的真实 serve 核对。
- `test/branches.test.ts` —— 按请求正文值选择响应分支（`branches`）：真实本机服务覆盖首支命中与**重叠条件取第一支**、根指针/对象自有字段（空字段名、`__proto__`）/数组下标/`~0`/`~1` 转义、取值不存在与无法遍历不命中、缺失不同于显式 `null`、不做类型转换、`0` 与 `-0` 相等；**各分支与兜底独立计数、交错消费互不挤占、耗尽复用末项、查询串共享计数**；400/404/413/未收完整不消费、预留后断开仍消费选中项；请求记录区分 `branch`/`fallback`/未选择且 `sequencePosition`/`sequenceLength` 对应选中序列；**reload 成功原子替换规则/分支/响应并重置全部计数、失败保留旧状态，重载期间旧延迟响应保留原选中项与版本、不推进新序列**；非法分支配置（GET/无正文规则、空数组、重复/空 `id`、空 `when`、非法指针与转义、非法条件值、非法响应、未知字段）整份拒绝并定位；compare/verify 结论不随分支变化；import 保留分支/顺序/响应、仅替换正文规则，移除规则导致分支前提失效时退出 2、stderr 定位、stdout 为空；无分支场景与 replay 行为保持不变。
- `test/reach.test.ts` —— 离线响应分支可达性诊断（reach）：**共同遮挡**（必填 `state` 枚举 `a`/`b`、`flag` 布尔，两支匹配 `a`/`b` 后一支仅匹配 `flag==true` 被两支并集共同遮挡，`coveredBy` 同时列出两支；单支包含式遮挡）、**枚举剩余值**（枚举的未被前序匹配的候选让兜底可达）、**可选字段缺失**（缺失与显式 `null` 分开，样例补全全部必填字段）、**可空**（根可空时 JSON `null` 让兜底可达；可空字段上显式 `null` 条件可达、不可空字段上 `null` 条件矛盾）、**特殊字段名**（空字段名 `/`、`__proto__`、含斜杠/波浪号字段的 `~0`/`~1` 指针）、`0` 与 `-0` 等价（两支分别钉 `0`/`-0` 视为同一遮挡）、类型不符与枚举越界及同指针互异常量判 `contradictory`；把报告中**每个可达分支与可达兜底的完整请求样例原样发送到真实本机 serve**，经 `GET /__contractlab/requests` 请求记录核对其**实际选中的是所报分支或兜底**（正文检查通过、branchSelection 一致），不可达结果不给样例；范围拒绝（GET 路径、无分支接口、标量/数组根规则、根指针与多段指针、未声明字段、object/array 字段）与参数/读取/解析/配置错误退出 2、stderr 定位、stdout 为空；全部可达退出 0，存在 covered/contradictory 退出 1，兜底不可达不改变退出码；同时核对报告字段顺序与现有命令、场景格式及服务行为不变。

测试使用独立临时文件与端口 0（以实际监听地址继续请求），不依赖固定端口、外网或固定等待时间；子进程卡住会在有限时间内使测试失败，成功与失败均关闭子进程并清理临时文件。
