# 第三阶段：会话认证与加密 v0.6.0

## 1. 做了什么 / 没做什么

| 已实现 | 明确没做 |
| --- | --- |
| TCP 会话：X25519 + PSK 双向认证握手 + AES-256-GCM 记录加密 | 身份体系、账号/证书：信任仍完全建立在「双方知道同一个口令」上 |
| UDP 会话：数据报握手带重传 + 逐包 AES-256-GCM + 滑动重放窗口 | 抗量子、密钥托管、轮换：未涉及 |
| 前向保密：每次会话临时 X25519 密钥，密钥不落盘 | 端点安全：终端上游戏数据在内存里始终是明文 |
| 防篡改 / 防重放 / 防冒充 / 版本与协议不匹配的明确拒绝 | 抗 DoS：仍可被大量垃圾数据报消耗少量 CPU |
| 弱口令告警、明文模式明确标注、界面展示当前加密算法 | 屏蔽流量分析：包长/时序仍可见 |

## 2. 新增文件

| 文件 | 作用 |
| --- | --- |
| `network/crypto.cjs` | 只用 `node:crypto` 原语：scrypt PSK、X25519、HKDF-SHA256、HMAC 认证标签、AES-256-GCM 封装/解封、重放窗口 |
| `network/secure-stream.cjs` | TCP 安全通道：行式握手、加密帧变换流 `EncryptStream` / `DecryptStream`、失败原因文案 |
| `network/secure-datagram.cjs` | UDP 安全通道状态机 `SecureDatagramHost` / `SecureDatagramClient`，不含 I/O，便于测试 |
| `test/crypto.test.cjs`，7 例 | 密钥派生确定性、ECDH 一致性、握手记录篡改、AEAD 篡改/重放/换密钥、重放窗口 |
| `test/secure-stream.test.cjs`，13 例 | 双向认证、口令不一致、握手篡改、链路无明文、密文篡改、同会话/跨会话重放、伪造 AUTH、旧协议拒绝、超时、512KiB、分片 |
| `test/secure-datagram.test.cjs`，12 例 | 数据报握手、口令不一致、伪造标签、加密往返、乱序容错、重放、篡改、未握手数据、老化、跨会话重放、重传 |

## 3. 协议

### 3.1 TCP：1.5 RTT，明文只出现在握手阶段

```
C -> S : SHL2 <clientNonce(16B)> <clientPub(32B)>
S -> C : SHL2-OK-HELLO <hostNonce(16B)> <hostPub(32B)> <serverTag(32B)>
C -> S : SHL2-AUTH <clientTag(32B)>
S -> C : SHL2-OK            房主确认；失败时 SHL2-DENY <中文原因>
之后    : [4B 长度][8B 计数器][AES-256-GCM 密文][16B 标签]  …… 游戏字节流原样还原
```

- `serverTag = HMAC(authKey, transcript ‖ "tag/server")`，`clientTag = HMAC(authKey, transcript ‖ serverTag ‖ "tag/client")`。
- 加入者先验房主标签，立刻发现口令不一致；房主再验加入者标签，拒绝伪造者。
- `transcript = "SHL2" ‖ clientNonce ‖ clientPub ‖ hostNonce ‖ hostPub`。任何一位被改都会导致校验失败。
- 数据密钥 `= HKDF-SHA256(ikm = ECDH ‖ PSK, salt = "SHL2" ‖ nonces, info = "…/c2s" | "…/s2c")`。两个方向不同密钥。缺 ECDH 或缺 PSK 都推不出密钥，前向保密与口令认证同时成立。
- 记录号严格递增。重放、乱序、缺号一律断开。TCP 有序，缺号意味着有人在动流量。
- **房主先连本地游戏端口、再 accept**。连不上时用明文 `SHL2-DENY` 把真正原因告诉加入者，例如「目标拒绝连接」。

### 3.2 UDP：数据报握手，加入者主动重传

```
C -> S : HELLO     [1B][16B nonce][32B pub]          每 250ms 重传，最多 12 次
S -> C : HELLO_OK  [1B][16B nonce][32B pub][32B serverTag]
C -> S : AUTH      [1B][32B clientTag]
S -> C : READY     [1B]          口令不对或房间已满时回 DENY [1B][中文原因]
之后    : DATA      [1B][8B 计数器][密文][16B 标签]   每个数据报独立认证
```

