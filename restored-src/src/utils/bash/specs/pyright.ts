/**
 * pyright 命令的规格（Spec）定义模块。
 *
 * 在 Claude Code 系统中，该文件定义 Python 静态类型检查工具 pyright 的
 * Fig Autocomplete 规格，供 registry.ts 的 getCommandSpec() 在权限前缀解析
 * （shellPrefix.ts）和 Tab 补全（shellCompletion.ts）时优先检索。
 * pyright 不包装子命令，因此无 isCommand 标记；其参数为可选可变参数，
 * 支持直接对指定文件或目录进行类型检查，也可通过配置文件批量分析。
 */
import type { CommandSpec } from '../registry.js'

export default {
  name: 'pyright',
  description: 'Type checker for Python',
  options: [
    { name: ['--help', '-h'], description: 'Show help message' }, // 打印帮助信息并退出
    { name: '--version', description: 'Print pyright version and exit' }, // 打印版本号并退出
    {
      name: ['--watch', '-w'],
      description: 'Continue to run and watch for changes', // 持续监控文件变动并重新检查
    },
    {
      name: ['--project', '-p'],
      description: 'Use the configuration file at this location', // 指定 pyrightconfig.json 所在目录或路径
      args: { name: 'FILE OR DIRECTORY' },
    },
    { name: '-', description: 'Read file or directory list from stdin' }, // 从标准输入读取待检查路径列表
    {
      name: '--createstub',
      description: 'Create type stub file(s) for import', // 为指定的第三方包生成 .pyi 类型桩文件
      args: { name: 'IMPORT' },
    },
    {
      name: ['--typeshedpath', '-t'],
      description: 'Use typeshed type stubs at this location', // 覆盖内置 typeshed，使用自定义路径
      args: { name: 'DIRECTORY' },
    },
    {
      name: '--verifytypes',
      description: 'Verify completeness of types in py.typed package', // 验证 py.typed 包的类型完整性
      args: { name: 'IMPORT' },
    },
    {
      name: '--ignoreexternal',
      description: 'Ignore external imports for --verifytypes', // --verifytypes 模式下忽略外部导入的类型问题
    },
    {
      name: '--pythonpath',
      description: 'Path to the Python interpreter', // 指定用于解析标准库路径的 Python 解释器
      args: { name: 'FILE' },
    },
    {
      name: '--pythonplatform',
      description: 'Analyze for platform', // 指定目标平台（如 Linux/Windows/Darwin）以过滤平台条件代码
      args: { name: 'PLATFORM' },
    },
    {
      name: '--pythonversion',
      description: 'Analyze for Python version', // 指定目标 Python 版本（如 3.11）以过滤版本条件代码
      args: { name: 'VERSION' },
    },
    {
      name: ['--venvpath', '-v'],
      description: 'Directory that contains virtual environments', // 包含虚拟环境的父目录，pyright 将在其中查找 venv
      args: { name: 'DIRECTORY' },
    },
    { name: '--outputjson', description: 'Output results in JSON format' }, // 以 JSON 格式输出诊断结果，便于工具链解析
    { name: '--verbose', description: 'Emit verbose diagnostics' }, // 输出详细诊断信息，包含更多上下文
    { name: '--stats', description: 'Print detailed performance stats' }, // 打印类型检查的性能统计（文件数、耗时等）
    {
      name: '--dependencies',
      description: 'Emit import dependency information', // 输出模块导入依赖关系图
    },
    {
      name: '--level',
      description: 'Minimum diagnostic level', // 设置最低诊断级别，低于该级别的错误将被忽略
      args: { name: 'LEVEL' },
    },
    {
      name: '--skipunannotated',
      description: 'Skip type analysis of unannotated functions', // 跳过未添加类型注解的函数，减少误报
    },
    {
      name: '--warnings',
      description: 'Use exit code of 1 if warnings are reported', // 有警告时以退出码 1 退出，便于 CI 检测
    },
    {
      name: '--threads',
      description: 'Use up to N threads to parallelize type checking', // 设置并行类型检查线程数上限，默认自动
      args: { name: 'N', isOptional: true }, // N 可省略，省略时由 pyright 自行决定线程数
    },
  ],
  args: {
    name: 'files',
    description:
      'Specify files or directories to analyze (overrides config file)', // 指定检查目标，优先级高于配置文件中的 include 设置
    isVariadic: true,  // 支持同时传入多个文件或目录
    isOptional: true,  // 无参数时使用 pyrightconfig.json 中的配置
  },
} satisfies CommandSpec
