/**
 * CLI 引导入口（cli.tsx）
 *
 * 【在系统中的位置】
 * 本文件是 Claude Code 命令行工具的最顶层入口，也是进程启动后第一个被执行的模块。
 * 在整个调用链中位于最外层：cli.tsx → main.tsx → 各子系统。
 *
 * 【主要职责】
 * 1. 顶层副作用：在模块求值阶段（import 时）立即执行若干进程级环境变量设置，
 *    确保它们在任何动态导入发生之前就已生效。
 * 2. 快速路径分发：`main()` 在加载完整 CLI 之前，先扫描 `process.argv`，
 *    将常用子命令或特殊标志路由到专用的轻量处理器，以最小化模块加载开销。
 * 3. 完整 CLI 回退：对所有未被快速路径处理的参数，回退到加载 `../main.js`
 *    并执行完整的 CLI 流程。
 *
 * 【快速路径清单】
 * --version / -v / -V  → 零模块加载，直接打印版本号
 * --dump-system-prompt → 渲染并输出系统提示词（仅内部构建）
 * --claude-in-chrome-mcp → 启动 Chrome MCP 服务器
 * --chrome-native-host → 启动 Chrome 原生消息主机
 * --computer-use-mcp → 启动计算机使用 MCP 服务器（CHICAGO_MCP 特性门控）
 * --daemon-worker → 以后台 Worker 模式运行（DAEMON 特性门控）
 * remote-control / rc / remote / sync / bridge → 远程控制桥接模式（BRIDGE_MODE）
 * daemon → 守护进程主进程（DAEMON）
 * ps / logs / attach / kill / --bg / --background → 后台会话管理（BG_SESSIONS）
 * new / list / reply → 模板任务命令（TEMPLATES）
 * environment-runner → 无头 BYOC 运行器（BYOC_ENVIRONMENT_RUNNER）
 * self-hosted-runner → 自托管运行器（SELF_HOSTED_RUNNER）
 * --worktree --tmux → 进入 tmux worktree 模式
 */
import { feature } from 'bun:bundle';

// 修复 corepack 自动锁定问题：corepack 会在 package.json 中添加 yarnpkg 字段
// 通过将该环境变量设为 '0' 来禁用此行为
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0';

// 在 CCR（云容器远程）环境中，容器内存为 16GB，需要为子进程提升 Node.js 堆上限
// 通过追加 NODE_OPTIONS 环境变量来设置 --max-old-space-size=8192（8GB）
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.CLAUDE_CODE_REMOTE === 'true') {
  // 保留已有的 NODE_OPTIONS，在后面追加新的堆大小配置
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || '';
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing ? `${existing} --max-old-space-size=8192` : '--max-old-space-size=8192';
}

// 消融实验基线（Harness-science L0）：
// BashTool/AgentTool/PowerShellTool 在模块导入时就把 DISABLE_BACKGROUND_TASKS 等
// 环境变量固化为模块级常量，因此必须在 init() 运行之前（即此处）完成设置。
// feature('ABLATION_BASELINE') 门控确保此代码块在外部发布构建中被死代码消除（DCE）。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.CLAUDE_CODE_ABLATION_BASELINE) {
  // 将所有消融相关的环境变量默认设为 '1'（若未被外部设置）
  for (const k of ['CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_THINKING', 'DISABLE_INTERLEAVED_THINKING', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    // ??= 保证仅在未设置时赋值，不覆盖用户手动配置的值
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1';
  }
}

/**
 * CLI 引导主函数
 *
 * 【总体流程】
 * 1. 解析 process.argv（跳过 node/bun 二进制和脚本路径）
 * 2. 按优先级依次检查快速路径标志，命中即分发处理后返回，不再继续
 * 3. 所有快速路径均未命中时，加载完整 CLI（../main.js）并执行
 *
 * 【性能设计】
 * - 所有模块导入均为动态（await import(...)），避免在快速路径（如 --version）
 *   中白白加载不需要的模块
 * - --version 路径：零动态导入，MACRO.VERSION 在构建时内联
 * - 其他路径：仅在命中时才加载对应模块
 */