- 密钥在 `HELLO_OK` 后即已确定，因此 **DATA 早于 READY 到达也能解密**。UDP 不保证顺序，已专门测试。
- 乱序允许，重放拒绝：滑动窗口 1024，超窗或重复序号直接丢弃，不影响其他数据报。
- 房间上限在认证阶段判断。超限加入者收到的是明确的「房间已满」，不是先连上再被丢包。

## 4. 性能与 DoS 取舍

- `scrypt`，N=2¹⁴, r=8, p=1，约 16 MiB / ~50ms，**每个中继只执行一次**，把口令硬化成 PSK。之后的每个连接/数据报只用 X25519 + HKDF + AES-GCM，微秒级。
- 早期实现按「每个连接」跑 scrypt，既增加握手延迟，也给了一个 50ms×N 的 CPU 放大攻击面。
- 剩余 DoS 面：每个 TCP 连接需要一次 X25519，约 0.1ms，每个 UDP HELLO 同理。已用「最大连接数/最大会话数」限制并发。

## 5. 测试记录：本机 Windows + Node 24.21.0

```powershell
cd source
npm test        # 87 个用例，8 个测试文件
```

结果：**87 passed / 0 failed**

| 组 | 用例数 |
| --- | --- |
| `test/crypto.test.cjs` | 7 |
| `test/secure-stream.test.cjs` | 13 |
| `test/secure-datagram.test.cjs` | 12 |
| `test/tcp-relay.test.cjs` | 10 |
| `test/udp-relay.test.cjs` | 10 |
| `test/session.test.cjs` | 15 |
| `test/main-ipc.test.cjs` | 12 |
| `test/ui-logic.test.cjs` | 8 |

关键验证方式，不靠断言自说自话：

1. **链路无明文**：在真实 socket 上挂只读监听，抓下握手之后的全部字节，断言其中**不包含**已知的明文标记。用例见 `test/secure-stream.test.cjs` 的「加密通道：链路上抓到的字节里不含明文」。
2. **跨会话重放**：把 A 会话的真实密文塞给 B 会话，必须解不开。TCP/UDP 各一例。
3. **伪造认证**：手工构造「知道口令但发错标签」的客户端，房主必须拒绝并回 DENY。
4. **旧版本混用**：0.5.0 的明文 `SHL1` 握手会被明确拒绝并提示升级，而不是静默错乱。
5. **真实 Electron 全链路**：`npm run smoke:restricted` 结果 `"ok": true`，其中的房主会话与加入者中继都走加密握手。

## 6. 诚实边界

1. **口令就是全部信任**：谁拿到口令谁就是合法对端。邀请码里包含口令，**请通过你信任的渠道发送**：面对面、语音、私聊，不要贴在公开群里。口令泄露等于会话泄露。
2. **弱口令仍可被离线爆破**：scrypt 只提高成本，不能救 4 位数字口令。界面已对短于 8 字符的口令告警。
3. **端点被攻破就没了**：本方案保护的是「链路」，终端内存里的游戏数据、被注入的进程不在防护范围内。
4. **不看流量分析**：密文长度与时间间隔仍可被观察。
5. **跨设备/跨 NAT/防火墙仍未实测**：本环境只有一台机器。加密不改变 NAT 行为，跨公网仍需端口映射或阶段 4 的 Steam 中继。
6. **阶段 4/5**：Steam P2P 适配器与游戏适配器系统仍未实现。Steam 相关依赖不能随包分发。

## 7. 双机加密联调清单

1. 两台机器各自 `npm start`，都用 v0.6.0。版本不一致会明确报「对方版本过旧」。
2. 房主：会话 → 房主 → 端口规则 → 点「随机生成」口令 → 启动桥接 → 复制邀请信息，含口令。
3. 加入者：粘贴邀请码 → 解析 → 启动桥接。状态面板的 **Security** 行应显示 `已加密 · AES-256-GCM + X25519`。
4. 通道列表里对应通道的 `sessionId` 两端应一致，可用于确认「确实是同一条加密会话」。
5. 排错：
   - 界面显示「明文 · 未设置口令」→ 房主那边口令被清空了，重新生成并重发邀请码。
   - 加入者日志「口令不匹配：对端无法通过认证」→ 两端口令不一致。
   - UDP 通道一直 `包 ↑0/↓0` → 游戏没连本地入口端口，或游戏用的是 TCP。