async function main(): Promise<void> {
  // 获取用户实际传入的参数列表（去掉 node/bun 二进制和入口文件两项）
  const args = process.argv.slice(2);

  // 快速路径：--version / -v / -V
  // 这是最高频的只读操作，不需要任何模块加载
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在 Bun 构建时被内联为字符串字面量
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (Claude Code)`);
    return;
  }

  // 所有非 --version 路径都需要启动性能计时器
  const {
    profileCheckpoint
  } = await import('../utils/startupProfiler.js');
  // 记录 CLI 入口时间点，用于后续启动性能分析
  profileCheckpoint('cli_entry');

  // 快速路径：--dump-system-prompt
  // 渲染并输出当前提交下的系统提示词，供 prompt 敏感度评估使用
  // 通过 feature('DUMP_SYSTEM_PROMPT') 在外部构建中死代码消除
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    // 启用配置系统，以便读取 --model 等设置
    enableConfigs();
    const {
      getMainLoopModel
    } = await import('../utils/model/model.js');
    // 支持通过 --model <name> 参数指定目标模型；否则使用默认主循环模型
    const modelIdx = args.indexOf('--model');
    const model = modelIdx !== -1 && args[modelIdx + 1] || getMainLoopModel();
    const {
      getSystemPrompt
    } = await import('../constants/prompts.js');
    // 获取渲染后的系统提示词（数组，每项为一段）
    const prompt = await getSystemPrompt([], model);
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(prompt.join('\n'));
    return;
  }

  // 快速路径：--claude-in-chrome-mcp
  // 启动通过 Chrome 扩展接入 Claude 的 MCP 服务器
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_claude_in_chrome_mcp_path');
    const {
      runClaudeInChromeMcpServer
    } = await import('../utils/claudeInChrome/mcpServer.js');
    await runClaudeInChromeMcpServer();
    return;
  } else if (process.argv[2] === '--chrome-native-host') {
    // 快速路径：--chrome-native-host
    // 启动 Chrome 原生消息主机，使浏览器扩展可以与本地进程通信
    profileCheckpoint('cli_chrome_native_host_path');
    const {
      runChromeNativeHost
    } = await import('../utils/claudeInChrome/chromeNativeHost.js');
    await runChromeNativeHost();
    return;
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    // 快速路径：--computer-use-mcp（CHICAGO_MCP 特性门控）
    // 启动计算机使用（屏幕截图、点击等）MCP 服务器
    profileCheckpoint('cli_computer_use_mcp_path');
    const {
      runComputerUseMcpServer
    } = await import('../utils/computerUse/mcpServer.js');
    await runComputerUseMcpServer();
    return;
  }

  // 快速路径：--daemon-worker=<kind>（内部 Worker 进程）
  // 由守护进程主进程（supervisor）spawn 出来，每个 worker 类型一个进程
  // 必须放在 daemon 子命令检查之前，因为 worker 进程对性能更敏感
  // 注意：此处不调用 enableConfigs() 或 initSinks()，worker 自行按需初始化
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const {
      runDaemonWorker
    } = await import('../daemon/workerRegistry.js');
    // args[1] 为 worker 类型标识符（如 "assistant"）
    await runDaemonWorker(args[1]);
    return;
  }

  // 快速路径：claude remote-control / rc / remote / sync / bridge
  // 将本地机器作为远程控制桥接环境运行
  // feature() 必须内联（不能提取到函数），以确保构建时死代码消除正确工作
  if (feature('BRIDGE_MODE') && (args[0] === 'remote-control' || args[0] === 'rc' || args[0] === 'remote' || args[0] === 'sync' || args[0] === 'bridge')) {
    profileCheckpoint('cli_bridge_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      getBridgeDisabledReason,
      checkBridgeMinVersion
    } = await import('../bridge/bridgeEnabled.js');
    const {
      BRIDGE_LOGIN_ERROR
    } = await import('../bridge/types.js');
    const {
      bridgeMain
    } = await import('../bridge/bridgeMain.js');
    const {
      exitWithError
    } = await import('../utils/process.js');

    // 认证检查必须在 GrowthBook 门控检查之前：
    // 没有有效 accessToken 时，GrowthBook 缺少用户上下文，
    // 返回的 feature flag 值可能是旧缓存或默认 false
    const {
      getClaudeAIOAuthTokens
    } = await import('../utils/auth.js');
    if (!getClaudeAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR);
    }
    // getBridgeDisabledReason 内部会等待 GrowthBook 初始化，返回实时值而非磁盘缓存
    const disabledReason = await getBridgeDisabledReason();
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`);
    }
    // 检查客户端版本是否满足桥接功能的最低版本要求
    const versionError = checkBridgeMinVersion();
    if (versionError) {
      exitWithError(versionError);
    }

    // 检查企业策略是否允许远程控制功能
    const {
      waitForPolicyLimitsToLoad,
      isPolicyAllowed
    } = await import('../services/policyLimits/index.js');
    await waitForPolicyLimitsToLoad();
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.");
    }
    // 所有前置检查通过，启动桥接主逻辑
    await bridgeMain(args.slice(1));
    return;
  }

  // 快速路径：claude daemon [subcommand]
  // 启动长期运行的守护进程（supervisor），负责管理多个 worker 子进程
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      initSinks
    } = await import('../utils/sinks.js');
    // 初始化日志/遥测 sink，守护进程需要比普通 worker 更完整的日志能力
    initSinks();
    const {
      daemonMain
    } = await import('../daemon/main.js');
    await daemonMain(args.slice(1));
    return;
  }

  // 快速路径：claude ps | logs | attach | kill 以及 --bg / --background
  // 针对 ~/.claude/sessions/ 注册表进行后台会话管理操作
  // 标志字面量内联在此处，使得 bg.js 只在真正需要时才被加载
  if (feature('BG_SESSIONS') && (args[0] === 'ps' || args[0] === 'logs' || args[0] === 'attach' || args[0] === 'kill' || args.includes('--bg') || args.includes('--background'))) {
    profileCheckpoint('cli_bg_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const bg = await import('../cli/bg.js');
    // 根据第一个参数分发到对应的会话管理操作
    switch (args[0]) {
      case 'ps':
        // 列出所有后台会话
        await bg.psHandler(args.slice(1));
        break;
      case 'logs':
        // 查看指定会话的日志输出
        await bg.logsHandler(args[1]);
        break;
      case 'attach':
        // 连接到指定的后台会话
        await bg.attachHandler(args[1]);
        break;
      case 'kill':
        // 终止指定的后台会话
        await bg.killHandler(args[1]);
        break;
      default:
        // 处理 --bg / --background 标志，将当前命令转为后台运行
        await bg.handleBgFlag(args);
    }
    return;
  }

  // 快速路径：claude new | list | reply（模板任务命令）
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path');
    const {
      templatesMain
    } = await import('../cli/handlers/templateJobs.js');
    await templatesMain(args);
    // 使用 process.exit 而非 return：
    // mountFleetView 中的 Ink TUI 会残留事件循环句柄，阻止进程自然退出
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0);
  }

  // 快速路径：claude environment-runner（无头 BYOC 运行器）
  // feature() 必须内联以确保死代码消除在外部构建中正确工作
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path');
    const {
      environmentRunnerMain
    } = await import('../environment-runner/main.js');
    await environmentRunnerMain(args.slice(1));
    return;
  }

  // 快速路径：claude self-hosted-runner（自托管运行器）
  // 对接 SelfHostedRunnerWorkerService API（注册 + 轮询，轮询同时充当心跳）
  // feature() 必须内联以确保死代码消除在外部构建中正确工作
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path');
    const {
      selfHostedRunnerMain
    } = await import('../self-hosted-runner/main.js');
    await selfHostedRunnerMain(args.slice(1));
    return;
  }

  // 快速路径：--worktree --tmux 组合
  // 在加载完整 CLI 之前，先将进程 exec 进 tmux worktree 环境
  // hasTmuxFlag 检查两种 tmux 标志变体：--tmux 和 --tmux=classic
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic');
  if (hasTmuxFlag && (args.includes('-w') || args.includes('--worktree') || args.some(a => a.startsWith('--worktree=')))) {
    profileCheckpoint('cli_tmux_worktree_fast_path');
    const {
      enableConfigs
    } = await import('../utils/config.js');
    enableConfigs();
    const {
      isWorktreeModeEnabled
    } = await import('../utils/worktreeModeEnabled.js');
    // 仅在配置中启用了 worktree 模式时才执行 tmux 切换
    if (isWorktreeModeEnabled()) {
      const {
        execIntoTmuxWorktree
      } = await import('../utils/worktree.js');
      const result = await execIntoTmuxWorktree(args);
      if (result.handled) {
        // tmux exec 成功，进程已被替换，此处 return 不会被真正执行
        return;
      }
      // 未处理通常意味着发生错误，回退到普通 CLI 流程
      if (result.error) {
        const {
          exitWithError
        } = await import('../utils/process.js');
        exitWithError(result.error);
      }
    }
  }

  // 将常见的 --update / --upgrade 误操作重定向到正确的 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    // 就地修改 process.argv，让后续的 CLI 解析器看到 'update' 子命令
    process.argv = [process.argv[0]!, process.argv[1]!, 'update'];
  }

  // --bare 标志：在模块求值和 commander 选项构建阶段就设置 SIMPLE 环境变量
  // 若仅在 action handler 内设置，则某些依赖此变量的门控逻辑会错过
  if (args.includes('--bare')) {
    process.env.CLAUDE_CODE_SIMPLE = '1';
  }

  // 所有快速路径均未命中，进入完整 CLI 流程
  // 先开启早期输入捕获，避免在主模块加载期间丢失用户的首次按键
  const {
    startCapturingEarlyInput
  } = await import('../utils/earlyInput.js');
  startCapturingEarlyInput();
  profileCheckpoint('cli_before_main_import');
  // 动态导入完整 CLI 主模块（main.js），该模块包含所有子命令和完整初始化逻辑
  const {
    main: cliMain
  } = await import('../main.js');
  profileCheckpoint('cli_after_main_import');
  await cliMain();
  profileCheckpoint('cli_after_main_complete');
}

// 顶层调用：以 void 修饰避免未处理的 Promise rejection 警告
// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main();
